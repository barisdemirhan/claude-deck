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
  /** True where the pane sits above the prompt, a few rows tall, and not beside the conversation. */
  isInline: boolean
  /** A press on the effort meter. */
  onEffort: () => void
  /** Each run as rows, the newest touched first, but for those drawn under their agent. */
  runs: readonly (readonly Row[])[]
  /** The runs a running agent opened, by the agent's id: drawn under its row. */
  nested: Readonly<Record<string, readonly (readonly Row[])[]>>
  /** A press on a run's, a branch's or a cut step's fold mark. */
  onFold: (row: Row) => void
  /** The rows the person opened, by `job:<id>` or `step:<key>`. */
  open: Readonly<Record<string, boolean>>
  /** A press on a shell's or an agent's mark or title: opens and closes its detail. */
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
/** A shell Claude Code asks the person about: its mark, and what stands in for its clock. */
const ASKING = '?'
const ASKING_SPAN = 'waits'
/** How many ended jobs the pane lists above the prompt, where it has a few rows. */
const RECENT_INLINE = 3
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

/** A shell's command, at most eight lines' worth of cells, or an agent's model and effort. */
const detailOf = (job: Job, cells: number): string =>
  job.kind === 'shell'
    ? fitted(`$ ${job.detail}`, Math.max(1, cells) * 8)
    : [modelName(job.model), job.effort === '' ? '' : `${job.effort} effort`]
        .filter((part) => part !== '')
        .join(' · ') || 'agent'

/**
 * `▸ ⏵ Typecheck, test and lint        shell    1m 12s`
 *
 * The mark and title are buttons: a press opens the detail under it, where a
 * job that runs in the background has a stop button. Under a running agent's
 * row come the shells and agents it started and the run it opened. Where the
 * section's name says the kind, the kind's column is left out.
 */
/** A title cut to the cells it has, so a row stays one line: a button's label does not cut itself. */
const fitted = (title: string, cells: number): string => {
  const letters = [...title]

  return letters.length > cells ? `${letters.slice(0, Math.max(0, cells - 1)).join('')}…` : title
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
  // The row's cells less its fold and state marks, its indent and its columns at the right.
  const room =
    view.columns - 2 * PAD - 4 - 2 * indent - SPAN_CELLS - (hasKind ? KIND_CELLS : 0) - 1
  const title = fitted(job.title, room)
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
          <Button
            key={`job-mark:${job.id}`}
            plain
            label={isOpen ? '▾' : '▸'}
            onPress={() => {
              view.onJob(job)
            }}
          />
        </Box>
        <Box width={2} flexShrink={0}>
          <Text color={job.isAsking ? 'warning' : COLORS[job.status]} dimColor={job.status === 'ended'}>
            {job.isAsking ? ASKING : GLYPHS[job.status]}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Button
            key={`job:${job.id}`}
            plain
            dimColor={!isOpen && job.status !== 'running' && job.status !== 'failed'}
            label={title}
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
          <Text dimColor={job.status !== 'running' || job.isAsking}>
            {job.isAsking ? ASKING_SPAN : jobSpan(job, view.now)}
          </Text>
        </Box>
      </Box>
      {isOpen && (
        <Box flexDirection="column" paddingLeft={4 + 2 * indent}>
          {title !== job.title && <Text wrap="wrap">{job.title}</Text>}
          <Text dimColor wrap="wrap">
            {detailOf(job, view.columns - 2 * PAD - 4 - 2 * indent)}
          </Text>
          {canStop && (
            <Box>
              <Button
                key={`stop:${job.id}`}
                plain
                label="■ stop"
                onPress={() => {
                  view.onStop(job)
                }}
              />
            </Box>
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
 * context's fill; under them the session's cost and its limits. Above the
 * prompt, where the pane has a few rows, the cost and the limits share the
 * first row while it has room.
 */
const head = (kit: Kit, view: PaneView): RenderElement => {
  const { Box, Text, Button } = kit
  const { meter } = view
  const effort = effortText(meter)
  const context = contextText(meter)
  const usage = usageText(meter)
  const spent = (
    <Text color={isTight(meter) ? 'warning' : undefined} dimColor={!isTight(meter)} wrap="truncate-end">
      {usage}
    </Text>
  )

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
        {view.isInline && usage !== '' && spent}
        {context !== '' && <Text dimColor={meter.context < 80}>{context}</Text>}
      </Box>
      {!view.isInline && usage !== '' && spent}
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
 * when folded before its start or after its end. A leaf whose title is cut
 * opens to the full title; a leaf that fits keeps its state mark alone.
 *
 * `▾ Auth renewal                 ▰▰▰▰▰▱▱▱ 5/8   12m 40s`
 * `    ✓ Move the old table                        1m 30s`
 */
const stepRow = (kit: Kit, row: Row, view: PaneView, indent = 0): RenderElement => {
  const { Box, Text, Button } = kit
  const isQuiet = row.status === 'done' || row.status === 'pending'
  const folded = row.status === 'running' || row.kind === 'run' ? '▸' : STEP_GLYPHS[row.status]
  // A run folded away still says how it stands, beside its mark.
  const state = row.kind === 'run' && (row.status === 'done' || row.status === 'failed')
  const hasMeter = row.meter !== '' && view.columns >= BAR_FROM
  const inset = 2 * (row.depth + indent)
  const room =
    view.columns - 2 * PAD - inset - 2 - (state ? 2 : 0) - COUNT_CELLS -
    SPAN_CELLS - (hasMeter ? METER_CELLS : 0) - 1
  const isCut = row.kind === 'leaf' && fitted(row.title, room) !== row.title
  const key = `step:${row.key}`
  const isOpen = isCut && view.open[key] === true
  const onPress = () => {
    view.onFold({ ...row, key, isOpen })
  }
  const mark =
    isCut ? (
      <Button key={`step-mark:${row.key}`} plain label={isOpen ? '▾' : '▸'} onPress={onPress} />
    ) : row.kind === 'leaf' ? (
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

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={inset} flexShrink={0} />
        <Box width={2} flexShrink={0}>
          {mark}
        </Box>
        {(state || isCut) && (
          <Box width={2} flexShrink={0}>
            <Text color={STEP_COLORS[row.status]} dimColor={row.status === 'pending'}>
              {STEP_GLYPHS[row.status]}
            </Text>
          </Box>
        )}
        <Box flexGrow={1} flexShrink={1}>
          {isCut ? (
            <Button
              key={key}
              plain
              dimColor={!isOpen && isQuiet}
              label={fitted(row.title, room - 2)}
              onPress={onPress}
            />
          ) : (
            <Text
              bold={row.kind === 'run'}
              color={row.status === 'failed' ? STEP_COLORS.failed : undefined}
              dimColor={row.kind !== 'run' && isQuiet}
              wrap="truncate-end"
            >
              {row.title}
            </Text>
          )}
        </Box>
        {hasMeter && (
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
      {isOpen && (
        <Box paddingLeft={inset + 4}>
          <Text wrap="wrap">{row.title}</Text>
        </Box>
      )}
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
  // Above the prompt the newest few ended jobs are listed, and the rest counted.
  const recent = view.isInline ? work.recent.slice(0, RECENT_INLINE) : work.recent
  const hidden = work.recent.length - recent.length
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
      {work.recent.length > 0 &&
        section(kit, 'RECENT', hidden > 0 ? <Text dimColor>{`+${hidden} more`}</Text> : blank, recent, view)}
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
  /** The run under way, `Auth renewal`, and its count, `5/8`; both empty with none. */
  runTitle: string
  runCount: string
  /** How many cells of the run's title show. */
  runCells: number
  /** True when a step of that run failed. */
  isFailed: boolean
  /**
   * A press on the deck's mark, or on the run: opens or closes the pane. Its
   * promise goes back to the press, so the pane it opens is the person's ask.
   */
  onPress: () => Promise<void>
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
  const run = runLabel(view)

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
      {run !== '' && dot}
      {run !== '' && view.isFailed && <Text color={COLORS.failed}>{GLYPHS.failed}</Text>}
      {run !== '' && <Button key="deck-run" plain dimColor label={run} onPress={view.onPress} />}
      <Button key="deck-row-close" plain dimColor label="×" onPress={view.onClose} />
    </Box>
  )
}

/** The run as the label shows it: `Auth renewal 5/8`, its title cut to its cells. */
const runLabel = (view: LabelView): string =>
  view.runTitle === '' ? '' : `${fitted(view.runTitle, view.runCells)} ${view.runCount}`

const widthOf = (text: string): number => [...text].length

/** The cells the label's row takes, as `labelRow` draws it: its parts, a cell between each. */
export const labelCells = (view: LabelView): number => {
  const run = runLabel(view)
  const parts = [
    1,
    widthOf(view.head),
    widthOf(view.bar),
    view.bar === '' ? 0 : view.canStep ? LEVEL_CELLS : widthOf(view.level),
    view.running > 0 ? 1 : 0,
    view.running > 0 ? widthOf(`${GLYPHS.running} ${view.running}`) : 0,
    run === '' ? 0 : 1,
    run !== '' && view.isFailed ? 1 : 0,
    widthOf(run),
    1,
  ].filter((cells) => cells > 0)

  return parts.reduce((sum, cells) => sum + cells, 0) + parts.length - 1
}

/** The fewest cells of a run's title the label keeps before it leaves the run out. */
const RUN_MIN_CELLS = 6

/**
 * The label fitted to `room` cells, so its run and its `×` are not pushed
 * past the screen's edge: the run's title is cut first, then the model's
 * name goes, then the run. What still does not fit is drawn as it is.
 */
export const fittedLabel = (view: LabelView, room: number): LabelView => {
  const over = labelCells(view) - room

  if (over <= 0) {
    return view
  }

  const shown = Math.min(view.runCells, widthOf(view.runTitle))

  if (view.runTitle !== '' && shown - over >= RUN_MIN_CELLS) {
    return { ...view, runCells: shown - over }
  }

  if (view.head !== '') {
    return fittedLabel({ ...view, head: '' }, room)
  }

  return view.runTitle === '' ? view : fittedLabel({ ...view, runTitle: '', runCount: '' }, room)
}

/** The cells a drawn row takes, near enough: its text, and its gaps where it is a row. */
const cellsOf = (node: RenderNode): number => {
  if (typeof node === 'string') {
    return widthOf(node)
  }

  if (node.type === 'Button') {
    return widthOf(node.props.label)
  }

  if (node.type === 'Text') {
    return (node.children ?? []).map(cellsOf).reduce((sum: number, cells: number) => sum + cells, 0)
  }

  if (node.type !== 'Box') {
    return 0
  }

  const kids: number[] = (node.children ?? []).map(cellsOf)

  if (node.props?.flexDirection === 'column') {
    return Math.max(0, ...kids)
  }

  const gap = typeof node.props?.columnGap === 'number' ? node.props.columnGap : 0

  return kids.reduce((sum, cells) => sum + cells, 0) + gap * Math.max(0, kids.length - 1)
}

/**
 * The cells of the row another mod drew under the hint line, which the
 * label joins as `beside` puts it, with its gap; 0 where the label gets a
 * row of its own.
 */
export const besideCells = (tree: RenderNode): number => {
  if (typeof tree === 'string' || tree.type !== 'Box' || tree.children === undefined) {
    return 0
  }

  const [first, second] = tree.children
  const isLine = typeof first === 'string' || first?.type !== 'Box'

  if (
    tree.props?.flexDirection !== 'column' ||
    !isLine ||
    second === undefined ||
    typeof second === 'string' ||
    second.type !== 'Box' ||
    second.props?.flexDirection === 'column' ||
    second.children === undefined
  ) {
    return 0
  }

  const gap = typeof second.props?.columnGap === 'number' ? second.props.columnGap : 0

  return cellsOf(second) + gap
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
  /** True while Claude Code asks the person whether it may run. */
  isAsking: boolean
  title: string
  /** `8s`; empty where it is not known, or under a second. */
  span: string
}

/** How many calls of a group get a row; the rest are counted. */
const GROUP_ROWS = 4
const GROUP_TITLE_CELLS = 56
/** A group row's cells but its title: its indent, mark, gaps and the longest time, `14m 03s`. */
const GROUP_FIXED_CELLS = 13
const GROUP_MIN_CELLS = 12

/**
 * `line`, the transcript's own row for a group of tool calls, with a row
 * under it for each shell command of the group: its mark, what it does and
 * how long it ran. A press on a title opens the pane at that command; its
 * promise goes back to the press, so the pane it opens is the person's ask.
 *
 *     Ran 3 shell commands
 *       ✓ Check the version           2s
 *       ✗ Verify the profile          8s
 *
 * A title is cut to what the conversation's `columns` leave it, and to 56
 * cells at most.
 */
export const groupTree = (
  kit: Kit,
  line: RenderElement,
  rows: readonly CallRow[],
  onPress: (row: CallRow) => Promise<void>,
  columns = Number.POSITIVE_INFINITY,
): RenderElement => {
  const { Box, Text, Button } = kit
  const more = rows.length - GROUP_ROWS
  const cells = Math.max(GROUP_MIN_CELLS, Math.min(GROUP_TITLE_CELLS, columns - GROUP_FIXED_CELLS))

  return (
    <Box flexDirection="column">
      {line}
      {rows.slice(0, GROUP_ROWS).map((row) => (
        <Box columnGap={2} paddingLeft={2}>
          <Box columnGap={1}>
            <Text color={row.isAsking ? 'warning' : COLORS[row.status]} dimColor={row.status === 'ended'}>
              {row.isAsking ? ASKING : GLYPHS[row.status]}
            </Text>
            <Button
              key={`call:${row.id}`}
              plain
              dimColor={row.status === 'done'}
              label={fitted(row.title, cells)}
              onPress={() => onPress(row)}
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
