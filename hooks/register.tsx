import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Job, JobStatus, Meter, Run } from '../types'

import {
  LEVELS,
  NO_METER,
  canStep,
  effortColor,
  effortOf,
  effortText,
  held,
  isSameMeter,
  modelName,
  seen,
  stepped,
} from './meter'
import { beside, groupTree, labelRow, paneTree } from './pane'
import type { CallRow } from './pane'
import {
  activeOf,
  isLive,
  newsOf,
  stopped,
  swept,
  leavesOf,
  planOf,
  planText,
  planned,
  replanned,
  rowsOf,
  runOf,
  runText,
  statusOf as statusOfSteps,
  stepped as stepTurned,
  taskCreated,
  taskUpdated,
} from './runs'
import { NOTE, NOTE_SECTION, TOOLS, WORDS } from './tools'
import { isRecord, toText } from './values'
import { GLYPHS, jobSpan, labelText, spanText } from './view'
import {
  NO_WORK,
  agentTitle,
  backgrounded,
  cleared,
  dropped,
  ended,
  reported,
  revived,
  settled,
  shellDetail,
  shellTitle,
  started,
  statusOf,
  timed,
  tuned,
} from './work'

const PANE = 'deck'
// The size asked for: beside the conversation 52 cells across, above the
// prompt 14 rows. A size the person dragged it to stands over both.
const PANE_OPEN = { id: PANE, title: 'Deck', columns: 52, rows: 14 } as const
/** The store's one key: `/deck close` for every session. */
const CLOSED = 'closed'
/** The store's other key: the label's row closed with its `×`, for every session. */
const ROW_CLOSED = 'row-closed'
const TICK_MS = 1000
/** The store is read for another session's `/deck close` every this many ticks. */
const FOLLOW_TICKS = 2
const CLOSE_WORDS = ['close', 'exit', 'quit']
const USAGE =
  'Usage: /deck (opens or closes the pane) · /deck open · /deck clear (takes what is over out of the pane) · /deck row (the label as a row, or as text) · /deck close (takes the deck away in every session)'
/** What is over leaves the pane by itself after this long. */
const STALE_MS = 30 * 60 * 1000
const SWEEP_TICKS = 60
/** A background job's end is told only when it ran this long, or failed. */
const TOLD_MS = 30 * 1000
const work = atom({ plugin: 'deck', key: 'work' } as const, NO_WORK)
const meter = atom({ plugin: 'deck', key: 'meter' } as const, NO_METER)
const now = atom({ plugin: 'deck', key: 'now' } as const, 0)
const switches = atom(
  { plugin: 'deck', key: 'switches' } as const,
  { isClosed: false, isRowClosed: false },
)
const NO_RUNS: Run[] = []
const NO_FOLDS: Record<string, boolean> = {}
const runs = atom({ plugin: 'deck', key: 'runs' } as const, NO_RUNS)
const folds = atom({ plugin: 'deck', key: 'folds' } as const, NO_FOLDS)
const NO_SPANS: Record<string, number> = {}
const spans = atom({ plugin: 'deck', key: 'spans' } as const, NO_SPANS)
/** How many shell commands' lengths are kept for the transcript's rows. */
const SPANS_KEPT = 60

type Label = 'button' | 'text' | 'off'

const labelOf = (options: Readonly<Record<string, unknown>>): Label =>
  (['button', 'text', 'off'] as const).find((place) => place === options.hintLabel) ?? 'button'

const isClosed = async ($: EngineInterface): Promise<boolean> =>
  (await read($, switches)).isClosed

const isPaneUp = async ($: EngineInterface): Promise<boolean> =>
  (await $.ui.panes().catch(() => [])).some((pane) => pane.id === PANE)

/**
 * Keeps `/deck close` or its undoing for every session and takes it up here
 * at once. Closed, the pane goes and the effort is Claude Code's own again.
 */
/** The meter with the effort handed back to Claude Code. */
const unheld = (kept: Meter): Meter => held(kept, '')

const closedAs = async ($: EngineInterface, isOff: boolean): Promise<void> => {
  await $.store.set(CLOSED, isOff)
  await update($, switches, (kept) => ({ ...kept, isClosed: isOff }))

  if (isOff) {
    await $.ui.close({ id: PANE }).catch(() => undefined)
    await update($, meter, (kept) => held(kept, ''))
  }
}

/** Takes up a `/deck close` another session made, or its undoing. */
const followed = async ($: EngineInterface): Promise<void> => {
  const isOff = (await $.store.get(CLOSED)) === true
  const isRowOff = (await $.store.get(ROW_CLOSED)) === true
  const before = await read($, switches)

  if (isOff === before.isClosed && isRowOff === before.isRowClosed) {
    return
  }

  await update($, switches, () => ({ isClosed: isOff, isRowClosed: isRowOff }))

  if (isOff && !before.isClosed) {
    await $.ui.close({ id: PANE }).catch(() => undefined)
    await update($, meter, (kept) => unheld(kept))
  }
}

/**
 * The label's row closed or opened again, for every session: closed, the
 * label is text at the end of the hint line.
 */
const rowClosedAs = async ($: EngineInterface, isOff: boolean): Promise<void> => {
  await $.store.set(ROW_CLOSED, isOff)
  await update($, switches, (kept) => ({ ...kept, isRowClosed: isOff }))
}

/** A press on a transcript row: the pane opens with that command's row open. */
const shown = async ($: EngineInterface, id: string): Promise<void> => {
  await update($, folds, (kept) => ({ ...kept, [`job:${id}`]: true }))
  await $.ui.open(PANE_OPEN)
}

/** Opens the pane, or closes the open one. Resolves whether it is open now. */
const toggled = async ($: EngineInterface): Promise<boolean> => {
  if (await isPaneUp($)) {
    await $.ui.close({ id: PANE })

    return false
  }

  await $.ui.open(PANE_OPEN)

  return true
}

/** What Claude Code measured of the session: the context's fill, the cost, the rate limits. */
type Measure = {
  context: { percent?: number }
  cost?: { usd: number }
  rateLimits: readonly { kind: string; percentUsed: number }[]
}

/** Takes up the session's figures as Claude Code reports them. */
const measured = async ($: EngineInterface, usage: Measure): Promise<void> => {
  const before = await read($, meter)
  const after = {
    ...before,
    context: usage.context.percent ?? before.context,
    cost: usage.cost?.usd ?? -1,
    limits: usage.rateLimits.map((limit) => ({ kind: limit.kind, percent: limit.percentUsed })),
  }

  if (!isSameMeter(before, after)) {
    await update($, meter, (kept) => ({
      ...kept,
      context: after.context,
      cost: after.cost,
      limits: after.limits,
    }))
  }
}

/**
 * The main thread's model as `/model` left it, so the label follows a change
 * at once and not with the next request. A model that takes another name
 * starts with its effort unknown: the old one's level is not carried over.
 */
const named = async ($: EngineInterface): Promise<void> => {
  const model = await $.session.model().catch(() => '')
  const before = await read($, meter)

  if (model !== '' && modelName(model) !== modelName(before.model)) {
    await update($, meter, (kept) => ({ ...kept, model, effort: '', isSeen: false, wanted: '', over: '' }))
  }
}

/** `/deck clear` and the pane's button: what is over leaves the pane. */
const sweptAway = async ($: EngineInterface, before?: number): Promise<void> => {
  const jobs = await read($, work)
  const all = await read($, runs)

  if (cleared(jobs, before).recent.length !== jobs.recent.length) {
    await update($, work, (kept) => cleared(kept, before))
  }

  if (swept(all, before).length !== all.length) {
    const left = await update($, runs, (kept) => swept(kept, before))
    // A fold is kept only for a run that is still shown.
    await update($, folds, (kept) =>
      Object.fromEntries(
        Object.entries(kept).filter(
          ([key]) => key.startsWith('job:') || left.some((run) => key.split('/')[0] === run.id),
        ),
      ),
    )
  }
}

/** The name a run a subagent opened carries: the agent's own, else its type. */
const ownerOf = async ($: EngineInterface, agentId: string | undefined): Promise<string> => {
  if (agentId === undefined) {
    return ''
  }

  const agent = (await $.agent.list().catch(() => [])).find((one) => one.id === agentId)

  return agent?.name ?? agent?.type ?? 'agent'
}

/** The runs open first, the newest touched at the top, then the finished. */
const ordered = (all: readonly Run[]): Run[] =>
  [...all].sort(
    (one, other) =>
      Number(!isLive(one)) - Number(!isLive(other)) ||
      other.touchedAt - one.touchedAt,
  )

const STATUS_BY_REASON: Readonly<Record<string, JobStatus>> = {
  answer: 'done',
  aborted: 'killed',
  refusal: 'failed',
  error: 'failed',
}

/**
 * What this session's module holds between events, lost at a reload: the
 * tick's count, a count for calls with no id, and how each background task
 * ended by its notification's own row, which is read while that row is
 * drawn, where nothing may be written, and taken up by the next tick.
 */
type Session = {
  ticks: number
  minted: number
  lengths: Map<string, { status: string; ms: number }>
  hasTool: boolean
  hasToasts: boolean
  hasRows: boolean
}

/** A toast, where the person left them on. */
const told = ($: EngineInterface, session: Session, text: string): void => {
  if (session.hasToasts) {
    $.ui.toast(text)
  }
}

/** Changes the runs, and tells the person of a run that finished or a step that failed. */
const moved = async (
  $: EngineInterface,
  session: Session,
  change: (kept: Run[]) => Run[],
): Promise<void> => {
  const before = await read($, runs)
  const after = await update($, runs, change)

  for (const line of newsOf(before, after)) {
    told($, session, line)
  }
}

/**
 * A press on an opened row's stop button: asks Claude Code to stop that
 * background task, as its own TaskStop tool does, in the person's name.
 */
const halted = async ($: EngineInterface, job: Job): Promise<void> => {
  const answer = await $.tool
    .call({
      tool: 'TaskStop',
      task_id: job.taskId,
      consent: `The user pressed "stop" on "${job.title}" in the Deck pane.`,
    })
    .catch(() => undefined)

  if (answer !== undefined && answer.deny === undefined && answer.isError !== true) {
    const at = await $.clock.now()
    await update($, work, (kept) => reported(kept, { taskId: job.taskId, status: 'killed' }, at))
  }
}

/**
 * Once a second: every other time, another session's `/deck close`; then
 * what the notification rows said; then the clock for the open pane, while
 * something runs.
 */
const ticked = async ($: EngineInterface, session: Session): Promise<void> => {
  session.ticks += 1

  if (session.ticks % FOLLOW_TICKS === 0) {
    await followed($)

    if (!(await isClosed($))) {
      await named($)
    }
  }

  if (session.lengths.size > 0) {
    const at = await $.clock.now()
    const rows = [...session.lengths]
    session.lengths.clear()

    // A background job that ran long, or failed, is told as it ends.
    for (const job of (await read($, work)).running) {
      const row = rows.find(([taskId]) => taskId === job.taskId)
      const status = row === undefined ? undefined : statusOf(row[1].status)
      const isWorth = status !== undefined && (status !== 'done' || at - job.startedAt >= TOLD_MS)

      if (isWorth && job.kind === 'shell') {
        told($, session, `${GLYPHS[status]} ${job.title} · ${jobSpan({ ...job, endedAt: at }, at)}`)
      }
    }

    await update($, work, (kept) =>
      rows.reduce(
        (left, [taskId, row]) =>
          timed(
            reported(left, { taskId, status: statusOf(row.status) }, at),
            taskId,
            row.ms,
          ),
        kept,
      ),
    )
  }

  if (session.ticks % SWEEP_TICKS === 0) {
    await sweptAway($, (await $.clock.now()) - STALE_MS)
  }

  const isBusy =
    (await read($, work)).running.length > 0 || (await read($, runs)).some(isLive)

  if (isBusy && (await isPaneUp($))) {
    const at = await $.clock.now()
    await update($, now, () => at)
  }
}

export const register: Register = (on, options) => {
  const place = labelOf(options)
  const session: Session = {
    ticks: 0,
    minted: 0,
    lengths: new Map(),
    hasTool: options.modelTool === true,
    hasToasts: options.toasts !== false,
    hasRows: options.transcriptRows !== false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'deck',
      description: 'A pane for the work behind the conversation: shells, agents, the model and its effort',
      argumentHint: '[open|clear|row|close]',
    })
    await followed($)

    if (session.hasTool) {
      for (const tool of TOOLS) {
        await $.tool.register(tool)
      }
    }

    const usage = await $.session.usage().catch(() => undefined)

    if (usage !== undefined) {
      await measured($, usage)
    }

    await named($)

    $.clock.every(TICK_MS, () => {
      void ticked($, session).catch(() => undefined)
    })

    return next(e)
  })

  // Claude Code's own measure of the session, as it moves: after each turn of
  // the main thread, and when a rate limit moves a point. Read, and passed on.
  on('session.measure', async ($, e, next) => {
    if (!(await isClosed($))) {
      await measured($, e)
    }

    return next(e)
  })

  // `/clear` ends the conversation the rows belong to: what is over and every
  // run go with it, and what still runs stays.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, work, (kept) => cleared(kept))
      await update($, runs, () => [])
      await update($, folds, () => ({}))
    }

    return next(e)
  })

  on('command.run', { command: 'deck' }, async ($, e) => {
    const [first = '', ...rest] = e.args.trim().toLowerCase().split(/\s+/)

    if (rest.length > 0) {
      return { text: USAGE }
    }

    if (CLOSE_WORDS.includes(first)) {
      await closedAs($, true)

      return {
        text: 'Deck is closed in every session: its label and its pane are away, it reads nothing and it leaves the effort to Claude Code. /deck brings it back.',
      }
    }

    if (first === 'row') {
      const isOff = !(await read($, switches)).isRowClosed
      await rowClosedAs($, isOff)

      return {
        text: isOff
          ? 'Deck keeps its label as text on the hint line. /deck row brings its row back.'
          : 'Deck draws its label on a row under the hint line, where there is a pointer.',
      }
    }

    if (first === 'clear') {
      await sweptAway($)

      return { text: 'Deck is cleared: what is over is out of the pane. What still runs stays.' }
    }

    if (first !== '' && first !== 'open') {
      return { text: USAGE }
    }

    if (await isClosed($)) {
      await closedAs($, false)
      await $.ui.open(PANE_OPEN)

      return { text: 'Deck is back, and its pane is open.' }
    }

    if (first === 'open') {
      await $.ui.open(PANE_OPEN)

      return { text: 'Deck pane opened.' }
    }

    return { text: (await toggled($)) ? 'Deck pane opened.' : 'Deck pane closed.' }
  })

  // A shell command, from its start to its end. Of the call it reads what it
  // says it does (`description`), or the command where it says nothing, and
  // keeps that line in memory for the row; of the result, whether it failed
  // and whether it went to the background. The call goes on as it came.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool !== 'Bash' || (await isClosed($))) {
      return next(e)
    }

    session.minted += 1
    const id = e.tool_use_id ?? `deck-${session.minted}`
    const startedAt = await $.clock.now()
    await update($, work, (kept) =>
      started(kept, {
        id,
        kind: 'shell',
        title: shellTitle(e.description, e.command),
        startedAt,
        endedAt: 0,
        status: 'running',
        taskId: '',
        detail: shellDetail(e.command),
        model: '',
        effort: '',
        owner: e.agentId ?? '',
      }),
    )

    const answer = await next(e).catch(async (failure: unknown) => {
      const at = await $.clock.now()
      await update($, work, (kept) => ended(kept, id, 'failed', at))

      throw failure
    })
    const at = await $.clock.now()
    if (answer.deny !== undefined) {
      await update($, work, (kept) => dropped(kept, id))
    } else if (answer.isError === true) {
      await update($, work, (kept) => ended(kept, id, 'failed', at))
    } else if (answer.result.backgroundTaskId !== undefined) {
      const taskId = answer.result.backgroundTaskId
      await update($, work, (kept) => backgrounded(kept, id, taskId))
    } else {
      const status = answer.result.interrupted ? 'killed' : 'done'
      await update($, work, (kept) => ended(kept, id, status, at))
    }

    if (session.hasRows) {
      await update($, spans, (kept) =>
        Object.fromEntries([...Object.entries(kept), [id, at - startedAt]].slice(-SPANS_KEPT)),
      )
    }

    return answer
  })

  // A background task stopped by Claude or the person: only the id of the
  // task that was stopped is read.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const answer = await next(e)

    if (
      e.tool === 'TaskStop' &&
      answer.deny === undefined &&
      answer.isError !== true &&
      !(await isClosed($))
    ) {
      const taskId = toText(answer.result.task_id)
      const at = await $.clock.now()
      await update($, work, (kept) => reported(kept, { taskId, status: 'killed' }, at))
    }

    return answer
  })

  // Claude Code's own task list, watched: a task's id and subject as it is
  // made, and its new state as it changes. Both calls go on as they came.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const answer = await next(e)

    if (
      e.tool === 'TaskCreate' &&
      answer.deny === undefined &&
      answer.isError !== true &&
      !(await isClosed($))
    ) {
      const { id, subject } = answer.result.task
      const loop = e.agentId ?? ''
      const owner = await ownerOf($, e.agentId)
      const at = await $.clock.now()
      await moved($, session, (kept) =>
        taskCreated(kept, loop, owner, id, subject, at, () => `tasks-${at}`),
      )
    }

    return answer
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const answer = await next(e)

    if (
      e.tool === 'TaskUpdate' &&
      answer.deny === undefined &&
      answer.isError !== true &&
      answer.result.success &&
      !(await isClosed($))
    ) {
      const loop = e.agentId ?? ''
      const change = { status: e.status, subject: e.subject }
      const at = await $.clock.now()
      await moved($, session, (kept) => taskUpdated(kept, loop, e.taskId, change, at))
    }

    return answer
  })

  // The mod's own two tools, listed only with Tool for Claude on: a plan as
  // indented text opens a run, and a step changes one leaf of it.
  if (session.hasTool) {
    on('tool.call', { tool: 'mcp__deck__plan' }, async ($, e) => {
      if (await isClosed($)) {
        return { result: 'The person closed the deck: no plan is shown. Go on without it.' }
      }

      const steps = planned(toText(e.steps))

      if (steps.length === 0) {
        return { deny: 'The plan has no steps. Give one step a line.' }
      }

      const at = await $.clock.now()
      const taken = (await read($, runs)).map((one) => one.id)
      const free = Array.from({ length: taken.length + 1 }, (_, index) => `r${index + 1}`)
      const made = runOf(
        free.find((id) => !taken.includes(id)) ?? `r${at}`,
        toText(e.title),
        'plan',
        e.agentId ?? '',
        await ownerOf($, e.agentId),
        steps,
        at,
      )
      // The first step starts with the plan, which saves the agent a call.
      const first = leavesOf(made)[0]?.id ?? ''
      const run = stepTurned(made, first, 'start', at).run ?? made
      await update($, runs, (kept) => replanned(kept, run))

      return {
        result: `Run ${run.id} is shown, and step ${first} is started. Call step as you move to the next one.\n${planText(run)}`,
      }
    })

    on('tool.call', { tool: 'mcp__deck__step' }, async ($, e) => {
      if (await isClosed($)) {
        return { result: 'The person closed the deck: no plan is shown. Go on without it.' }
      }

      const word = WORDS.find((one) => one === toText(e.state).trim().toLowerCase())
      const run = planOf(await read($, runs), e.agentId ?? '', toText(e.run).trim())

      if (word === undefined) {
        return { deny: `The state is one of: ${WORDS.join(', ')}.` }
      }

      if (run === undefined) {
        return { deny: 'No plan is open. Call plan first.' }
      }

      const id = toText(e.id).trim()
      const at = await $.clock.now()
      const turned = stepTurned(run, id, word, at)

      if (turned.error !== undefined) {
        return { deny: turned.error }
      }

      await moved($, session, (kept) =>
        kept.map((one) => {
          const again = one.id === run.id ? stepTurned(one, id, word, at) : undefined

          return again?.run ?? one
        }),
      )

      const leaves = leavesOf(turned.run)

      return {
        result: `${id} ${word} (${leaves.filter((leaf) => leaf.status === 'done').length}/${leaves.length} done)`,
      }
    })
  }

  // With Tool for Claude on, the main thread's system prompt gains one
  // section saying the tools are there; every other section stays as it is.
  if (session.hasTool) {
    on('prompt.compose', async ($, e, next) => {
      const answer = await next(e)

      return (await isClosed($))
        ? answer
        : {
            sections: [
              ...answer.sections.filter((section) => section.id !== NOTE_SECTION),
              { id: NOTE_SECTION, text: NOTE, scope: 'session' as const },
            ],
          }
    })
  }

  // A subagent as it starts: its type and the few words its call names the
  // task with. Its task goes on as it came, but for the line below.
  on('agent.spawn', async ($, e, next) => {
    // With Tool for Claude on, one line at the end of the subagent's task says
    // the tools are there. A fork has the main thread's prompt, which says so.
    const isTold = session.hasTool && !e.fork && !(await isClosed($))
    const answer = await next(isTold ? { ...e, prompt: `${e.prompt}\n\n${NOTE}` } : e)

    if (answer.agentId !== undefined && !(await isClosed($))) {
      const id = answer.agentId
      const startedAt = await $.clock.now()
      await update($, work, (kept) =>
        started(kept, {
          id,
          kind: 'agent',
          title: agentTitle(e.subagentType, e.description),
          startedAt,
          endedAt: 0,
          status: 'running',
          taskId: id,
          detail: '',
          model: answer.model ?? '',
          effort: '',
          owner: e.parentAgentId ?? '',
        }),
      )
    }

    return answer
  })

  on('turn.complete', async ($, e, next) => {
    if (!(await isClosed($))) {
        if (e.agentId !== undefined) {
        const id = e.agentId
        const at = await $.clock.now()
        const status = STATUS_BY_REASON[e.reason] ?? 'ended'
        const job = (await read($, work)).running.find((one) => one.id === id)
        await update($, work, (kept) => ended(kept, id, status, at))

        if (job !== undefined && (status !== 'done' || at - job.startedAt >= TOLD_MS)) {
          told($, session, `${GLYPHS[status]} ${job.title} · ${jobSpan({ ...job, endedAt: at }, at)}`)
        }

        if ((await read($, runs)).some((run) => run.loop === id && isLive(run))) {
          await moved($, session, (kept) => stopped(kept, id, at, e.reason === 'answer'))
        }
      }
    }

    return next(e)
  })

  // What still runs in the background when Claude stops, by id: a shell the
  // deck lists that Claude Code no longer does has ended unseen.
  on('classic.Stop', async ($, e, next) => {
    if (e.background_tasks !== undefined && !(await isClosed($))) {
      const alive = e.background_tasks.map((task) => task.id)
      const at = await $.clock.now()
      await update($, work, (kept) => settled(kept, alive, at))
    }

    return next(e)
  })

  // The row Claude Code draws when a background task ends names the task,
  // how it ended and how long it ran. Those three are read, never the row's
  // text, and the row is drawn as it came.
  on(
    'ui.render',
    { component: 'UserMessage', props: { origin: { kind: 'task-notification' } } },
    async ($, e, next) => {
      const task = e.props.task

      if (task?.id !== undefined && !(await isClosed($))) {
        session.lengths.set(task.id, { status: task.status ?? '', ms: task.durationMs ?? -1 })
      }

      return next(e)
    },
  )

  // Each request of the main thread: its model and effort are read for the
  // meter, and after a click on the meter the effort is sent as the click
  // left it, until `/effort` changes Claude Code's own. A subagent's request
  // is never changed.
  on('turn.step', async function* ($, e, next) {
    if (await isClosed($)) {
      return yield* next(e)
    }

    if (e.agentId !== undefined) {
      const id = e.agentId
      const jobs = await read($, work)
      const effort = e.effort === undefined ? '' : String(e.effort)

      if (jobs.recent.some((job) => job.id === id)) {
        await update($, work, (kept) => revived(kept, id))
      }

      if (jobs.running.some((job) => job.id === id && (job.effort !== effort || job.model !== e.model))) {
        await update($, work, (kept) => tuned(kept, id, { model: e.model, effort }))
      }

      return yield* next(e)
    }

    const before = await read($, meter)
    const after = seen(before, e.model, e.effort === undefined ? '' : String(e.effort))

    if (!isSameMeter(before, after)) {
      await update($, meter, (kept) => seen(kept, e.model, after.effort))
    }

    const level = LEVELS.find((one) => one === after.wanted)
    return yield* next(
      level === undefined || e.effort === undefined ? e : { ...e, effort: level as typeof e.effort },
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, now)
    const at = await $.clock.now()
    const all = await read($, runs)
    const shut = await read($, folds)
    const active = activeOf(all)
    const jobs = await read($, work)
    // A run a running agent opened is drawn under that agent's row.
    const isNested = (run: Run): boolean =>
      isLive(run) && jobs.running.some((job) => job.kind === 'agent' && job.id === run.loop)

    return paneTree($.ui.resolve(e), {
      meter: await read($, meter),
      work: jobs,
      now: at,
      columns: e.props.bodyColumns,
      onEffort: () => {
        void update($, meter, stepped)
      },
      runs: ordered(all)
        .filter((run) => !isNested(run))
        .map((run) => rowsOf(run, shut, at, run.id === active?.id)),
      nested: Object.fromEntries(
        jobs.running.map((job) => [
          job.id,
          all
            .filter((run) => isNested(run) && run.loop === job.id)
            // Under its agent's row a run needs no owner's name.
            .map((run) => rowsOf({ ...run, owner: '' }, shut, at, true)),
        ]),
      ),
      open: shut,
      onJob: (job) => {
        void update($, folds, (kept) => ({ ...kept, [`job:${job.id}`]: kept[`job:${job.id}`] !== true }))
      },
      onStop: (job) => {
        void halted($, job)
      },
      onClear: () => {
        void sweptAway($)
      },
      onFold: (row) => {
        void update($, folds, (kept) => ({ ...kept, [row.key]: !(kept[row.key] ?? row.isOpen) }))
      },
    })
  })

  // The transcript's row for a group of tool calls (`Ran 3 shell commands`)
  // gains a row under it for each shell command of the group. Of the group's
  // calls only the shell commands are read: each one's id, its state, and
  // what it says it does, as the deck's own row reads it. The group's own
  // line is drawn as it came, and an expanded group is left alone.
  if (session.hasRows) {
    on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
      const calls = e.props.calls.filter((call) => call.tool === 'Bash' && call.tool_use_id !== undefined)

      if (calls.length === 0 || e.props.isExpanded || (await isClosed($))) {
        return next(e)
      }

      const jobs = await read($, work)
      const lengths = await read($, spans)
      const hasLive = calls.some((call) => jobs.running.some((job) => job.id === call.tool_use_id))
      // A command still running draws again with the clock.
      const at = hasLive ? Math.max(await read($, now), await $.clock.now()) : 0
      const rows = calls.map((call): CallRow => {
        const id = call.tool_use_id ?? ''
        const input = isRecord(call.input) ? call.input : {}
        const job = jobs.running.find((one) => one.id === id) ?? jobs.recent.find((one) => one.id === id)
        const ms = job === undefined ? (lengths[id] ?? 0) : (job.endedAt || at) - job.startedAt
        const status =
          job?.status ??
          (call.isRunning ? 'running' : call.isErrored ? 'failed' : call.isInterrupted ? 'killed' : 'done')

        return {
          id,
          status,
          title: job?.title ?? shellTitle(toText(input.description), toText(input.command)),
          span: ms >= 1000 ? spanText(ms) : '',
        }
      })

      return groupTree($.ui.resolve(e), await next(e), rows, (row) => {
        void shown($, row.id)
      })
    })
  }

  // The label on the hint line under the prompt. Where there is a pointer to
  // press with (the terminal's fullscreen layout, the desktop app) it is a
  // button on a row of its own right under the line, and a press opens or
  // closes the pane; elsewhere it is text at the line's end. The line itself
  // and what other mods drew with it stay as they are.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (place === 'off' || (await isClosed($))) {
      return next(e)
    }

    const active = activeOf(await read($, runs))
    const text = labelText(
      await read($, meter),
      await read($, work),
      active === undefined ? [] : [runText(active)],
    )
    const hasPointer = e.surface !== 'terminal' || e.viewport?.isFullscreen === true

    if (place === 'text' || !hasPointer || (await read($, switches)).isRowClosed) {
      const before = e.props.tail ?? ''

      return e.surface === 'terminal'
        ? next({ ...e, props: { ...e.props, tail: before === '' ? text : `${before} · ${text}` } })
        : next(e)
    }

    const gauge = await read($, meter)

    return beside(
      await next(e),
      labelRow($.ui.resolve(e), {
        head: modelName(gauge.model),
        bar: effortText(gauge).split(' ')[0] ?? '',
        level: effortOf(gauge),
        effortColor: effortColor(gauge),
        canStep: canStep(gauge),
        onEffort: () => {
          void update($, meter, stepped)
        },
        running: (await read($, work)).running.length,
        run: active === undefined ? '' : runText(active),
        isFailed: active !== undefined && statusOfSteps(leavesOf(active)) === 'failed',
        onPress: () => {
          void toggled($)
        },
        onClose: () => {
          void rowClosedAs($, true)
        },
      }),
    )
  })
}
