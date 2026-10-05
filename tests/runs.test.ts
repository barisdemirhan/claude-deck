import { expect, test } from 'claude-code/testing'

import {
  activeOf,
  opened,
  planned,
  rowsOf,
  runOf,
  stepped,
  stopped,
  taskCreated,
  taskUpdated,
} from '../hooks/runs'

const TEXT = [
  '- Token rotation',
  '  - Write it',
  '  - Test it',
  '- Session cleanup',
  '    1. Move the table',
  '        * Copy the rows',
  '        * Drop the old one',
  '    2. Remove the cron',
  'Documentation',
].join('\n')

const plan = (id = 'r1', at = 0) => runOf(id, 'Auth renewal', 'plan', '', '', planned(TEXT), at)

/** The run after each `id word` change, a second apart. */
const after = (changes: readonly string[]) =>
  changes.reduce((run, change, index) => {
    const [id = '', word = ''] = change.split(' ')
    const turned = stepped(run, id, word === 'start' || word === 'fail' ? word : 'done', (index + 1) * 1000)

    return turned.run ?? run
  }, plan())

test('each line of a plan gets its id from its place, whatever the indent and the bullets', async () => {
  expect(planned(TEXT).map((step) => `${step.id} ${step.title}`)).toEqual([
    '1 Token rotation',
    '1.1 Write it',
    '1.2 Test it',
    '2 Session cleanup',
    '2.1 Move the table',
    '2.1.1 Copy the rows',
    '2.1.2 Drop the old one',
    '2.2 Remove the cron',
    '3 Documentation',
  ])
  expect(planned(' \n')).toEqual([])
})

test('a branch under way is open, one not begun or over is folded, and counts come from the leaves', async () => {
  const run = after(['2.1.1 start', '1.1 start', '1.2 start'])
  const rows = rowsOf(run, {}, 10_000, true).map(
    (row) => `${'  '.repeat(row.depth)}${row.isOpen ? '▾' : '·'} ${row.title} ${row.status} ${row.count}`,
  )

  expect(rows).toEqual([
    '▾ Auth renewal running 1/6',
    // 1.2 is still running, so the branch is under way and stays open.
    '  ▾ Token rotation running 1/2',
    '    · Write it done ',
    '    · Test it running ',
    '  ▾ Session cleanup running 0/3',
    '    ▾ Move the table running 0/2',
    '      · Copy the rows running ',
    '      · Drop the old one pending ',
    '    · Remove the cron pending ',
    '  · Documentation pending ',
  ])
})

test('a finished branch folds by itself and the person\'s fold stands over that', async () => {
  const run = after(['1.1 done', '1.2 done', '2.2 start'])
  const titles = (folds: Record<string, boolean>) =>
    rowsOf(run, folds, 10_000, true).map((row) => row.title)

  expect(titles({})).not.toContain('Write it')
  expect(titles({ 'r1/1': true })).toContain('Write it')
  expect(titles({ r1: false })).toEqual(['Auth renewal'])
  // A run that is not the one under way shows as its one row.
  expect(rowsOf(run, {}, 10_000, false).length).toBe(1)
})

test('starting a step in the next branch ends the one left running in the branch before', async () => {
  const run = after(['1.1 start', '1.2 start', '2.2 start'])
  const state = (id: string) => run.steps.find((step) => step.id === id)?.status

  expect([state('1.1'), state('1.2'), state('2.2')]).toEqual(['done', 'done', 'running'])
  // A step started out of order leaves the later one running.
  expect(after(['2.2 start', '1.1 start']).steps.find((step) => step.id === '2.2')?.status).toBe('running')
})

test('when its agent ends, a run stops: its clock holds and the step left running waits again', async () => {
  const run = { ...after(['1.1 start']), loop: 'agent-1' }
  const [left] = stopped([run], 'agent-1', 5_000)
  const rows = rowsOf(left ?? run, { r1: true }, 900_000, false)

  expect(left?.steps.find((step) => step.id === '1.1')?.status).toBe('pending')
  expect(rows[0]?.span).toBe('4s')
  expect(activeOf(stopped([run], 'agent-1', 5_000))).toBeUndefined()
  // Another loop's run goes on.
  expect(activeOf(stopped([run], 'agent-2', 5_000))?.id).toBe('r1')
})

test('a failed step marks every branch above it, the run too', async () => {
  const rows = rowsOf(after(['2.1.1 fail']), { 'r1/2': false }, 10_000, true)

  expect(rows.find((row) => row.title === 'Session cleanup')?.status).toBe('failed')
  expect(rows[0]?.status).toBe('failed')
  expect(rows.find((row) => row.title === 'Token rotation')?.status).toBe('pending')
})

test('the mod keeps the time: a step\'s from its start to its end, a branch\'s over its leaves', async () => {
  const run = after(['1.1 start', '1.2 start', '1.2 done'])
  const rows = rowsOf(run, { 'r1/1': true }, 60_000, true)

  expect(rows.find((row) => row.title === 'Write it')?.span).toBe('1s')
  expect(rows.find((row) => row.title === 'Token rotation')?.span).toBe('2s')
  // The run is not over: its clock runs on.
  expect(rows[0]?.span).toBe('59s')
  expect(rows.find((row) => row.title === 'Documentation')?.span).toBe('')
})

test('the newest unfinished run is the active one, and finished runs go first when there are too many', async () => {
  const runs = Array.from({ length: 7 }, (_, index) => plan(`r${index}`, index)).reduce(
    (left, run) => opened(left, run),
    [stepped(runOf('old', 'Done', 'plan', '', '', planned('Only'), 0), '1', 'done', 1).run ?? plan('old')],
  )

  expect(runs.map((run) => run.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'])
  expect(activeOf(runs)?.id).toBe('r6')
})

test('a task list is one flat run a loop, and a deleted task leaves it', async () => {
  const mint = () => 'tasks-1'
  const made = ['Read', 'Fix'].reduce(
    (left, subject, index) => taskCreated(left, '', '', String(index + 1), subject, 0, mint),
    taskCreated([], 'agent-1', 'general-purpose', '1', 'Deploy', 0, () => 'tasks-a'),
  )
  expect(made.map((run) => `${run.id} ${run.owner} ${run.steps.length}`)).toEqual([
    'tasks-a general-purpose 1',
    'tasks-1  2',
  ])

  const moved = taskUpdated(taskUpdated(made, '', '1', { status: 'in_progress' }, 5), '', '2', { status: 'deleted' }, 6)
  expect(moved[1]?.steps).toEqual([{ id: '1', title: 'Read', status: 'running', startedAt: 5, endedAt: 0 }])
  // The other loop's task of the same id is untouched.
  expect(moved[0]?.steps[0]?.status).toBe('pending')
})
