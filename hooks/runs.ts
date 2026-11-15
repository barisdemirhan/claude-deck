// Runs: step-by-step progress of a job, as a tree of any depth. A run's
// steps are one flat list in planned order; a step's id is its place in the
// tree (`1`, `1.2`, `1.2.1`), so its parent and its children are told from
// the id alone. Only leaves hold a state: a parent's comes from its leaves.

import type { Run, RunFeed, Step, StepStatus } from '../types'

import { barOf } from './meter'
import { spanText } from './view'

/** How many runs are kept; the oldest finished one goes first. */
const KEPT = 6
const MAX_STEPS = 200
const MAX_DEPTH = 6
const TITLE_CHARS = 80
const METER_CELLS = 8

const cut = (text: string, chars: number): string => {
  const line = [...text.trim().replace(/\s+/g, ' ')]

  return line.length > chars ? `${line.slice(0, chars - 1).join('')}…` : line.join('')
}

export const titleOf = (text: string): string => cut(text, TITLE_CHARS)

const isUnder = (id: string, parent: string): boolean => id.startsWith(`${parent}.`)

export const isLeaf = (run: Run, id: string): boolean =>
  !run.steps.some((step) => isUnder(step.id, id))

/** The leaves a step stands for: itself, or every leaf beneath it. */
export const leavesOf = (run: Run, id?: string): Step[] =>
  run.steps.filter(
    (step) => isLeaf(run, step.id) && (id === undefined || step.id === id || isUnder(step.id, id)),
  )

const isOver = (step: Step): boolean => step.status === 'done' || step.status === 'failed'

/**
 * A branch's state from its leaves: failed once one failed, done when all
 * are, running while one runs or some are over and some are not.
 */
export const statusOf = (leaves: readonly Step[]): StepStatus => {
  if (leaves.some((leaf) => leaf.status === 'failed')) {
    return 'failed'
  }

  if (leaves.length > 0 && leaves.every((leaf) => leaf.status === 'done')) {
    return 'done'
  }

  return leaves.some((leaf) => leaf.status !== 'pending') ? 'running' : 'pending'
}

/** True once no leaf is left to run. */
export const isFinished = (leaves: readonly Step[]): boolean =>
  leaves.length > 0 && leaves.every(isOver)

const doneOf = (leaves: readonly Step[]): number =>
  leaves.filter((leaf) => leaf.status === 'done').length

/**
 * How many cells of a run's bar are filled: each leaf done is one, each leaf
 * that runs half of one while the run is not stopped. A running leaf fills
 * one cell at least, and the bar is full only when every leaf is done.
 */
const filledOf = (run: Run, leaves: readonly Step[]): number => {
  const done = doneOf(leaves)
  const running = run.stoppedAt === 0 ? leaves.filter((leaf) => leaf.status === 'running').length : 0
  const cells = Math.round(((done + running / 2) / Math.max(1, leaves.length)) * METER_CELLS)

  if (leaves.length > 0 && done === leaves.length) {
    return METER_CELLS
  }

  return Math.min(METER_CELLS - 1, running > 0 ? Math.max(1, cells) : cells)
}

/** From the first start among the leaves to the last end, or to now while one is not over. */
const spanOf = (leaves: readonly Step[], now: number): string => {
  const starts = leaves.filter((leaf) => leaf.startedAt > 0).map((leaf) => leaf.startedAt)

  if (starts.length === 0) {
    return ''
  }

  const end = isFinished(leaves) ? Math.max(...leaves.map((leaf) => leaf.endedAt)) : now
  const ms = Math.max(0, end - Math.min(...starts))

  // A step over within the second, or one whose times nobody saw, shows none.
  return isFinished(leaves) && ms < 1000 ? '' : spanText(ms)
}

/**
 * A plan as indented text, one step a line, as steps. A line indented
 * deeper than the one before it is its child; a bullet or a number before
 * the title is dropped. Empty when the text holds no step.
 */
export const planned = (text: string): Step[] => {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\t/g, '  '))
    .filter((line) => line.trim() !== '')
    .slice(0, MAX_STEPS)
  // The indent of each open level, and how many steps each has so far.
  const indents: number[] = []
  const counts: number[] = []

  return lines.map((line) => {
    const indent = line.length - line.trimStart().length

    while (indents.length > 1 && indent < (indents.at(-1) ?? 0)) {
      indents.pop()
      counts.pop()
    }

    if (indents.length === 0 || (indent > (indents.at(-1) ?? 0) && indents.length < MAX_DEPTH)) {
      indents.push(indent)
      counts.push(0)
    }

    counts[counts.length - 1] = (counts.at(-1) ?? 0) + 1

    return {
      id: counts.join('.'),
      title: titleOf(line.trim().replace(/^([-*•]|\d+[.)])\s+/, '')) || 'step',
      status: 'pending',
      startedAt: 0,
      endedAt: 0,
    }
  })
}

/** The runs with one more, the oldest finished ones dropped past what is kept. */
export const opened = (runs: readonly Run[], run: Run): Run[] => {
  const all = [...runs.filter((one) => one.id !== run.id), run]
  const spare = all.length - KEPT
  const old = all
    .filter((one) => one.id !== run.id && isFinished(leavesOf(one)))
    .slice(0, Math.max(0, spare))
    .map((one) => one.id)

  return all.filter((one) => !old.includes(one.id)).slice(-KEPT)
}

export const runOf = (
  id: string,
  title: string,
  feed: RunFeed,
  loop: string,
  owner: string,
  steps: Step[],
  at: number,
): Run => ({
  id,
  title: titleOf(title) || 'Run',
  feed,
  loop,
  owner,
  steps,
  touchedAt: at,
  stoppedAt: 0,
})

const replaced = (runs: readonly Run[], run: Run): Run[] =>
  runs.map((one) => (one.id === run.id ? run : one))

export type StepWord = 'start' | 'done' | 'fail'

const turned = (step: Step, word: StepWord, at: number): Step => {
  if (word === 'start') {
    return { ...step, status: 'running', startedAt: step.startedAt || at, endedAt: 0 }
  }

  return {
    ...step,
    status: word === 'done' ? 'done' : 'failed',
    startedAt: step.startedAt || at,
    endedAt: at,
  }
}

const parentOf = (id: string): string => id.split('.').slice(0, -1).join('.')

/**
 * One leaf of a run starts, is done or fails. A start ends every leaf still
 * running before it in the plan, in its own branch or an earlier one, so
 * moving on is one call. Resolves the run, or why nothing changed.
 */
export const stepped = (
  run: Run,
  id: string,
  word: StepWord,
  at: number,
): { run: Run; error?: undefined } | { error: string; run?: undefined } => {
  const step = run.steps.find((one) => one.id === id)

  if (step === undefined) {
    return { error: `No step ${id}. The steps: ${leavesOf(run).map((leaf) => leaf.id).join(', ')}.` }
  }

  if (!isLeaf(run, id)) {
    return {
      error: `${id} has steps of its own and follows them. Update one of: ${leavesOf(run, id).map((leaf) => leaf.id).join(', ')}.`,
    }
  }

  const place = run.steps.indexOf(step)
  const steps = run.steps.map((one, index) => {
    if (one.id === id) {
      return turned(one, word, at)
    }

    const isBefore =
      word === 'start' && index < place && one.status === 'running' && isLeaf(run, one.id)

    return isBefore ? turned(one, 'done', at) : one
  })

  return { run: { ...run, steps, touchedAt: at, stoppedAt: 0, isWaiting: false } }
}

/**
 * The runs with a loop's new plan. The task list the loop was following goes:
 * the plan tells the same job with its levels. A plan of the loop's that is
 * still under way stops where it stands: the loop has moved on to another
 * job, and nothing would end the old one.
 */
export const replanned = (runs: readonly Run[], run: Run): Run[] =>
  opened(
    runs
      .filter((one) => !(one.feed === 'tasks' && one.loop === run.loop && isLive(one)))
      .map((one) => (one.feed === 'plan' && one.loop === run.loop && isLive(one) ? halted(one, run.touchedAt) : one)),
    run,
  )

/**
 * The plan a loop's step is for: the one named, else the loop's newest
 * unfinished plan, else its newest. Never another loop's by itself: a
 * subagent with no plan of its own would move the main thread's.
 */
export const planOf = (runs: readonly Run[], loop: string, id: string): Run | undefined => {
  const plans = runs.filter((run) => run.feed === 'plan')

  if (id !== '') {
    return plans.find((run) => run.id === id)
  }

  const own = plans.filter((run) => run.loop === loop)

  return own.findLast((run) => !isFinished(leavesOf(run))) ?? own.at(-1)
}

/**
 * A task Claude Code's own list gained. The loop's list is one flat run; a
 * task made after every earlier one is over begins a new run.
 */
export const taskCreated = (
  runs: readonly Run[],
  loop: string,
  owner: string,
  taskId: string,
  subject: string,
  at: number,
  mint: () => string,
): Run[] => {
  const step: Step = { id: taskId, title: titleOf(subject) || 'task', status: 'pending', startedAt: 0, endedAt: 0 }
  const list = runs.findLast((run) => run.feed === 'tasks' && run.loop === loop)

  // A loop that follows a plan shows that plan: its task list would be the
  // same job a second time.
  if (runs.some((run) => run.feed === 'plan' && run.loop === loop && isLive(run))) {
    return [...runs]
  }

  if (list === undefined || isFinished(leavesOf(list))) {
    return opened(runs, runOf(mint(), 'Tasks', 'tasks', loop, owner, [step], at))
  }

  return replaced(runs, {
    ...list,
    steps: [...list.steps.filter((one) => one.id !== taskId), step],
    touchedAt: at,
    stoppedAt: 0,
    isWaiting: false,
  })
}

/** A task of the loop's list changed: its state, its title, or it was deleted. */
export const taskUpdated = (
  runs: readonly Run[],
  loop: string,
  taskId: string,
  change: { status?: string; subject?: string },
  at: number,
): Run[] => {
  const list = runs.findLast(
    (run) => run.feed === 'tasks' && run.loop === loop && run.steps.some((step) => step.id === taskId),
  )

  if (list === undefined) {
    return [...runs]
  }

  if (change.status === 'deleted') {
    const steps = list.steps.filter((step) => step.id !== taskId)

    return steps.length === 0
      ? runs.filter((run) => run.id !== list.id)
      : replaced(runs, { ...list, steps, touchedAt: at, stoppedAt: 0, isWaiting: false })
  }

  const steps = list.steps.map((step) => {
    if (step.id !== taskId) {
      return step
    }

    const named = change.subject === undefined ? step : { ...step, title: titleOf(change.subject) || step.title }

    if (change.status === 'in_progress') {
      return turned(named, 'start', at)
    }

    if (change.status === 'completed') {
      return turned(named, 'done', at)
    }

    return change.status === 'pending'
      ? { ...named, status: 'pending' as const, startedAt: 0, endedAt: 0 }
      : named
  })

  return replaced(runs, { ...list, steps, touchedAt: at, stoppedAt: 0, isWaiting: false })
}

/** True while a run can still move: steps are left, and its agent has not ended. */
export const isLive = (run: Run): boolean => run.stoppedAt === 0 && !isFinished(leavesOf(run))

/**
 * The agent of this loop ended: each run it left unfinished stops there.
 * When it ended with its answer, the step it left running is done, so an
 * agent need not spend a call on its last step; when it was cut short, that
 * step goes back to waiting, since nobody will end it.
 */
export const stopped = (
  runs: readonly Run[],
  loop: string,
  at: number,
  isAnswered = false,
): Run[] => runs.map((run) => (run.loop !== loop || !isLive(run) ? run : halted(run, at, isAnswered)))

/** One live run stopped where it stands, as `stopped` stops a loop's. */
const halted = (run: Run, at: number, isAnswered = false): Run => {
  const steps = run.steps.map((step) =>
    step.status === 'running' && isLeaf(run, step.id)
      ? { ...step, status: isAnswered ? ('done' as const) : ('pending' as const), endedAt: at }
      : step,
  )
  const left = { ...run, steps, touchedAt: at, isWaiting: false }

  return isFinished(leavesOf(left)) ? left : { ...left, stoppedAt: at }
}

/** True for a run of the main thread's own: its plan or its task list. */
const isMains = (run: Run): boolean => run.loop === '' && run.feed !== 'checks'

/**
 * The main thread's turn ended at `endedAt` and nothing it started runs on:
 * each run of its own that no step has moved since waits from `at`. Its
 * steps keep their states, so a step called in a later turn moves it on from
 * where it stood, however long the person was away; its clock holds
 * meanwhile, and a clear takes it.
 */
export const rested = (runs: readonly Run[], endedAt: number, at: number): Run[] =>
  runs.map((run) => (isMains(run) && isLive(run) && run.touchedAt <= endedAt ? { ...run, stoppedAt: at, isWaiting: true } : run))

/** True where `rested` would change a run. */
export const canRest = (runs: readonly Run[], endedAt: number): boolean =>
  runs.some((run) => isMains(run) && isLive(run) && run.touchedAt <= endedAt)

/**
 * Every run still under way stops where it stands: the deck was closed and
 * hears no step from now on. A step a loop calls later moves its run again.
 */
export const stoppedAll = (runs: readonly Run[], at: number): Run[] =>
  runs.map((run) => (isLive(run) ? halted(run, at) : run))

/** The run a fold's key belongs to: `r1` of `r1`, `r1/2.1` and `step:r1/2.1`. */
const runOfFold = (key: string): string => key.replace(/^step:/, '').split('/')[0] ?? ''

/**
 * The folds of what is still shown: a job's by its id, a run's, a branch's
 * and a step's by their run. A run that takes a freed id starts with none.
 */
export const keptFolds = (
  folds: Readonly<Record<string, boolean>>,
  runs: readonly Run[],
  jobIds: readonly string[],
): Record<string, boolean> =>
  Object.fromEntries(
    Object.entries(folds).filter(([key]) =>
      key.startsWith('job:') ? jobIds.includes(key.slice('job:'.length)) : runs.some((run) => run.id === runOfFold(key)),
    ),
  )

/**
 * The runs that can still move: what a clear leaves, or those touched since
 * a time. A run that waits for a later turn is over for a clear and not for
 * the time: the person may answer hours on, and its agent goes on from it.
 */
export const swept = (runs: readonly Run[], before = Number.POSITIVE_INFINITY): Run[] =>
  runs.filter(
    (run) =>
      isLive(run) ||
      (run.isWaiting === true && before !== Number.POSITIVE_INFINITY) ||
      Math.max(run.touchedAt, run.stoppedAt) >= before,
  )

/**
 * What to tell the person of a change of the runs: a run that finished, or a
 * step that failed, a line each.
 */
export const newsOf = (before: readonly Run[], after: readonly Run[]): string[] =>
  after.flatMap((run) => {
    const old = before.find((one) => one.id === run.id)
    const leaves = leavesOf(run)
    const failed = leaves.filter((leaf) => leaf.status === 'failed')
    const wasFailed = old === undefined ? 0 : leavesOf(old).filter((leaf) => leaf.status === 'failed').length
    const isNew = old === undefined || !isFinished(leavesOf(old))

    if (failed.length > wasFailed) {
      return [`✗ ${cut(run.title, 32)}: ${cut(failed.at(-1)?.title ?? '', 40)} failed`]
    }

    return isFinished(leaves) && isNew && old !== undefined
      ? [`✓ ${cut(run.title, 40)} ${doneOf(leaves)}/${leaves.length}`]
      : []
  })

/** The run the label and the open section follow: the newest touched one that can still move. */
export const activeOf = (runs: readonly Run[]): Run | undefined =>
  runs
    .filter(isLive)
    .reduce<Run | undefined>(
      (best, run) => (best === undefined || run.touchedAt >= best.touchedAt ? run : best),
      undefined,
    )

/** How many of a run's title the label shows at most. */
export const RUN_TITLE_CELLS = 24

/** `5/8`: a run's leaves done of all. */
export const runCount = (run: Run): string => {
  const leaves = leavesOf(run)

  return `${doneOf(leaves)}/${leaves.length}`
}

/** `Auth renewal 5/8`, for the label: the title cut to `chars`. */
export const runText = (run: Run, chars = RUN_TITLE_CELLS): string => `${cut(run.title, chars)} ${runCount(run)}`

/** One drawn row of a run: the run itself, a branch or a leaf. */
export type Row = {
  /** `run/step`, or the run's id for its own row: the fold's key for a row that opens. */
  key: string
  kind: 'run' | 'branch' | 'leaf'
  depth: number
  status: StepStatus
  title: string
  /** `▰▰▰▰▰▱▱▱`, on a run's row. */
  meter: string
  /** `5/8`: leaves done of all, on a run's or a branch's row. */
  count: string
  span: string
  isOpen: boolean
  /**
   * On a run's row: it stopped with steps left (its agent ended, or the main
   * thread's turn did). On a branch's or a leaf's: it was under way then.
   */
  isStopped: boolean
}

const depthOf = (id: string): number => id.split('.').length

/**
 * A run as rows, top to bottom, with what is folded left out. A branch is
 * open by itself while it is under way, and folded before it starts and
 * once it is over; the person's own fold stands over both.
 */
export const rowsOf = (
  run: Run,
  folds: Readonly<Record<string, boolean>>,
  now: number,
  isActive: boolean,
): Row[] => {
  const all = leavesOf(run)
  // A stopped run's clocks read the moment it stopped.
  const at = run.stoppedAt || now
  const isRunOpen = folds[run.id] ?? isActive
  const top: Row = {
    key: run.id,
    kind: 'run',
    depth: 0,
    status: statusOf(all),
    title: run.owner === '' ? run.title : `${run.title} · ${run.owner}`,
    meter: barOf(filledOf(run, all), METER_CELLS),
    count: `${doneOf(all)}/${all.length}`,
    span: spanOf(all, at),
    isOpen: isRunOpen,
    isStopped: run.stoppedAt > 0,
  }

  if (!isRunOpen) {
    return [top]
  }

  const open = new Map<string, boolean>()
  const rows = run.steps.flatMap((step): Row[] => {
    const parent = parentOf(step.id)

    if (parent !== '' && open.get(parent) !== true) {
      open.set(step.id, false)

      return []
    }

    const leaves = leavesOf(run, step.id)
    const key = `${run.id}/${step.id}`

    if (isLeaf(run, step.id)) {
      return [
        {
          key,
          kind: 'leaf',
          depth: depthOf(step.id),
          status: step.status,
          title: step.title,
          meter: '',
          count: '',
          span: spanOf([step], at),
          isOpen: false,
          isStopped: run.stoppedAt > 0 && step.status === 'running',
        },
      ]
    }

    const status = statusOf(leaves)
    const isOpen = folds[key] ?? (!isFinished(leaves) && status !== 'pending')
    open.set(step.id, isOpen)

    return [
      {
        key,
        kind: 'branch',
        depth: depthOf(step.id),
        status,
        title: step.title,
        meter: '',
        count: `${doneOf(leaves)}/${leaves.length}`,
        span: spanOf(leaves, at),
        isOpen,
        isStopped: run.stoppedAt > 0 && status === 'running',
      },
    ]
  })

  return [top, ...rows]
}

/**
 * What a step's answer says after its count: the step to start next, or
 * that the one started is the last. A subagent's last step ends with its
 * answer; the main thread's is its own to end, since its turn may end on a
 * question with the step half made.
 */
export const hintOf = (run: Run, id: string, word: StepWord): string => {
  const leaves = leavesOf(run)
  const next = leaves[leaves.findIndex((leaf) => leaf.id === id) + 1]

  if (next !== undefined) {
    return word === 'fail' ? '' : ` Next: ${next.id}.`
  }

  if (word !== 'start') {
    return ''
  }

  return run.loop === ''
    ? ' It is the last step: call done when it is finished.'
    : ' It is the last step: it is done by itself when you answer.'
}

/** The plan as the tool answers it: each step's id and title, a line each. */
export const planText = (run: Run): string =>
  run.steps.map((step) => `${step.id} ${step.title}`).join('\n')
