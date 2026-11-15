// The shells, agents and MCP tasks the deck lists: what runs, and what lately ended.
// Plain functions over plain values; the hooks module calls them with what
// the events said.

import type { Job, JobStatus, Work } from '../types'

export const NO_WORK: Work = { running: [], recent: [] }

/** How many ended jobs are kept. */
const KEPT = 8
/** A foreground command that went well is kept only when it ran this long. */
const WORTH_MS = 3000
const TITLE_CHARS = 80
const DETAIL_CHARS = 200
/** How an MCP tool call's answer names the background task it became, and the tool. */
const MCP_TASK = /\bmoved to the background as task ([\w-]+)/
const MCP_NAME = /^MCP tool "([^"\n]+)"/

const STATUSES: Readonly<Record<string, JobStatus>> = {
  completed: 'done',
  failed: 'failed',
  killed: 'killed',
}

/** A notification's word for how its task ended, as a status. */
export const statusOf = (word: string): JobStatus => STATUSES[word] ?? 'ended'

/** One printable line of at most `chars`. */
const lineOf = (text: string, chars = TITLE_CHARS): string => {
  const line = [...(text.trim().split('\n')[0] ?? '').replace(/\s+/g, ' ')]

  return line.length > chars ? `${line.slice(0, chars - 1).join('')}…` : line.join('')
}

/** A shell's command as its opened row shows it: the first line. */
export const shellDetail = (command: string): string => lineOf(command, DETAIL_CHARS)

/** A shell's row: what the call said it does, or the command where it said nothing. */
export const shellTitle = (description: string | undefined, command: string): string =>
  lineOf(description ?? '') || lineOf(command) || 'shell'

/**
 * The background task an MCP tool call became, as the call's answer words it
 * (`MCP tool "plugin:shop:ci/build" started server-side task … It was moved
 * to the background as task k95qyf3nz …`): the task's id and the tool's full
 * name. Undefined for a call that answered in place. Claude Code gives the id
 * in this text alone.
 */
export const mcpTaskOf = (text: string): { taskId: string; name: string } | undefined => {
  const taskId = MCP_TASK.exec(text)?.[1]

  return taskId === undefined ? undefined : { taskId, name: MCP_NAME.exec(text)?.[1] ?? '' }
}

/** The server of an MCP tool's full name, `plugin:shop:ci` of `plugin:shop:ci/build`. */
export const serverOf = (name: string): string => name.slice(0, Math.max(0, name.lastIndexOf('/')))

/** An MCP task's row: its server's own name and the tool, `ci/build`, a plugin's prefix left out. */
export const mcpTitle = (name: string): string => {
  const server = serverOf(name)
  const tool = name.slice(name.lastIndexOf('/') + 1)
  const short = server.slice(server.lastIndexOf(':') + 1)

  return lineOf(short === '' ? tool : `${short}/${tool}`) || 'mcp'
}

/** An MCP task's full name as its opened row shows it. */
export const mcpDetail = (name: string): string => lineOf(name, DETAIL_CHARS)

/** An agent's row, as Claude Code names a subagent: `type(task)`. */
export const agentTitle = (type: string, description: string): string => {
  const task = lineOf(description)

  return task === '' ? type : `${type}(${task})`
}

export const started = (work: Work, job: Job): Work => ({
  running: [...work.running.filter((one) => one.id !== job.id), job],
  recent: work.recent.filter((one) => one.id !== job.id),
})

/** The job went to the background under this task id, and runs on. */
export const backgrounded = (work: Work, id: string, taskId: string, at: number): Work => ({
  ...work,
  running: work.running.map((job) =>
    job.id === id ? { ...job, taskId, ...(job.isAsking ? { isAsking: false, startedAt: at } : {}) } : job,
  ),
})

/** Claude Code asks the person whether this shell may run. */
export const asked = (work: Work, id: string): Work => ({
  ...work,
  running: work.running.map((job) => (job.id === id ? { ...job, isAsking: true } : job)),
})

/**
 * The shell the person was asked about runs since `at`: its clock starts
 * there. One nobody asked about keeps the start its call had.
 */
export const begun = (work: Work, id: string, at: number): Work => ({
  ...work,
  running: work.running.map((job) =>
    job.id === id && job.isAsking ? { ...job, isAsking: false, startedAt: Math.max(job.startedAt, at) } : job,
  ),
})

const isWorthKeeping = (job: Job): boolean =>
  job.status !== 'done' ||
  job.kind === 'agent' ||
  job.taskId !== '' ||
  job.endedAt - job.startedAt >= WORTH_MS

const closed = (work: Work, job: Job, status: JobStatus, at: number): Work => {
  // A shell that ended while the person was still asked ran under the two
  // seconds that show it began, or never ran: the wait is not its time. An MCP
  // task that waited on an answer ran all along.
  const from = job.isAsking && job.kind === 'shell' ? Math.max(at, job.startedAt) : job.startedAt
  const ended = { ...job, status, startedAt: from, endedAt: Math.max(at, from), isAsking: false }
  const running = work.running.filter((one) => one.id !== job.id)

  return isWorthKeeping(ended)
    ? { running, recent: [ended, ...work.recent].slice(0, KEPT) }
    : { running, recent: work.recent }
}

/** The running job of this id ended, newest first among the recent. */
export const ended = (work: Work, id: string, status: JobStatus, at: number): Work => {
  const job = work.running.find((one) => one.id === id)

  return job === undefined ? work : closed(work, job, status, at)
}

/** The job never ran (its call was refused): it leaves no row. */
export const dropped = (work: Work, id: string): Work => ({
  ...work,
  running: work.running.filter((job) => job.id !== id),
})

/** A background task's end, as Claude Code reports it: which task, and how it ended. */
export type Notice = { taskId: string; status: JobStatus }

/**
 * A background task was reported ended. One that still runs ends now; one
 * closed before with no word on how takes the status it is given here.
 */
export const reported = (work: Work, notice: Notice, at: number): Work => {
  const job = work.running.find((one) => one.taskId === notice.taskId)

  if (job !== undefined) {
    return closed(work, job, notice.status, at)
  }

  return {
    ...work,
    recent: work.recent.map((one) =>
      one.taskId === notice.taskId && one.status === 'ended'
        ? { ...one, status: notice.status }
        : one,
    ),
  }
}

/**
 * Closes the background shells and MCP tasks Claude Code no longer lists as
 * in flight: they ended with no notification this session saw.
 */
export const settled = (work: Work, alive: readonly string[], at: number): Work =>
  work.running
    .filter((job) => job.kind !== 'agent' && job.taskId !== '' && !alive.includes(job.taskId))
    .reduce((left, job) => closed(left, job, 'ended', at), work)

/**
 * Every job still running ends here with no status: the deck was closed and
 * sees no end from now on, so none runs on in the pane when it comes back.
 */
export const endedAll = (work: Work, at: number): Work =>
  work.running.reduce((left, job) => closed(left, job, 'ended', at), work)

const isTaskOf = (job: Job, server: string): boolean =>
  job.kind === 'mcp' && serverOf(job.detail) === server

/** True where an MCP task of this server runs. */
export const hasTaskOf = (work: Work, server: string): boolean =>
  work.running.some((job) => isTaskOf(job, server))

/**
 * An MCP server asks the person a question. Its question names no task, so
 * the newest of its tasks that runs, and waits on nothing yet, waits on it.
 */
export const questioned = (work: Work, server: string): Work => {
  const job = work.running.findLast((one) => isTaskOf(one, server) && !one.isAsking)

  return job === undefined ? work : asked(work, job.id)
}

/** The person answered an MCP server's question: its tasks that waited run on. */
export const answered = (work: Work, server: string): Work => ({
  ...work,
  running: work.running.map((job) => (isTaskOf(job, server) && job.isAsking ? { ...job, isAsking: false } : job)),
})

/** A background task as Claude Code lists it when Claude stops. */
type Listed = { id: string; type: string; status: string; server?: string; tool?: string }

/** An MCP task's row, from the tool's full name. */
export const mcpJob = (id: string, taskId: string, name: string, at: number, isAsking = false): Job => ({
  id,
  kind: 'mcp',
  title: mcpTitle(name),
  startedAt: at,
  endedAt: 0,
  status: 'running',
  taskId,
  detail: mcpDetail(name),
  model: '',
  effort: '',
  owner: '',
  isAsking,
})

/**
 * The MCP tasks Claude Code lists as running that the deck has no row of:
 * their call's answer did not word the task as the deck reads it. Each gets a
 * row from now, named by its server and tool.
 */
export const listed = (work: Work, tasks: readonly Listed[], at: number): Work => {
  const known = new Set([...work.running, ...work.recent].map((job) => job.taskId))
  const found = tasks
    .filter((task) => task.type === 'MCP task' && task.status === 'running' && !known.has(task.id))
    .map((task) => mcpJob(task.id, task.id, `${task.server ?? ''}/${task.tool ?? ''}`, at))

  return found.length === 0 ? work : { ...work, running: [...work.running, ...found] }
}

/** An agent that ended is at work again (a message woke it): its row runs on. */
export const revived = (work: Work, id: string): Work => {
  const job = work.recent.find((one) => one.id === id && one.kind === 'agent')

  return job === undefined
    ? work
    : {
        running: [...work.running, { ...job, status: 'running', endedAt: 0 }],
        recent: work.recent.filter((one) => one.id !== id),
      }
}

/**
 * The task ran this long by its own notification, which is delivered late
 * while a turn runs. A notification that names no length changes nothing.
 */
export const timed = (work: Work, taskId: string, ms: number): Work =>
  ms < 0
    ? work
    : {
        ...work,
        recent: work.recent.map((job) =>
          job.taskId === taskId ? { ...job, endedAt: job.startedAt + ms } : job,
        ),
      }

/** An agent's model or effort became known. */
export const tuned = (work: Work, id: string, patch: { model?: string; effort?: string }): Work => ({
  ...work,
  running: work.running.map((job) => (job.id === id ? { ...job, ...patch } : job)),
})

/** The ended rows taken away: all of them, or those that ended before a time. */
export const cleared = (work: Work, before = Number.POSITIVE_INFINITY): Work => ({
  ...work,
  recent: work.recent.filter((job) => job.endedAt >= before),
})

export const countOf = (work: Work, kind: Job['kind']): number =>
  work.running.filter((job) => job.kind === kind).length
