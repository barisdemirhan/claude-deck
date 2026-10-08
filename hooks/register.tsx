import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Job, JobStatus, Meter, Run, Watch } from '../types'

import {
  GITHUB,
  MAX_WATCHES,
  POLL_ANON_MS,
  POLL_MS,
  checksOf,
  givenUp,
  homeOf,
  isSame,
  pathsOf,
  polled,
  pullPath,
  pullTitle,
  startText,
  summaryOf,
  targetOf,
  watched,
} from './checks'
import type { Found } from './checks'
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
import { beside, besideCells, fittedLabel, groupTree, labelRow, paneTree } from './pane'
import type { CallRow, LabelView } from './pane'
import {
  RUN_TITLE_CELLS,
  activeOf,
  isLive,
  keptFolds,
  newsOf,
  opened,
  stopped,
  stoppedAll,
  swept,
  leavesOf,
  planOf,
  planText,
  planned,
  replanned,
  rowsOf,
  runCount,
  runOf,
  runText,
  statusOf as statusOfSteps,
  stepped as stepTurned,
  taskCreated,
  taskUpdated,
} from './runs'
import { NOTE, NOTE_SECTION, TOOLS, WATCH_NOTE, WATCH_SECTION, WATCH_TOOL, WORDS } from './tools'
import { isRecord, toText } from './values'
import { GLYPHS, jobSpan, labelText, spanText } from './view'
import {
  NO_WORK,
  agentTitle,
  asked as askedAbout,
  backgrounded,
  begun,
  cleared,
  dropped,
  ended,
  endedAll,
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
  'Usage: /deck (opens or closes the pane) · /deck open · /deck clear (takes what is over out of the pane) · /deck row (the label as a row, or as text) · /deck watch [a pull request, a workflow run, a branch or a commit] (follows its GitHub checks) · /deck unwatch · /deck close (takes the deck away in every session)'
const CHECKS_OFF =
  'GitHub checks are off. Turn on "GitHub checks" in /config, under the plugin\'s name, to follow them in the deck.'
/** How long one question to GitHub may take. */
const ASK_MS = 20 * 1000
/** `gh` ends with this where nobody is signed in to the host. */
const GH_NO_AUTH = 4
const ERROR_CHARS = 160
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
const NO_WATCHES: Watch[] = []
const watches = atom({ plugin: 'deck', key: 'watches' } as const, NO_WATCHES)
const NO_SPANS: Record<string, number> = {}
const spans = atom({ plugin: 'deck', key: 'spans' } as const, NO_SPANS)
const docked = atom({ plugin: 'deck', key: 'docked' } as const, 0)
/** A docked pane's frame around its body, and the cell between it and the conversation. */
const DOCK_FRAME_CELLS = 3
/** A shell Claude Code draws its ctrl+b hint under has run this long. */
const HINT_MS = 2000
/** How many shell commands' lengths are kept for the transcript's rows. */
const SPANS_KEPT = 60

type Label = 'button' | 'text' | 'off'

const labelOf = (options: Readonly<Record<string, unknown>>): Label =>
  (['button', 'text', 'off'] as const).find((place) => place === options.hintLabel) ?? 'button'

const isClosed = async ($: EngineInterface): Promise<boolean> =>
  (await read($, switches)).isClosed

/** True while the pane is drawn. One that waits undrawn, opened where it had no room, is not up. */
const isPaneUp = async ($: EngineInterface): Promise<boolean> =>
  (await $.ui.panes().catch(() => [])).some((pane) => pane.id === PANE && pane.isPlaced)

const PANE_OPENED = 'Deck pane opened.'
const PANE_CLOSED = 'Deck pane closed.'

/**
 * Opens the pane. Resolves what to tell the person: that it is open, or why
 * Claude Code keeps it waiting undrawn.
 */
const paneOpened = async ($: EngineInterface): Promise<string> => {
  const answer = await $.ui.open(PANE_OPEN)

  return answer.isPlaced ? PANE_OPENED : `Deck's pane waits: ${answer.reason}`
}

/** The meter with the effort handed back to Claude Code. */
const unheld = (kept: Meter): Meter => held(kept, '')

/**
 * What closing takes away in this session, whichever session closed it: the
 * pane, the effort the deck set and what it follows on GitHub. What runs
 * ends where it stands: the deck reads nothing while it is closed, so a job
 * or a run left running would run on in the pane when it came back.
 */
const shutDown = async ($: EngineInterface): Promise<void> => {
  await $.ui.close({ id: PANE }).catch(() => undefined)
  await update($, meter, unheld)
  await update($, watches, () => [])
  const at = await $.clock.now()
  await update($, work, (kept) => endedAll(kept, at))
  await update($, runs, (kept) => stoppedAll(kept, at))
}

/**
 * Keeps `/deck close` or its undoing for every session and takes it up here
 * at once.
 */
const closedAs = async ($: EngineInterface, isOff: boolean): Promise<void> => {
  await switched($, CLOSED, isOff)
  await update($, switches, (kept) => ({ ...kept, isClosed: isOff }))

  if (isOff) {
    await shutDown($)
  }
}

/**
 * Whether a switch of every session's is on. Read every two seconds in every
 * session, so the store is listed first and a key read only where it is set:
 * one read of the store's file where there were two. A key an older version
 * left `false` is taken away on the way.
 */
const isSet = async ($: EngineInterface, keys: readonly string[], key: string): Promise<boolean> => {
  if (!keys.includes(key)) {
    return false
  }

  const isOn = (await $.store.get(key)) === true

  if (!isOn) {
    await $.store.delete(key).catch(() => undefined)
  }

  return isOn
}

/** Sets a switch of every session's: kept while on, taken away when off. */
const switched = async ($: EngineInterface, key: string, isOn: boolean): Promise<void> => {
  await (isOn ? $.store.set(key, true) : $.store.delete(key))
}

/** Takes up a `/deck close` another session made, or its undoing. */
const followed = async ($: EngineInterface): Promise<void> => {
  const keys = await $.store.keys()
  const isOff = await isSet($, keys, CLOSED)
  const isRowOff = await isSet($, keys, ROW_CLOSED)
  const before = await read($, switches)

  if (isOff === before.isClosed && isRowOff === before.isRowClosed) {
    return
  }

  await update($, switches, () => ({ isClosed: isOff, isRowClosed: isRowOff }))

  if (isOff && !before.isClosed) {
    await shutDown($)
  }
}

/**
 * The label's row closed or opened again, for every session: closed, the
 * label is text at the end of the hint line.
 */
const rowClosedAs = async ($: EngineInterface, isOff: boolean): Promise<void> => {
  await switched($, ROW_CLOSED, isOff)
  await update($, switches, (kept) => ({ ...kept, isRowClosed: isOff }))
}

/** Opens the pane, or closes the open one. Resolves what to tell the person. */
const toggled = async ($: EngineInterface): Promise<string> => {
  if (await isPaneUp($)) {
    await $.ui.close({ id: PANE })

    return PANE_CLOSED
  }

  return paneOpened($)
}

/**
 * A press that opens or closes the pane says nothing but where the pane
 * waits, so a press that drew nothing is not silent.
 *
 * A Button hands the promise back to the press: Claude Code draws a pane at
 * any width only while the person's press is answered, and counts the
 * press as answered until its handler's promise settles. A press that
 * returned at once and opened the pane after an await (`toggled` asks
 * whether it is up first) made an open of the deck's own, which waits
 * undrawn below 144 columns.
 */
const pressed = async ($: EngineInterface, said: Promise<string>): Promise<void> => {
  const text = await said

  if (text !== PANE_OPENED && text !== PANE_CLOSED) {
    $.ui.toast(text)
  }
}

/** A press on a transcript row: the pane opens with that command's row open. */
const shown = async ($: EngineInterface, id: string): Promise<void> => {
  const opening = pressed($, paneOpened($))
  await update($, folds, (kept) => ({ ...kept, [`job:${id}`]: true }))
  await opening
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

/** The folds of what is no longer shown go, so a run that takes a freed id starts with none. */
const foldsPruned = async ($: EngineInterface): Promise<void> => {
  const shown = await read($, runs)
  const jobs = await read($, work)
  const ids = [...jobs.running, ...jobs.recent].map((job) => job.id)
  const before = await read($, folds)

  if (Object.keys(keptFolds(before, shown, ids)).length !== Object.keys(before).length) {
    await update($, folds, (kept) => keptFolds(kept, shown, ids))
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
    await update($, runs, (kept) => swept(kept, before))
  }

  await foldsPruned($)
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
  /** When Claude Code drew its ctrl+b hint under a shell, by its call's id: that shell runs. */
  hints: Map<string, number>
  /** The cells the pane took from the screen as it was last drawn docked; 0 drawn inline. */
  dockCells: number
  hasTool: boolean
  hasToasts: boolean
  hasRows: boolean
  hasChecks: boolean
  /** How GitHub is asked: by `gh`, or directly where the first try found no `gh` signed in. */
  via: 'untried' | 'gh' | 'http'
  /** True where GitHub is asked directly with no token, and answers few requests an hour. */
  isAnon: boolean
  /** When the watches were last polled, and whether a poll is under way. */
  polledAt: number
  isPolling: boolean
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

/** The first free id for a new run: `r1`, `r2`. */
const freeId = (all: readonly Run[], at: number): string => {
  const taken = all.map((one) => one.id)
  const free = Array.from({ length: taken.length + 1 }, (_, index) => `r${index + 1}`)

  return free.find((id) => !taken.includes(id)) ?? `r${at}`
}

/** What GitHub answered to one path of its API, or why there is no answer. */
type Answer = { data: unknown; error?: undefined } | { error: string; data?: undefined }

const parsed = (text: string): Answer => {
  try {
    return { data: JSON.parse(text) as unknown }
  } catch {
    return { error: 'GitHub answered something that is not JSON.' }
  }
}

const errorOf = (text: string): string =>
  (text.trim().split('\n').find((line) => line.trim() !== '') ?? '').slice(0, ERROR_CHARS)

/**
 * Asks GitHub's API for one path, read only. By `gh api` where the machine
 * has `gh` signed in, so the mod holds no token. Else directly, and only
 * `github.com`: with the token `GH_TOKEN` or `GITHUB_TOKEN` names where one
 * is set, with none for a public repository.
 */
const asked = async ($: EngineInterface, session: Session, host: string, path: string): Promise<Answer> => {
  if (session.via !== 'http') {
    const ran = await $.process
      .run(['gh', 'api', '--hostname', host, path], { timeoutMs: ASK_MS })
      .catch(() => undefined)
    const isMissing = ran === undefined || ran.exitCode === GH_NO_AUTH

    if (ran !== undefined && ran.exitCode === 0) {
      session.via = 'gh'

      return parsed(ran.stdout)
    }

    if (!isMissing || session.via === 'gh') {
      return { error: errorOf(ran?.stderr ?? '') || 'gh did not answer.' }
    }

    session.via = 'http'
  }

  if (host !== GITHUB) {
    return { error: `Checks on ${host} need the gh command, signed in to it.` }
  }

  const token = (await $.env.get('GH_TOKEN')) ?? (await $.env.get('GITHUB_TOKEN')) ?? ''
  session.isAnon = token === ''
  const answer = await $.http
    .fetch(`https://api.github.com/${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
      },
    })
    .catch(() => undefined)

  if (answer === undefined) {
    return { error: 'GitHub could not be reached.' }
  }

  if (!answer.ok) {
    return {
      error: `GitHub answered ${answer.status}.${token === '' ? ' With no gh signed in and no GH_TOKEN, only a public repository answers.' : ''}`,
    }
  }

  return parsed(answer.text)
}

/** One poll of what a watch follows: its checks, or why GitHub gave none. */
const looked = async (
  $: EngineInterface,
  session: Session,
  watch: Pick<Watch, 'kind' | 'host' | 'repo' | 'target'>,
): Promise<Found | { error: string }> => {
  const [first, second] = pathsOf(watch)
  const one = await asked($, session, watch.host, first)

  if (one.error !== undefined) {
    return { error: one.error }
  }

  const other = await asked($, session, watch.host, second)

  return other.error === undefined ? checksOf(watch.kind, one.data, other.data) : { error: other.error }
}

/**
 * Starts following what the words name, for `/deck watch` and the watch
 * tool: asks GitHub once, shows the answer as a run, and keeps asking while
 * a check is left. Resolves what to answer, and whether nothing was shown.
 */
const watching = async (
  $: EngineInterface,
  session: Session,
  words: string,
  wake: boolean,
): Promise<{ text: string; isRefused: boolean }> => {
  const home = homeOf((await $.session.repo().catch(() => null))?.remote)
  // With no words, the branch the session is on.
  const branch =
    words.trim() === ''
      ? ((await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => undefined))?.stdout ?? '')
      : ''
  const target = targetOf(words, home, branch)

  if ('error' in target) {
    return { text: target.error, isRefused: true }
  }

  const all = await read($, watches)
  const twin = all.find((one) => isSame(one, target))

  if (twin !== undefined) {
    await update($, watches, (kept) =>
      kept.map((one) => (one.run === twin.run ? { ...one, wake: one.wake || wake } : one)),
    )

    return {
      text: `It is shown in the Deck already.${wake ? ' A message will tell you when its checks are over.' : ''}`,
      isRefused: false,
    }
  }

  if (all.length >= MAX_WATCHES) {
    return { text: `The Deck follows ${MAX_WATCHES} at a time, and it does now.`, isRefused: true }
  }

  const found = await looked($, session, target)

  if ('error' in found) {
    return { text: `Nothing is shown: ${found.error}`, isRefused: true }
  }

  const pull = target.pull > 0 ? await asked($, session, target.host, pullPath(target)) : undefined
  const at = await $.clock.now()
  await foldsPruned($)
  const id = freeId(await read($, runs), at)
  const title = pull?.data === undefined ? target.title : pullTitle(target, pull.data)
  const run = watched(runOf(id, title, 'checks', `watch:${id}`, '', [], at), found, at)
  const next = polled(
    { run: id, kind: target.kind, host: target.host, repo: target.repo, target: target.target, url: target.url, wake, startedAt: at, settled: 0, failures: 0 },
    found,
  )
  await update($, runs, (kept) => opened(kept, run))

  if (next === undefined) {
    return { text: summaryOf(run, target.url), isRefused: false }
  }

  session.polledAt = at
  await update($, watches, (kept) => [...kept, next])

  return { text: startText(run, target.url, wake), isRefused: false }
}

/** Every watch ends here: its run stops where it stands. */
const unwatched = async ($: EngineInterface): Promise<number> => {
  const all = await read($, watches)
  const at = await $.clock.now()
  await update($, watches, () => [])
  await update($, runs, (kept) =>
    kept.map((run) =>
      all.some((watch) => watch.run === run.id) && isLive(run) ? { ...run, stoppedAt: at, touchedAt: at } : run,
    ),
  )

  return all.length
}

/**
 * One poll of every watch. A watch whose row was cleared away ends; one
 * whose checks are over ends, and tells Claude where Claude asked; one that
 * cannot go on is given up, its run stopped where it stands.
 */
const polledAll = async ($: EngineInterface, session: Session): Promise<void> => {
  for (const watch of await read($, watches)) {
    const run = (await read($, runs)).find((one) => one.id === watch.run)
    const found = run === undefined ? undefined : await looked($, session, watch)
    const at = await $.clock.now()

    if (run === undefined || found === undefined) {
      await update($, watches, (kept) => kept.filter((one) => one.run !== watch.run))
      continue
    }

    const isAnswered = !('error' in found)
    const current = isAnswered ? watched(run, found, at) : run
    const next = isAnswered ? polled(watch, found) : { ...watch, failures: watch.failures + 1 }
    const why = next === undefined ? undefined : givenUp(next, current, at)

    if (isAnswered) {
      await moved($, session, (kept) => kept.map((one) => (one.id === watch.run ? watched(one, found, at) : one)))
    }

    if (next !== undefined && why === undefined) {
      await update($, watches, (kept) => kept.map((one) => (one.run === watch.run ? { ...next, wake: one.wake } : one)))
      continue
    }

    const wake = (await read($, watches)).find((one) => one.run === watch.run)?.wake ?? watch.wake
    await update($, watches, (kept) => kept.filter((one) => one.run !== watch.run))

    if (why !== undefined) {
      await update($, runs, (kept) =>
        kept.map((one) => (one.id === watch.run && isLive(one) ? { ...one, stoppedAt: at, touchedAt: at } : one)),
      )
      told($, session, `${GLYPHS.killed} ${current.title}: ${why}`)
    }

    // A deck closed meanwhile wakes nobody.
    if (wake && !(await isClosed($))) {
      await $.prompt.submit({ text: summaryOf(current, watch.url, why) }).catch(() => undefined)
    }
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

  // A shell Claude Code drew its ctrl+b hint under runs: one the person was
  // asked about started its clock that long before.
  if (session.hints.size > 0) {
    const hints = [...session.hints]
    session.hints.clear()
    await update($, work, (kept) => hints.reduce((left, [id, at]) => begun(left, id, at - HINT_MS), kept))
  }

  const jobs = await read($, work)
  const isBusy = jobs.running.length > 0 || (await read($, runs)).some(isLive)
  const isUp = await isPaneUp($)

  // The clock moves the open pane's times, and the transcript's rows of a
  // shell that runs, which show while the pane is closed.
  if ((isBusy && isUp) || (session.hasRows && jobs.running.some((job) => job.kind === 'shell'))) {
    const at = await $.clock.now()
    await update($, now, () => at)
  }

  // What the docked pane takes from the screen: the label and the transcript's
  // rows fit what is left.
  const cells = isUp ? session.dockCells : 0

  if (cells !== (await read($, docked))) {
    await update($, docked, () => cells)
  }

  // Last, so a slow answer of GitHub holds nothing above: what is watched is
  // polled, one poll at a time, and nothing while the deck is closed.
  if (
    session.hasChecks &&
    !session.isPolling &&
    (await read($, watches)).length > 0 &&
    !(await isClosed($))
  ) {
    const at = await $.clock.now()

    if (at - session.polledAt >= (session.isAnon ? POLL_ANON_MS : POLL_MS)) {
      session.polledAt = at
      session.isPolling = true
      await polledAll($, session).finally(() => {
        session.isPolling = false
      })
    }
  }
}

export const register: Register = (on, options) => {
  const place = labelOf(options)
  const session: Session = {
    ticks: 0,
    minted: 0,
    lengths: new Map(),
    hints: new Map(),
    dockCells: 0,
    hasTool: options.modelTool === true,
    hasToasts: options.toasts !== false,
    hasRows: options.transcriptRows !== false,
    hasChecks: options.github === true,
    via: 'untried',
    isAnon: false,
    polledAt: 0,
    isPolling: false,
  }
  // What tells an agent of the mod's tools, by the settings that are on.
  const notes = [
    ...(session.hasTool ? [{ id: NOTE_SECTION, text: NOTE }] : []),
    ...(session.hasChecks ? [{ id: WATCH_SECTION, text: WATCH_NOTE }] : []),
  ]

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'deck',
      description: 'A pane for the work behind the conversation: shells, agents, the model and its effort',
      argumentHint: '[open|clear|row|watch|unwatch|close]',
    })
    await followed($)

    if (session.hasTool) {
      for (const tool of TOOLS) {
        await $.tool.register(tool)
      }
    }

    if (session.hasChecks) {
      await $.tool.register(WATCH_TOOL)
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
      await update($, watches, () => [])
    }

    return next(e)
  })

  on('command.run', { command: 'deck' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    const first = word.toLowerCase()

    // `/deck watch`, with what to follow or with nothing for the branch the
    // session is on. Its answer names what is shown.
    if (first === 'watch' && rest.length <= 1) {
      if (!session.hasChecks) {
        return { text: CHECKS_OFF }
      }

      if (await isClosed($)) {
        return { text: 'Deck is closed. /deck brings it back.' }
      }

      const answer = await watching($, session, rest[0] ?? '', false)

      if (answer.isRefused) {
        return { text: answer.text }
      }

      const opened = await paneOpened($)

      return { text: opened === PANE_OPENED ? answer.text : `${answer.text} ${opened}` }
    }

    if (rest.length > 0) {
      return { text: USAGE }
    }

    if (first === 'unwatch') {
      const count = session.hasChecks ? await unwatched($) : 0

      return {
        text: count === 0 ? 'Deck follows nothing on GitHub.' : 'Deck stopped following GitHub: the runs stay where they stood.',
      }
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
      const opened = await paneOpened($)

      return { text: opened === PANE_OPENED ? 'Deck is back, and its pane is open.' : `Deck is back. ${opened}` }
    }

    return { text: first === 'open' ? await paneOpened($) : await toggled($) }
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
        isAsking: false,
      }),
    )

    const answer = await next(e).catch(async (failure: unknown) => {
      const at = await $.clock.now()
      await update($, work, (kept) => ended(kept, id, 'failed', at))

      throw failure
    })
    const at = await $.clock.now()
    // The clock starts once the person let it run, where they were asked.
    const job = (await read($, work)).running.find((one) => one.id === id)
    const from = job === undefined ? startedAt : job.isAsking ? at : job.startedAt

    if (answer.deny !== undefined) {
      await update($, work, (kept) => dropped(kept, id))
    } else if (answer.isError === true) {
      await update($, work, (kept) => ended(kept, id, 'failed', at))
    } else if (answer.result.backgroundTaskId !== undefined) {
      const taskId = answer.result.backgroundTaskId
      await update($, work, (kept) => backgrounded(kept, id, taskId, at))
    } else {
      const status = answer.result.interrupted ? 'killed' : 'done'
      await update($, work, (kept) => ended(kept, id, status, at))
    }

    if (session.hasRows) {
      await update($, spans, (kept) =>
        Object.fromEntries([...Object.entries(kept), [id, at - from]].slice(-SPANS_KEPT)),
      )
    }

    return answer
  })

  // Claude Code asks the person whether a shell may run. The dialog names no
  // call, so the shell is found by its command's first line, the one its row
  // keeps, among those its loop runs; nothing else of the dialog is read.
  // The row waits with no clock until the shell runs.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (e.tool_name === 'Bash' && !(await isClosed($))) {
      const input = isRecord(e.tool_input) ? e.tool_input : {}
      const line = shellDetail(toText(input.command))
      const owner = e.agent_id ?? ''
      const job = (await read($, work)).running.findLast(
        (one) => one.kind === 'shell' && !one.isAsking && one.taskId === '' && one.owner === owner && one.detail === line,
      )

      if (job !== undefined) {
        await update($, work, (kept) => askedAbout(kept, job.id))
      }
    }

    return next(e)
  })

  // Claude Code draws its ctrl+b hint under a shell once it has run two
  // seconds: a shell the person was asked about runs since then. Only the
  // call's id is read, while the row is drawn, and taken up by the next tick.
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (e.props.kind === 'background_hint' && !session.hints.has(e.props.tool_use_id)) {
      session.hints.set(e.props.tool_use_id, await $.clock.now())
    }

    return next(e)
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
      await foldsPruned($)
      const made = runOf(
        freeId(await read($, runs), at),
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
        return { deny: 'No plan of yours is open. Call plan first, or name its run.' }
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

  // With GitHub checks on, one more tool: what it is given is followed on
  // GitHub and shown as a run.
  if (session.hasChecks) {
    on('tool.call', { tool: 'mcp__deck__watch' }, async ($, e) => {
      if (await isClosed($)) {
        return { result: 'The person closed the deck: nothing is shown. Wait for the checks yourself.' }
      }

      const answer = await watching($, session, toText(e.target), e.wake === true)

      return answer.isRefused ? { deny: answer.text } : { result: answer.text }
    })
  }

  // With Tool for Claude or GitHub checks on, the main thread's system prompt
  // gains a section for each saying its tools are there; every other section
  // stays as it is.
  if (notes.length > 0) {
    on('prompt.compose', async ($, e, next) => {
      const answer = await next(e)

      return (await isClosed($))
        ? answer
        : {
            sections: [
              ...answer.sections.filter((section) => !notes.some((note) => note.id === section.id)),
              ...notes.map((note) => ({ ...note, scope: 'session' as const })),
            ],
          }
    })
  }

  // A subagent as it starts: its type and the few words its call names the
  // task with. Its task goes on as it came, but for the line below.
  on('agent.spawn', async ($, e, next) => {
    // With Tool for Claude or GitHub checks on, a line each at the end of the
    // subagent's task says the tools are there. A fork has the main thread's
    // prompt, which says so.
    const isTold = notes.length > 0 && !e.fork && !(await isClosed($))
    const said = notes.map((note) => note.text).join('\n\n')
    const answer = await next(isTold ? { ...e, prompt: `${e.prompt}\n\n${said}` } : e)

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
          isAsking: false,
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
    // What the docked pane takes from the screen, which the next tick hands on.
    session.dockCells =
      e.surface === 'terminal' && e.props.placement === 'dock' ? e.props.bodyColumns + DOCK_FRAME_CELLS : 0
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
      isInline: e.props.placement === 'inline',
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
          isAsking: job?.isAsking === true,
          title: job?.title ?? shellTitle(toText(input.description), toText(input.command)),
          span: ms >= 1000 && job?.isAsking !== true ? spanText(ms) : '',
        }
      })
      // The conversation's width: the screen's, less what the docked pane takes.
      const columns = (e.viewport?.columns ?? Number.POSITIVE_INFINITY) - (await read($, docked))

      return groupTree($.ui.resolve(e), await next(e), rows, (row) => shown($, row.id), columns)
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
    const jobs = await read($, work)
    const tree = await next(e)
    // The row fits what the screen leaves it: less the docked pane, and less
    // the row of another mod's it joins.
    const room = (e.viewport?.columns ?? Number.POSITIVE_INFINITY) - (await read($, docked)) - besideCells(tree)
    const view: LabelView = {
      head: modelName(gauge.model),
      bar: effortText(gauge).split(' ')[0] ?? '',
      level: effortOf(gauge),
      effortColor: effortColor(gauge),
      canStep: canStep(gauge),
      onEffort: () => {
        void update($, meter, stepped)
      },
      // A shell Claude Code asks the person about is not counted as running.
      running: jobs.running.filter((job) => !job.isAsking).length,
      runTitle: active?.title ?? '',
      runCount: active === undefined ? '' : runCount(active),
      runCells: RUN_TITLE_CELLS,
      isFailed: active !== undefined && statusOfSteps(leavesOf(active)) === 'failed',
      onPress: () => pressed($, toggled($)),
      onClose: () => {
        void rowClosedAs($, true)
      },
    }

    return beside(tree, labelRow($.ui.resolve(e), fittedLabel(view, room)))
  })
}
