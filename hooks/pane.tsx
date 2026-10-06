// The pane's drawing, and the label's row under the hint line. Nothing here
// calls Claude Code: the hooks module hands in the surface's elements, what
// to show and what a press does.

import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  RenderElement,
  RenderNode,
  TextProps,
} from 'claude-code'

import type { Job, Meter, Work } from '../types'

import {
  LEVEL_CELLS,
  canStep,
  contextText,
  effortColor,
  effortOf,
  effortText,
  isHeld,
  isTight,
  modelName,
  usageText,
} from './meter'
import type { Row } from './runs'
import { GLYPHS, jobSpan } from './view'

export type Kit = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

export type PaneView = {
  meter: Meter
  work: Work
  now: number
  /** Cells across the pane's body. */
  columns: number
  /** A press on the effort meter. */
  onEffort: () => void
  /** Each run as rows, the newest touched first, but for those drawn under their agent. */
  runs: readonly (readonly Row[])[]
  /** The runs a running agent opened, by the agent's id: drawn under its row. */
  nested: Readonly<Record<string, readonly (readonly Row[])[]>>
  /** A press on a run's or a branch's fold mark. */
  onFold: (row: Row) => void
  /** The rows the person opened, by `job:<id>`. */
  open: Readonly<Record<string, boolean>>
  /** A press on a shell's or an agent's title: opens and closes its detail. */
  onJob: (job: Job) => void
  /** A press on an opened row's stop button. */
  onStop: (job: Job) => void
  /** A press on the clear button. */
  onClear: () => void
}

const COLORS: Readonly<Record<Job['status'], string | undefined>> = {
  running: 'claude',
  done: 'success',
  failed: 'error',
  killed: 'warning',
  ended: undefined,
}

/** The pane's body is drawn one cell in from each side. */
const PAD = 1
const KIND_CELLS = 7
const SPAN_CELLS = 8
/** A pane narrower than this leaves out a run's bar, and one narrower than the other a row's kind: the title needs the cells. */
const BAR_FROM = 44
const KIND_FROM = 36

const rule = ({ Text }: Kit, columns: number): RenderElement => (
  <Text dimColor wrap="truncate">
    {'─'.repeat(Math.max(1, columns))}
  </Text>
)

/** What an opened row adds under itself: a shell's command, an agent's model and effort. */
const detailOf = (job: Job): string =>
  job.kind === 'shell'
    ? `$ ${job.detail}`
    : [modelName(job.model), job.effort === '' ? '' : `${job.effort} effort`]
        .filter((part) => part !== '')
        .join(' · ') || 'agent'

/**
 * `⏵ Typecheck, test and lint        shell    1m 12s`
 *
 * The title is a button: a press opens the row's detail under it, where a
 * job that runs in the background has a stop button. Under a running agent's
 * row come the shells and agents it started and the run it opened. Where the
 * section's name says the kind, the kind's column is left out.
 */
/** A title cut to the cells it has, so a row stays one line: a button's label does not cut itself. */
const fitted = (title: string, cells: number): string => {
  const letters = [...title]

  return letters.length > cells ? `${letters.slice(0, Math.max(1, cells - 1)).join('')}…` : title
}

const jobRow = (
  kit: Kit,
  job: Job,
  view: PaneView,
  indent = 0,
  wantsKind = true,
): RenderElement => {
  const { Box, Text, Button } = kit
  const hasKind = wantsKind && view.columns >= KIND_FROM
  // The row's cells less its mark, its indent and its columns at the right.
  const room =
    view.columns - 2 * PAD - 2 - 2 * indent - SPAN_CELLS - (hasKind ? KIND_CELLS : 0) - 1
  // What the agent of this row started and still runs is drawn under it.
  const own =
    job.kind === 'agent' && job.status === 'running'
      ? view.work.running.filter((one) => one.owner === job.id)
      : []
  const isOpen = view.open[`job:${job.id}`] === true
  const canStop = job.status === 'running' && job.taskId !== ''

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={2 * indent} flexShrink={0} />
        <Box width={2} flexShrink={0}>
          <Text color={COLORS[job.status]} dimColor={job.status === 'ended'}>
            {GLYPHS[job.status]}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Button
            key={`job:${job.id}`}
            plain
            dimColor={job.status !== 'running' && job.status !== 'failed'}
            label={fitted(job.title, room)}
            onPress={() => {
              view.onJob(job)
            }}
          />
        </Box>
        {hasKind && (
          <Box width={KIND_CELLS} flexShrink={0} justifyContent="flex-end">
            <Text dimColor>{job.kind}</Text>
          </Box>
        )}
        <Box width={SPAN_CELLS} flexShrink={0} justifyContent="flex-end">
          <Text dimColor={job.status !== 'running'}>{jobSpan(job, view.now)}</Text>
        </Box>
      </Box>
      {isOpen && (
        <Box columnGap={2} paddingLeft={2 + 2 * indent}>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {detailOf(job)}
            </Text>
          </Box>
          {canStop && (
            <Button
              key={`stop:${job.id}`}
              plain
              label="■ stop"
              onPress={() => {
                view.onStop(job)
              }}
            />
          )}
        </Box>
      )}
      {own.map((one) => jobRow(kit, one, view, indent + 1, wantsKind))}
      {job.status === 'running' &&
        (view.nested[job.id] ?? []).flatMap((rows) =>
          rows.map((row) => stepRow(kit, row, view, indent + 1)),
        )}
    </Box>
  )
}

/**
 * The model, its effort meter (a button where a press can change it) and the
 * context's fill; under them the session's cost and its limits.
 */
const head = (kit: Kit, view: PaneView): RenderElement => {
  const { Box, Text, Button } = kit
  const { meter } = view
  const effort = effortText(meter)
  const context = contextText(meter)
  const usage = usageText(meter)

  return (
    <Box flexDirection="column">
      <Box columnGap={2} flexWrap="wrap" justifyContent="space-between">
        <Box columnGap={2}>
          <Text bold>{modelName(meter.model) || 'Claude'}</Text>
          {canStep(meter) ? (
            <Box columnGap={1}>
              <Text color={effortColor(meter)} dimColor={effortOf(meter) === 'low'}>
                {effort.split(' ')[0]}
              </Text>
              <Button
                key="effort"
                plain
                label={`${effortOf(meter)} ${isHeld(meter) ? '⟳' : '↑'}`.padEnd(LEVEL_CELLS + 2)}
                onPress={view.onEffort}
              />
            </Box>
          ) : (
            <Text dimColor>
              {effort || (meter.isSeen ? 'no effort setting' : 'effort shows with the first request')}
            </Text>
          )}
        </Box>
        {context !== '' && <Text dimColor={meter.context < 80}>{context}</Text>}
      </Box>
      {usage !== '' && (
        <Text color={isTight(meter) ? 'warning' : undefined} dimColor={!isTight(meter)} wrap="truncate-end">
          {usage}
        </Text>
      )}
    </Box>
  )
}

const section = (
  kit: Kit,
  title: string,
  aside: RenderElement,
  jobs: readonly Job[],
  view: PaneView,
  hasKind = true,
): RenderElement => {
  const { Box, Text } = kit

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold dimColor>
          {title}
        </Text>
        {aside}
      </Box>
      {jobs.map((job) => jobRow(kit, job, view, 0, hasKind))}
    </Box>
  )
}

const STEP_GLYPHS: Readonly<Record<Row['status'], string>> = {
  pending: '○',
  running: GLYPHS.running,
  done: GLYPHS.done,
  failed: GLYPHS.failed,
}

const STEP_COLORS: Readonly<Record<Row['status'], string | undefined>> = {
  pending: undefined,
  running: COLORS.running,
  done: COLORS.done,
  failed: COLORS.failed,
}

const COUNT_CELLS = 6
const METER_CELLS = 9

/**
 * One row of a run. A run's and a branch's mark is a button that folds and
 * unfolds it: `▾` open, `▸` folded while under way, and its state's own mark
 * when folded before its start or after its end.
 *
 * `▾ Auth renewal                 ▰▰▰▰▰▱▱▱ 5/8   12m 40s`
 * `    ✓ Move the old table                        1m 30s`
 */
const stepRow = (kit: Kit, row: Row, view: PaneView, indent = 0): RenderElement => {
  const { Box, Text, Button } = kit
  const isQuiet = row.status === 'done' || row.status === 'pending'
  const folded = row.status === 'running' || row.kind === 'run' ? '▸' : STEP_GLYPHS[row.status]
  const mark =
    row.kind === 'leaf' ? (
      <Text color={STEP_COLORS[row.status]} dimColor={row.status === 'pending'}>
        {STEP_GLYPHS[row.status]}
      </Text>
    ) : (
      <Button
        key={`fold:${row.key}`}
        plain
        label={row.isOpen ? '▾' : folded}
        onPress={() => {
          view.onFold(row)
        }}
      />
    )
  // A run folded away still says how it stands, beside its mark.
  const state = row.kind === 'run' && (row.status === 'done' || row.status === 'failed')

  return (
    <Box>
      <Box width={2 * (row.depth + indent)} flexShrink={0} />
      <Box width={2} flexShrink={0}>
        {mark}
      </Box>
      {state && (
        <Box width={2} flexShrink={0}>
          <Text color={STEP_COLORS[row.status]}>{STEP_GLYPHS[row.status]}</Text>
        </Box>
      )}
      <Box flexGrow={1} flexShrink={1}>
        <Text
          bold={row.kind === 'run'}
          color={row.status === 'failed' ? STEP_COLORS.failed : undefined}
          dimColor={row.kind !== 'run' && isQuiet}
          wrap="truncate-end"
        >
          {row.title}
        </Text>
      </Box>
      {row.meter !== '' && view.columns >= BAR_FROM && (
        <Box width={METER_CELLS} flexShrink={0} justifyContent="flex-end">
          <Text color={STEP_COLORS[row.status]} dimColor={row.status === 'pending'}>
            {row.meter}
          </Text>
        </Box>
      )}
      <Box width={COUNT_CELLS} flexShrink={0} justifyContent="flex-end">
        <Text dimColor={row.kind !== 'run'}>{row.count}</Text>
      </Box>
      <Box width={SPAN_CELLS} flexShrink={0} justifyContent="flex-end">
        <Text dimColor={row.status !== 'running'}>{row.span}</Text>
      </Box>
    </Box>
  )
}

/**
 * The runs as sections: an open run is a section of its own, and the folded
 * ones that follow each other share one.
 */
const runSections = (kit: Kit, view: PaneView): RenderElement[] => {
  const { Box } = kit
  const groups = view.runs.reduce<Row[][]>((left, rows) => {
    const last = left.at(-1)
    const isFolded = rows.length === 1

    return isFolded && last !== undefined && last.every((row) => row.kind === 'run' && !row.isOpen)
      ? [...left.slice(0, -1), [...last, ...rows]]
      : [...left, [...rows]]
  }, [])

  return groups.map((rows) => (
    <Box flexDirection="column">{rows.map((row) => stepRow(kit, row, view))}</Box>
  ))
}

/**
 * The pane: the model and its meters, then the shells that run, then the
 * agents that run with what each started, then the runs, then what lately
 * ended. Where something is over, a last
 * line has the button that clears it away.
 */
export const paneTree = (kit: Kit, view: PaneView): RenderElement => {
  const { Box, Text, Button } = kit
  const { work } = view
  const columns = Math.max(1, view.columns - 2 * PAD)
  const line = rule(kit, columns)
  const more = runSections(kit, view)
  const isIdle = work.running.length === 0 && work.recent.length === 0 && more.length === 0
  const isOver = (rows: readonly Row[]): boolean =>
    rows[0]?.status === 'done' || rows[0]?.status === 'failed' || rows[0]?.isStopped === true
  const canClear = work.recent.length > 0 || view.runs.some(isOver)
  // What runs, in two sections: the shells nobody's agent started, then each
  // agent with what it started under it.
  const isTop = (job: Job): boolean => !work.running.some((one) => one.id === job.owner)
  const shells = work.running.filter((job) => job.kind === 'shell' && isTop(job))
  const agents = work.running.filter((job) => job.kind === 'agent' && isTop(job))
  const blank = <Text> </Text>
  const clear = (
    <Button key="clear" plain dimColor label="× clear" onPress={view.onClear} />
  )

  return (
    <Box flexDirection="column" paddingX={PAD}>
      {head(kit, view)}
      {line}
      {work.running.length === 0 && (
        <Text dimColor>{isIdle ? 'Nothing runs yet.' : 'Nothing runs right now.'}</Text>
      )}
      {shells.length > 0 && section(kit, `SHELLS · ${shells.length}`, blank, shells, view, false)}
      {shells.length > 0 && agents.length > 0 && line}
      {agents.length > 0 && section(kit, `AGENTS · ${agents.length}`, blank, agents, view, false)}
      {isIdle && (
        <Text dimColor>Shells, agents and task lists Claude starts show here while they run.</Text>
      )}
      {more.flatMap((part) => [line, part])}
      {work.recent.length > 0 && line}
      {work.recent.length > 0 && section(kit, 'RECENT', blank, work.recent, view)}
      {canClear && <Box justifyContent="flex-end">{clear}</Box>}
    </Box>
  )
}

/** The deck's mark on its label's row: a pane docked at the right. */
const MARK = '◨'

/** What the label's row says, part by part. */
export type LabelView = {
  /** The model's name; empty before it is known. */
  head: string
  /** Its effort's bar, `▰▰▰▱▱`, the level's name and its color; the bar is empty with no effort. */
  bar: string
  level: string
  effortColor: string | undefined
  /** True where a press can change the effort. */
  canStep: boolean
  /** A press on the effort's level: one step up, as on the pane's meter. */
  onEffort: () => void
  /** How many shells and agents run. */
  running: number
  /** The run under way with its count, `Auth renewal 5/8`; empty with none. */
  run: string
  /** True when a step of that run failed. */
  isFailed: boolean
  /** A press on the deck's mark, or on the run: opens or closes the pane. */
  onPress: () => void
  /** A press on the row's `×`: the label goes back to the hint line as text. */
  onClose: () => void
}

/**
 * The label as a row of its own, where there is a pointer. It begins with
 * the deck's mark, a button that opens or closes the pane, as the run at its
 * end does. Between them the model's name is text, and its effort's level is
 * a button that steps it up as the pane's meter does, as wide at every level
 * as the longest level's name. The effort's bar has its level's color, what
 * runs the color of a running row, a failure is red.
 */
export const labelRow = (kit: Kit, view: LabelView): RenderElement => {
  const { Box, Text, Button } = kit
  const dot = <Text dimColor>·</Text>

  return (
    <Box columnGap={1}>
      <Button key="deck" plain label={MARK} onPress={view.onPress} />
      {view.head !== '' && <Text>{view.head}</Text>}
      {view.bar !== '' && (
        <Text color={view.effortColor} dimColor={view.effortColor === undefined}>
          {view.bar}
        </Text>
      )}
      {view.bar !== '' &&
        (view.canStep ? (
          <Button
            key="deck-effort"
            plain
            label={view.level.padEnd(LEVEL_CELLS)}
            onPress={view.onEffort}
          />
        ) : (
          <Text dimColor>{view.level}</Text>
        ))}
      {view.running > 0 && dot}
      {view.running > 0 && <Text color={COLORS.running}>{`${GLYPHS.running} ${view.running}`}</Text>}
      {view.run !== '' && dot}
      {view.run !== '' && view.isFailed && <Text color={COLORS.failed}>{GLYPHS.failed}</Text>}
      {view.run !== '' && (
        <Button key="deck-run" plain dimColor label={view.run} onPress={view.onPress} />
      )}
      <Button key="deck-row-close" plain dimColor label="×" onPress={view.onClose} />
    </Box>
  )
}

/**
 * `tree` with `row` right under the hint line. The engine draws its line
 * over a tree's first row, and another mod's drawing may hold the line's
 * place first with rows of its own after it: `row` goes in right after that
 * place, so what the others drew stays where it was.
 */
export const under = (tree: RenderNode, row: RenderElement): RenderElement => {
  if (typeof tree === 'string' || tree.type !== 'Box' || tree.children === undefined) {
    return { type: 'Box', props: { flexDirection: 'column' }, children: [tree, row] }
  }

  const [first, ...rest] = tree.children
  const isLine = typeof first === 'string' || first?.type !== 'Box'

  if (first === undefined) {
    return { ...tree, children: [row] }
  }

  if (tree.props?.flexDirection === 'column' && isLine) {
    return { ...tree, children: [first, row, ...rest] }
  }

  return { ...tree, children: [under(first, row), ...rest] }
}

/**
 * `tree` with the label's `row`. Where another mod has already drawn a row
 * of its own right under the hint line, the label joins that row at its end,
 * so two mods take one row between them; else it gets a row of its own.
 */
export const beside = (tree: RenderNode, row: RenderElement): RenderElement => {
  if (typeof tree === 'string' || tree.type !== 'Box' || tree.children === undefined) {
    return under(tree, row)
  }

  const [first, second, ...rest] = tree.children
  const isLine = typeof first === 'string' || first?.type !== 'Box'

  if (
    tree.props?.flexDirection !== 'column' ||
    !isLine ||
    first === undefined ||
    second === undefined ||
    typeof second === 'string' ||
    second.type !== 'Box' ||
    second.props?.flexDirection === 'column' ||
    second.children === undefined
  ) {
    return under(tree, row)
  }

  return { ...tree, children: [first, { ...second, children: [...second.children, row] }, ...rest] }
}

/** One shell command of a transcript's group of tool calls, as its row says it. */
export type CallRow = {
  /** The call's id. */
  id: string
  status: Job['status']
  title: string
  /** `8s`; empty where it is not known, or under a second. */
  span: string
}

/** How many calls of a group get a row; the rest are counted. */
const GROUP_ROWS = 4
const GROUP_TITLE_CELLS = 56

/**
 * `line`, the transcript's own row for a group of tool calls, with a row
 * under it for each shell command of the group: its mark, what it does and
 * how long it ran. A press on a title opens the pane at that command.
 *
 *     Ran 3 shell commands
 *       ✓ Check the version           2s
 *       ✗ Verify the profile          8s
 */
export const groupTree = (
  kit: Kit,
  line: RenderElement,
  rows: readonly CallRow[],
  onPress: (row: CallRow) => void,
): RenderElement => {
  const { Box, Text, Button } = kit
  const more = rows.length - GROUP_ROWS

  return (
    <Box flexDirection="column">
      {line}
      {rows.slice(0, GROUP_ROWS).map((row) => (
        <Box columnGap={2} paddingLeft={2}>
          <Box columnGap={1}>
            <Text color={COLORS[row.status]} dimColor={row.status === 'ended'}>
              {GLYPHS[row.status]}
            </Text>
            <Button
              key={`call:${row.id}`}
              plain
              dimColor={row.status === 'done'}
              label={fitted(row.title, GROUP_TITLE_CELLS)}
              onPress={() => {
                onPress(row)
              }}
            />
          </Box>
          {row.span !== '' && <Text dimColor>{row.span}</Text>}
        </Box>
      ))}
      {more > 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>{`+${more} more`}</Text>
        </Box>
      )}
    </Box>
  )
}
