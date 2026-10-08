// What the label and the pane say, as text.

import type { Job, Meter, Work } from '../types'

import { effortText, modelName } from './meter'

const two = (count: number): string => String(count).padStart(2, '0')

/** `48s`, `1m 12s`, `14m 03s`, `1h 04m`. */
export const spanText = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)

  if (minutes === 0) {
    return `${seconds}s`
  }

  return minutes < 60
    ? `${minutes}m ${two(seconds % 60)}s`
    : `${Math.floor(minutes / 60)}h ${two(minutes % 60)}m`
}

/** How long the job has run, or ran. */
export const jobSpan = (job: Job, now: number): string =>
  spanText((job.endedAt === 0 ? Math.max(now, job.startedAt) : job.endedAt) - job.startedAt)

export const GLYPHS: Readonly<Record<Job['status'], string>> = {
  running: '⏵',
  done: '✓',
  failed: '✗',
  killed: '■',
  ended: '·',
}

/**
 * The hint line's label: `Fable 5.1 ▰▰▰▱▱ high · ⏵ 3`. The model and its
 * effort once known, then how many shells and agents run, then what the
 * caller adds (a run's progress).
 */
export const labelText = (meter: Meter, work: Work, more: readonly string[] = []): string => {
  const model = [modelName(meter.model), effortText(meter)].filter((part) => part !== '')
  // A shell Claude Code asks the person about is not counted as running.
  const running = work.running.filter((job) => !job.isAsking).length
  const parts = [
    model.join(' '),
    running > 0 ? `${GLYPHS.running} ${running}` : '',
    ...more,
  ].filter((part) => part !== '')

  return parts.length === 0 ? '✻ deck' : parts.join(' · ')
}
