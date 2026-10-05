import { expect, test } from 'claude-code/testing'

import type { Job } from '../types'

import {
  NO_WORK,
  backgrounded,
  ended,
  reported,
  revived,
  settled,
  shellTitle,
  started,
  timed,
} from '../hooks/work'

const shell = (id: string, startedAt = 0): Job => ({
  id,
  kind: 'shell',
  title: id,
  startedAt,
  endedAt: 0,
  status: 'running',
  taskId: '',
  detail: '',
  model: '',
  effort: '',
  owner: '',
})

test('a shell is named by what it says it does, else by its command\'s first line', async () => {
  expect(shellTitle('Run the tests', 'npm test')).toBe('Run the tests')
  expect(shellTitle(undefined, '  npm   run build\necho done')).toBe('npm run build')
  expect(shellTitle('', 'x'.repeat(200)).length).toBe(80)
})

test('a quick foreground command that went well leaves no row; a slow or failed one does', async () => {
  const work = ['quick', 'slow', 'bad'].reduce((left, id) => started(left, shell(id)), NO_WORK)
  const after = ended(ended(ended(work, 'quick', 'done', 500), 'slow', 'done', 4000), 'bad', 'failed', 100)

  expect(after.running).toEqual([])
  expect(after.recent.map((job) => `${job.id} ${job.status}`)).toEqual(['bad failed', 'slow done'])
})

test('a background shell runs on until its task is reported, and takes the report\'s status', async () => {
  const work = backgrounded(started(NO_WORK, shell('call-1')), 'call-1', 'task-1')
  expect(work.running[0]?.taskId).toBe('task-1')

  const after = reported(work, { taskId: 'task-1', status: 'failed' }, 9000)
  expect(after.running).toEqual([])
  expect(after.recent[0]).toMatchObject({ id: 'call-1', status: 'failed', endedAt: 9000 })
  expect(timed(after, 'task-1', 3000).recent[0]?.endedAt).toBe(3000)
  expect(timed(after, 'task-1', -1).recent[0]?.endedAt).toBe(9000)
})

test('a background shell Claude Code no longer lists is closed with no status, which a late report fills in', async () => {
  const two = ['a', 'b'].reduce(
    (left, id) => backgrounded(started(left, shell(id)), id, `task-${id}`),
    started(NO_WORK, shell('front')),
  )
  const after = settled(two, ['task-b'], 5000)

  // The foreground command and the listed task run on.
  expect(after.running.map((job) => job.id)).toEqual(['front', 'b'])
  expect(after.recent[0]).toMatchObject({ id: 'a', status: 'ended' })
  expect(reported(after, { taskId: 'task-a', status: 'done' }, 6000).recent[0]).toMatchObject({
    status: 'done',
    endedAt: 5000,
  })
})

test('only the eight newest ended jobs are kept', async () => {
  const work = Array.from({ length: 10 }, (_, index) => `job-${index}`).reduce(
    (left, id) => ended(started(left, shell(id)), id, 'failed', 1),
    NO_WORK,
  )

  expect(work.recent.length).toBe(8)
  expect(work.recent[0]?.id).toBe('job-9')
})

test('an agent that ended and works again runs on in its row', async () => {
  const agent: Job = { ...shell('agent-1'), kind: 'agent', taskId: 'agent-1' }
  const done = ended(started(NO_WORK, agent), 'agent-1', 'done', 1000)
  const again = revived(done, 'agent-1')

  expect(again.recent).toEqual([])
  expect(again.running[0]).toMatchObject({ id: 'agent-1', status: 'running', endedAt: 0 })
})
