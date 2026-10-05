import { expect, test } from 'claude-code/testing'

import { NO_METER, effortText, held, modelName, seen, stepped } from '../hooks/meter'
import { labelText, spanText } from '../hooks/view'
import { NO_WORK } from '../hooks/work'

test('a model id reads as its name', async () => {
  expect(modelName('claude-fable-5-1')).toBe('Fable 5.1')
  expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelName('us.anthropic.claude-sonnet-5-5-v1:0')).toBe('Sonnet 5.5')
  expect(modelName('sonnet[1m]')).toBe('Sonnet 1M')
  expect(modelName('')).toBe('')
})

test('a click steps the effort up, past max to low, and Claude Code\'s own level hands it back', async () => {
  const high = seen(NO_METER, 'claude-fable-5-1', 'high')
  const xhigh = stepped(high)
  expect(xhigh.wanted).toBe('xhigh')
  expect(effortText(xhigh)).toBe('▰▰▰▰▱ xhigh')

  const low = stepped(stepped(xhigh))
  expect(low.wanted).toBe('low')

  // low, medium, then high: the level Claude Code itself sends.
  const back = stepped(stepped(low))
  expect(back.wanted).toBe('')
  expect(effortText(back)).toBe('▰▰▰▱▱ high')
})

test('a click does nothing before a request was seen, or on a model without effort', async () => {
  expect(stepped(NO_METER)).toEqual(NO_METER)

  const haiku = seen(NO_METER, 'claude-haiku-4-5-20251001', '')
  expect(stepped(haiku)).toEqual(haiku)
  expect(effortText(haiku)).toBe('')
})

test('/effort takes the meter back from a click', async () => {
  const clicked = held(seen(NO_METER, 'claude-fable-5-1', 'high'), 'max')
  // The next request still carries Claude Code's high: the click stands.
  expect(seen(clicked, 'claude-fable-5-1', 'high').wanted).toBe('max')
  // /effort low changed Claude Code's own: the click is dropped.
  expect(seen(clicked, 'claude-fable-5-1', 'low').wanted).toBe('')
})

test('the label names the model, its effort and what runs', async () => {
  const meter = seen(NO_METER, 'claude-fable-5-1', 'high')
  const job = {
    id: 'a',
    kind: 'shell',
    title: 'Run tests',
    startedAt: 0,
    endedAt: 0,
    status: 'running',
    taskId: '',
    detail: '',
    model: '',
    effort: '',
    owner: '',
  } as const

  expect(labelText(NO_METER, NO_WORK)).toBe('✻ deck')
  expect(labelText(meter, NO_WORK)).toBe('Fable 5.1 ▰▰▰▱▱ high')
  expect(labelText(meter, { running: [job, { ...job, id: 'b' }], recent: [] })).toBe(
    'Fable 5.1 ▰▰▰▱▱ high · ⏵ 2',
  )
})

test('a span reads as the pane shows it', async () => {
  expect(spanText(8_000)).toBe('8s')
  expect(spanText(72_000)).toBe('1m 12s')
  expect(spanText(843_000)).toBe('14m 03s')
  expect(spanText(3_840_000)).toBe('1h 04m')
})
