// GitHub checks as a run: what a watch follows, the API's answers as checks,
// and the checks as a run's steps. Plain functions over plain values; the
// hooks module asks GitHub and calls them with what it answered.

import type { Run, Step, StepStatus, Watch } from '../types'

import { titleOf } from './runs'
import { isRecord, toText } from './values'

/** How often GitHub is asked while something is watched. */
export const POLL_MS = 15 * 1000
/** The same with no token: GitHub answers 60 requests an hour to a nameless caller. */
export const POLL_ANON_MS = 150 * 1000
/** A commit's checks are over once this many polls in a row found every one over: a later workflow may still add its own. */
export const SETTLED_POLLS = 2
/** A watch whose checks never showed up is given up after this long. */
export const EMPTY_MS = 10 * 60 * 1000
/** Any watch is given up after this long. */
export const GIVE_UP_MS = 3 * 60 * 60 * 1000
/** A watch is given up after this many polls in a row that GitHub did not answer. */
export const MAX_FAILURES = 5
export const MAX_WATCHES = 4

/** The one host asked without `gh`: a token of the environment goes nowhere else. */
export const GITHUB = 'github.com'

/** A repository on a GitHub host: `owner/name`. */
export type Home = { host: string; repo: string }

/**
 * The repository a git remote names: `https://github.com/o/r.git`,
 * `git@github.com:o/r.git`, `ssh://git@github.com/o/r`.
 */
export const homeOf = (remote: string | null | undefined): Home | undefined => {
  const found = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
    (remote ?? '').trim(),
  )

  return found === null ? undefined : { host: found[1] ?? '', repo: `${found[2]}/${found[3]}` }
}

/** What to watch, before GitHub was asked: where it is and how its row is named. */
export type Target = Pick<Watch, 'kind' | 'host' | 'repo' | 'target' | 'url'> & {
  title: string
  /** The pull request's number, where it is one. */
  pull: number
}

const PAGE = /^https?:\/\/([^/]+)\/([\w.-]+)\/([\w.-]+)\/(pull|actions\/runs|commit|tree)\/([^?#]+)/i
/** A number this long is a workflow run's id; a shorter one is a pull request's. */
const RUN_DIGITS = 8

const pullOf = (home: Home, pull: number): Target => ({
  kind: 'ref',
  ...home,
  target: `pull/${pull}/head`,
  url: `https://${home.host}/${home.repo}/pull/${pull}`,
  title: `PR #${pull}`,
  pull,
})

const jobsOf = (home: Home, id: string): Target => ({
  kind: 'run',
  ...home,
  target: id,
  url: `https://${home.host}/${home.repo}/actions/runs/${id}`,
  title: `Run ${id}`,
  pull: 0,
})

const refOf = (home: Home, ref: string): Target => ({
  kind: 'ref',
  ...home,
  target: ref,
  url: `https://${home.host}/${home.repo}/commits/${ref}`,
  title: `Checks · ${ref}`,
  pull: 0,
})

/**
 * What the words name: a page's address on GitHub (a pull request, a
 * workflow run, a commit, a branch), `#12` or `12` for a pull request, a
 * long number for a workflow run, anything else for a branch, a tag or a
 * commit; nothing for the branch the session is on. Resolves why not, where
 * the words name nothing that can be asked for.
 */
export const targetOf = (
  words: string,
  home: Home | undefined,
  branch: string,
): Target | { error: string } => {
  const text = words.trim()
  const page = PAGE.exec(text)

  if (page !== null) {
    const there = { host: page[1] ?? '', repo: `${page[2]}/${page[3]}` }
    const rest = (page[5] ?? '').replace(/\/+$/, '')
    const first = rest.split('/')[0] ?? ''

    if (page[4] === 'pull') {
      return /^\d+$/.test(first) ? pullOf(there, Number(first)) : { error: 'That address names no pull request.' }
    }

    if (page[4] === 'actions/runs') {
      return /^\d+$/.test(first) ? jobsOf(there, first) : { error: 'That address names no workflow run.' }
    }

    return refOf(there, page[4] === 'commit' ? first : rest)
  }

  if (/^https?:\/\//i.test(text)) {
    return { error: 'That address is no pull request, workflow run, commit or branch on GitHub.' }
  }

  if (home === undefined) {
    return { error: 'This folder has no GitHub remote. Give the address of a pull request or a workflow run.' }
  }

  const number = /^#?(\d+)$/.exec(text)?.[1]

  if (number !== undefined) {
    return number.length >= RUN_DIGITS && !text.startsWith('#')
      ? jobsOf(home, number)
      : pullOf(home, Number(number))
  }

  const ref = text === '' ? branch.trim() : text

  if (ref === '' || ref === 'HEAD' || /\s/.test(ref)) {
    return { error: 'Name what to watch: a pull request, a workflow run, a branch or a commit.' }
  }

  return refOf(home, ref)
}

/** True where both follow the same thing. */
export const isSame = (one: Pick<Watch, 'kind' | 'host' | 'repo' | 'target'>, other: typeof one): boolean =>
  one.kind === other.kind && one.host === other.host && one.repo === other.repo && one.target === other.target

/**
 * The API's paths a poll asks, in the order `checksOf` takes their answers:
 * a commit's check runs and its statuses, or a workflow run and its jobs.
 */
export const pathsOf = (watch: Pick<Watch, 'kind' | 'repo' | 'target'>): [string, string] =>
  watch.kind === 'run'
    ? [
        `repos/${watch.repo}/actions/runs/${watch.target}`,
        `repos/${watch.repo}/actions/runs/${watch.target}/jobs?per_page=100`,
      ]
    : [
        `repos/${watch.repo}/commits/${encodeURIComponent(watch.target)}/check-runs?per_page=100`,
        `repos/${watch.repo}/commits/${encodeURIComponent(watch.target)}/status?per_page=100`,
      ]

/** The path that names a pull request: its title is the row's. */
export const pullPath = (target: Pick<Target, 'repo' | 'pull'>): string =>
  `repos/${target.repo}/pulls/${target.pull}`

/** `PR #12 · Fix the wallet`, from the pull request as the API answers it. */
export const pullTitle = (target: Target, answer: unknown): string => {
  const title = isRecord(answer) ? toText(answer.title) : ''

  return title === '' ? target.title : `${target.title} · ${title}`
}

/** One check, or one job of a workflow run with its steps. */
export type Check = {
  title: string
  status: StepStatus
  startedAt: number
  endedAt: number
  steps: Check[]
}

const timeOf = (value: unknown): number => Date.parse(toText(value)) || 0

const listOf = (value: unknown): Readonly<Record<string, unknown>>[] =>
  Array.isArray(value) ? value.filter(isRecord) : []

/** A check run's, a job's or a job's step's state, from its `status` and `conclusion`. */
const stateOf = (status: string, conclusion: string): StepStatus => {
  if (status !== 'completed') {
    return status === 'in_progress' ? 'running' : 'pending'
  }

  return ['success', 'neutral', 'skipped'].includes(conclusion) ? 'done' : 'failed'
}

/** An end that is neither a pass nor a plain failure is said beside the name. */
const namedOf = (name: string, status: string, conclusion: string): string =>
  status === 'completed' && !['success', 'failure', ''].includes(conclusion)
    ? `${name} (${conclusion.replace(/_/g, ' ')})`
    : name

const checkOf = (one: Readonly<Record<string, unknown>>): Check => {
  const status = toText(one.status)
  const conclusion = toText(one.conclusion)
  const state = stateOf(status, conclusion)

  return {
    title: namedOf(toText(one.name) || 'check', status, conclusion),
    status: state,
    startedAt: state === 'pending' ? 0 : timeOf(one.started_at),
    endedAt: status === 'completed' ? timeOf(one.completed_at) : 0,
    steps: listOf(one.steps).map(checkOf),
  }
}

const STATES: Readonly<Record<string, StepStatus>> = {
  success: 'done',
  failure: 'failed',
  error: 'failed',
}

/** What a poll found: the checks, whether GitHub says no more will move, and the row's name where the answer has one. */
export type Found = { checks: Check[]; isOver: boolean; title: string }

/**
 * A poll's two answers as checks. For a commit: its check runs, then the
 * statuses other services set on it; over when there is one and each is.
 * For a workflow run: its jobs, each with its steps; over when the run is.
 */
export const checksOf = (kind: Watch['kind'], first: unknown, second: unknown): Found => {
  if (kind === 'run') {
    const run = isRecord(first) ? first : {}
    const name = toText(run.name)
    const what = toText(run.display_title)

    return {
      checks: listOf(isRecord(second) ? second.jobs : undefined).map(checkOf),
      isOver: toText(run.status) === 'completed',
      title: name === '' || name === what ? what : `${name} · ${what}`,
    }
  }

  const runs = listOf(isRecord(first) ? first.check_runs : undefined).map(checkOf)
  const statuses = listOf(isRecord(second) ? second.statuses : undefined).map((one): Check => {
    const status = STATES[toText(one.state)] ?? 'running'

    return {
      title: toText(one.context) || 'status',
      status,
      startedAt: timeOf(one.created_at),
      endedAt: status === 'running' ? 0 : timeOf(one.updated_at),
      steps: [],
    }
  })
  // A job's steps are not a commit's checks.
  const checks = [...runs, ...statuses].map((check) => ({ ...check, steps: [] }))

  return { checks, isOver: checks.length > 0 && checks.every(isEnded), title: '' }
}

const isEnded = (check: Check): boolean => check.status === 'done' || check.status === 'failed'

/** The row a watch shows before GitHub lists a check. */
const WAITING = 'Waiting for checks'

const stepsOf = (checks: readonly Check[], parent = ''): Step[] =>
  checks.flatMap((check, index) => {
    const id = parent === '' ? String(index + 1) : `${parent}.${index + 1}`
    const { steps, ...own } = check

    return [{ ...own, id, title: titleOf(check.title) || 'check' }, ...stepsOf(steps, id)]
  })

/**
 * The run with what a poll found as its steps: a check a step, a job's steps
 * under the job. It counts as touched only when something moved.
 */
export const watched = (run: Run, found: Found, at: number): Run => {
  const steps =
    found.checks.length === 0
      ? [{ id: '1', title: WAITING, status: 'pending' as const, startedAt: 0, endedAt: 0 }]
      : stepsOf(found.checks)
  const title = found.title === '' ? run.title : titleOf(found.title)

  return JSON.stringify([steps, title]) === JSON.stringify([run.steps, run.title])
    ? run
    : { ...run, steps, title, touchedAt: at }
}

/** True while the run shows no check yet. */
export const isWaiting = (run: Run): boolean => run.steps.length === 1 && run.steps[0]?.title === WAITING

/**
 * The watch after a poll, or nothing once it is over: a workflow run when
 * GitHub says so, a commit's checks when enough polls in a row found each
 * one over.
 */
export const polled = (watch: Watch, found: Found): Watch | undefined => {
  const settled = found.isOver ? watch.settled + 1 : 0
  const isDone = found.isOver && (watch.kind === 'run' || settled >= SETTLED_POLLS)

  return isDone ? undefined : { ...watch, settled, failures: 0 }
}

/** Why a watch is given up at this time, or nothing while it goes on. */
export const givenUp = (watch: Watch, run: Run, at: number): string | undefined => {
  if (watch.failures >= MAX_FAILURES) {
    return 'GitHub did not answer'
  }

  if (at - watch.startedAt >= GIVE_UP_MS) {
    return 'still not over after three hours'
  }

  return isWaiting(run) && at - watch.startedAt >= EMPTY_MS ? 'no check showed up' : undefined
}

const MAX_NAMED = 8

/**
 * What Claude is told when the checks it asked to be woken for are over:
 * how many passed and failed, the failed ones by name, and the page.
 */
export const summaryOf = (run: Run, url: string, reason = ''): string => {
  const leaves = run.steps.filter((step) => !run.steps.some((one) => one.id.startsWith(`${step.id}.`)))
  const failed = leaves.filter((leaf) => leaf.status === 'failed')
  const passed = leaves.filter((leaf) => leaf.status === 'done').length
  const head =
    reason === ''
      ? `The GitHub checks of "${run.title}" are over: ${passed} passed, ${failed.length} failed.`
      : `The Deck stopped watching the GitHub checks of "${run.title}": ${reason}. ${passed} passed and ${failed.length} failed so far.`

  return [
    head,
    ...failed.slice(0, MAX_NAMED).map((leaf) => `✗ ${leaf.title}`),
    ...(failed.length > MAX_NAMED ? [`and ${failed.length - MAX_NAMED} more`] : []),
    url,
  ].join('\n')
}

/** What starting a watch answers: where it stands, and whether word will come. */
export const startText = (run: Run, url: string, wake: boolean): string => {
  const leaves = isWaiting(run)
    ? []
    : run.steps.filter((step) => !run.steps.some((one) => one.id.startsWith(`${step.id}.`)))
  const over = leaves.filter((leaf) => leaf.status === 'done' || leaf.status === 'failed').length
  const stand = leaves.length === 0 ? 'no check is listed yet' : `${over} of ${leaves.length} checks are over`

  return [
    `"${run.title}" is shown in the Deck: ${stand}.`,
    wake
      ? 'A message will tell you when they are over. Do not poll for them: end your turn, or go on with other work.'
      : 'The person sees them move. You are not told when they are over.',
    url,
  ].join(' ')
}
