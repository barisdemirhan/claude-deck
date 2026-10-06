// The model's name and the effort meter, as the label and the pane show them.

import type { Meter } from '../types'

export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * The longest level's name, in cells. A button that names the level is drawn
 * this wide at every level: one that shrank from `xhigh` to `max` would leave
 * the pointer that pressed it on the cells after it, and the next press on
 * nothing.
 */
export const LEVEL_CELLS = Math.max(...LEVELS.map((level) => level.length))

export const NO_METER: Meter = {
  model: '',
  effort: '',
  isSeen: false,
  wanted: '',
  over: '',
  context: -1,
  cost: -1,
  limits: [],
}

const FULL = '▰'
const EMPTY = '▱'

/** `filled` of `cells` cells, as `▰▰▰▱▱`. */
export const barOf = (filled: number, cells: number): string => {
  const count = Math.max(0, Math.min(cells, Math.round(filled)))

  return FULL.repeat(count) + EMPTY.repeat(cells - count)
}

/**
 * A model id as a name: `claude-fable-5-1` is `Fable 5.1`,
 * `claude-haiku-4-5-20251001` is `Haiku 4.5`, `sonnet[1m]` is `Sonnet 1M`.
 */
export const modelName = (id: string): string => {
  const [base = '', window = ''] = id.trim().replace(/\]$/, '').split('[')
  const parts = base
    .replace(/^.*\//, '')
    .replace(/^(us|eu|apac|global)\./, '')
    .replace(/^anthropic\./, '')
    .replace(/^claude-/, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .split(/[-_@:]/)
    .filter((part) => part !== '' && !/^\d{6,}$/.test(part))
  const words = parts.filter((part) => !/^\d+$/.test(part))
  const numbers = parts.filter((part) => /^\d+$/.test(part))
  const name = [
    words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' '),
    numbers.join('.'),
    window.toUpperCase(),
  ]

  return name.filter((part) => part !== '').join(' ')
}

/** The effort in force: the click's while one stands, else Claude Code's own. */
export const effortOf = (meter: Meter): string => meter.wanted || meter.effort

/** True while the deck sets the effort, not Claude Code. */
export const isHeld = (meter: Meter): boolean => meter.wanted !== ''

/** True where a click can change the effort: a model that takes one, seen at work. */
export const canStep = (meter: Meter): boolean => meter.isSeen && meter.effort !== ''

/** `▰▰▰▱▱ high`; a budget in tokens reads as its number; empty with no effort. */
export const effortText = (meter: Meter): string => {
  const effort = effortOf(meter)
  const level = LEVELS.indexOf(effort)

  if (effort === '') {
    return ''
  }

  return level < 0 ? `effort ${effort}` : `${barOf(level + 1, LEVELS.length)} ${effort}`
}

/**
 * The effort's color, cooler to warmer as the level rises: low is dim, then
 * green, yellow, orange and red for max. A budget in tokens has none.
 */
export const effortColor = (meter: Meter): string | undefined =>
  [undefined, 'success', 'warning', 'claude', 'error'][LEVELS.indexOf(effortOf(meter))]

/** `ctx ▰▰▱▱▱▱▱▱ 23%`; empty before the window's fill is known. */
export const contextText = (meter: Meter): string =>
  meter.context < 0 ? '' : `ctx ${barOf((meter.context / 100) * 8, 8)} ${Math.round(meter.context)}%`

const WINDOWS: Readonly<Record<string, string>> = {
  five_hour: '5h',
  seven_day: '7d',
  spend_limit: 'spend',
}

/** `$1.24 · 5h 34% · 7d 12%`: the session's cost and each limit's fill; empty with neither. */
export const usageText = (meter: Meter): string =>
  [
    meter.cost < 0 ? '' : `$${meter.cost.toFixed(2)}`,
    ...meter.limits.map(
      (limit) => `${WINDOWS[limit.kind] ?? limit.kind} ${Math.round(limit.percent)}%`,
    ),
  ]
    .filter((part) => part !== '')
    .join(' · ')

/** True once a limit is nearly used up. */
export const isTight = (meter: Meter): boolean => meter.limits.some((limit) => limit.percent >= 80)

/**
 * The meter set to `level` by the person. Claude Code's own level hands the
 * effort back to it, as does no level at all.
 */
export const held = (meter: Meter, level: string): Meter =>
  level === '' || level === meter.effort
    ? { ...meter, wanted: '', over: '' }
    : { ...meter, wanted: level, over: meter.effort }

/** One step up from the effort in force, and from `max` back to `low`. */
export const stepped = (meter: Meter): Meter =>
  canStep(meter)
    ? held(meter, LEVELS[(LEVELS.indexOf(effortOf(meter)) + 1) % LEVELS.length] ?? '')
    : meter

/**
 * The meter after a request of the main thread that named this model and
 * effort. An effort other than the one the click was made over is `/effort`,
 * or another model: the click's level is dropped.
 */
export const seen = (meter: Meter, model: string, effort: string): Meter => {
  const isChanged = meter.wanted !== '' && meter.over !== '' && effort !== meter.over
  const wanted = isChanged || effort === '' || meter.wanted === effort ? '' : meter.wanted

  return { ...meter, model, effort, isSeen: true, wanted, over: wanted === '' ? '' : effort }
}

export const isSameMeter = (one: Meter, other: Meter): boolean =>
  one.model === other.model &&
  one.effort === other.effort &&
  one.isSeen === other.isSeen &&
  one.wanted === other.wanted &&
  one.over === other.over &&
  one.context === other.context &&
  one.cost === other.cost &&
  one.limits.length === other.limits.length &&
  one.limits.every(
    (limit, index) =>
      limit.kind === other.limits[index]?.kind && limit.percent === other.limits[index]?.percent,
  )
