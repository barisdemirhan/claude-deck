// What the mod keeps for the session, in memory: `$.state` holds each of
// these, and none of it is written to disk.

export type JobKind = 'shell' | 'agent'

/** `ended` is an end nobody reported: neither done nor failed is known. */
export type JobStatus = 'running' | 'done' | 'failed' | 'killed' | 'ended'

/** One shell command or one subagent, running or lately ended. */
export type Job = {
  /** The call's id for a shell, the agent's id for a subagent. */
  id: string
  kind: JobKind
  /** A shell's description, or its command where it has none; an agent's type and task. */
  title: string
  startedAt: number
  /** 0 while it runs. */
  endedAt: number
  status: JobStatus
  /** The background task's id, as its notification names it; empty in the foreground. */
  taskId: string
  /** A shell's command, its first line; shown when the row is opened. Empty for an agent. */
  detail: string
  /** An agent's model, as its spawn answered it; empty for a shell. */
  model: string
  /** An agent's effort, as its last request carried it; empty when unknown. */
  effort: string
  /** The agent whose loop started it, by id; empty when the main thread did. */
  owner: string
}

export type Work = { running: Job[]; recent: Job[] }

export type Meter = {
  /** The main thread's model, as its last request named it. */
  model: string
  /** The effort Claude Code set on that request; empty for a model without one. */
  effort: string
  /** False until the main thread has made a request this session. */
  isSeen: boolean
  /** The level a click asked for; empty while Claude Code's own stands. */
  wanted: string
  /** Claude Code's effort when the click was made: a change of it is `/effort`. */
  over: string
  /** The context window's fill, 0 to 100; -1 before it is known. */
  context: number
  /** What the session has cost in US dollars; -1 where Claude Code keeps no count. */
  cost: number
  /** The rate-limit windows the last response reported. */
  limits: Limit[]
}

/** One rate-limit window: `five_hour`, `seven_day` or `spend_limit`, and how full it is. */
export type Limit = { kind: string; percent: number }

export type StepStatus = 'pending' | 'running' | 'done' | 'failed'

/** One line of a run's plan. Its id is its place: `1`, `1.2`, `1.2.1`. */
export type Step = {
  id: string
  title: string
  /** A leaf's own state; a parent's is told from its leaves. */
  status: StepStatus
  /** 0 until it starts. */
  startedAt: number
  /** 0 until it ends. */
  endedAt: number
}

/** Which feed a run comes from: Claude Code's task list, the mod's tool, or GitHub's checks. */
export type RunFeed = 'tasks' | 'plan' | 'checks'

/** One job's steps, in the order they were planned. */
export type Run = {
  id: string
  title: string
  feed: RunFeed
  /** The agent whose loop opened it, by id; empty for the main thread. */
  loop: string
  /** That agent's name, for the row; empty for the main thread. */
  owner: string
  steps: Step[]
  /** When a step of it last changed: the newest unfinished run is the one shown open. */
  touchedAt: number
  /** When the agent that opened it ended with steps left; 0 while it can still move. */
  stoppedAt: number
}

/** One thing followed on GitHub, shown as a run: a commit's checks, or a workflow run's jobs. */
export type Watch = {
  /** The run that shows it, by id. */
  run: string
  kind: 'ref' | 'run'
  /** The GitHub host, `github.com` or a company's own. */
  host: string
  /** `owner/name`. */
  repo: string
  /** A branch, a tag, a commit or `pull/12/head`; for a workflow run, its id. */
  target: string
  /** Its page on GitHub. */
  url: string
  /** True where Claude asked to be told when it is over. */
  wake: boolean
  startedAt: number
  /** How many polls in a row found every check over. */
  settled: number
  /** How many polls in a row GitHub did not answer. */
  failures: number
}

export type Switches = {
  /** `/deck close`: the label and the pane away in every session. */
  isClosed: boolean
  /** The label's row closed with its `×`: the label is text on the hint line. */
  isRowClosed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    deck: {
      work: Work
      meter: Meter
      /** The clock as the last tick read it: the open pane draws again with it. */
      now: number
      switches: Switches
      runs: Run[]
      /** What is followed on GitHub, with the GitHub checks setting on. */
      watches: Watch[]
      /** How long each of the last shell commands ran, by its call's id, for the transcript's rows. */
      spans: Record<string, number>
      /** The branches the person folded or unfolded, by `run/step`: true is open. */
      folds: Record<string, boolean>
    }
  }
}
