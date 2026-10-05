import { expect, test } from 'claude-code/testing'

import {
  EMPTY_MS,
  checksOf,
  givenUp,
  homeOf,
  pathsOf,
  polled,
  summaryOf,
  targetOf,
  watched,
} from '../hooks/checks'
import { runOf } from '../hooks/runs'
import type { Watch } from '../types'

const HOME = { host: 'github.com', repo: 'acme/shop' }
const WATCH: Watch = {
  run: 'r1',
  kind: 'ref',
  ...HOME,
  target: 'main',
  url: 'https://github.com/acme/shop/commits/main',
  wake: false,
  startedAt: 0,
  settled: 0,
  failures: 0,
}

test('a remote names its repository, whichever way git spells it', async () => {
  for (const remote of [
    'https://github.com/acme/shop.git',
    'git@github.com:acme/shop.git',
    'ssh://git@github.com/acme/shop',
    'https://token@github.com/acme/shop/',
  ]) {
    expect(homeOf(remote)).toEqual(HOME)
  }

  expect(homeOf('git@git.corp.example:team/api.v2.git')).toEqual({ host: 'git.corp.example', repo: 'team/api.v2' })
  expect(homeOf(null)).toBeUndefined()
  expect(homeOf('/srv/git/shop.git')).toBeUndefined()
})

test('the words name a pull request, a workflow run, a branch or a commit', async () => {
  const named = (words: string, branch = '') => {
    const target = targetOf(words, HOME, branch)

    return 'error' in target ? target.error : `${target.kind} ${target.repo} ${target.target}`
  }

  expect(named('12')).toBe('ref acme/shop pull/12/head')
  expect(named('#12')).toBe('ref acme/shop pull/12/head')
  expect(named('37387841808')).toBe('run acme/shop 37387841808')
  expect(named('feature/wallet')).toBe('ref acme/shop feature/wallet')
  expect(named('', 'main\n')).toBe('ref acme/shop main')
  expect(named('https://github.com/cli/cli/pull/14602/files')).toBe('ref cli/cli pull/14602/head')
  expect(named('https://github.com/cli/cli/actions/runs/37387841808/job/1')).toBe('run cli/cli 37387841808')
  expect(named('https://github.com/cli/cli/tree/release/2.x')).toBe('ref cli/cli release/2.x')
  expect(named('https://github.com/cli/cli/commit/cfe1130')).toBe('ref cli/cli cfe1130')
  expect(named('', 'HEAD')).toContain('Name what to watch')
  expect(named('https://example.com/a/b')).toContain('no pull request')

  const homeless = targetOf('12', undefined, '')
  expect('error' in homeless && homeless.error).toContain('no GitHub remote')
  expect(pathsOf({ kind: 'ref', repo: 'acme/shop', target: 'feature/wallet' })[0]).toBe(
    'repos/acme/shop/commits/feature%2Fwallet/check-runs?per_page=100',
  )
})

test("a commit's check runs and statuses are its checks, each with its state", async () => {
  const found = checksOf(
    'ref',
    {
      check_runs: [
        { name: 'test', status: 'completed', conclusion: 'success' },
        { name: 'e2e', status: 'completed', conclusion: 'timed_out' },
        { name: 'docs', status: 'completed', conclusion: 'skipped' },
        { name: 'build', status: 'in_progress', conclusion: null },
        { name: 'ship', status: 'queued', conclusion: null },
      ],
    },
    { statuses: [{ context: 'vercel', state: 'error' }] },
  )

  expect(found.checks.map((check) => `${check.title}: ${check.status}`)).toEqual([
    'test: done',
    'e2e (timed out): failed',
    'docs (skipped): done',
    'build: running',
    'ship: pending',
    'vercel: failed',
  ])
  expect(found.isOver).toBe(false)
  expect(checksOf('ref', { check_runs: [] }, { statuses: [] }).isOver).toBe(false)
  expect(checksOf('ref', 'not json', undefined).checks).toEqual([])
})

test('a run waits for its first check, then ends once every check stays over', async () => {
  const empty = runOf('r1', 'Checks · main', 'checks', 'watch:r1', '', [], 0)
  const none = checksOf('ref', {}, {})
  const waiting = watched(empty, none, 1000)
  expect(waiting.steps.map((step) => step.title)).toEqual(['Waiting for checks'])
  // Nothing moved: the run is the same one, not touched again.
  expect(watched(waiting, none, 2000)).toBe(waiting)
  expect(givenUp(WATCH, waiting, EMPTY_MS - 1)).toBeUndefined()
  expect(givenUp(WATCH, waiting, EMPTY_MS)).toBe('no check showed up')
  expect(givenUp({ ...WATCH, failures: 5 }, waiting, 0)).toBe('GitHub did not answer')

  const over = checksOf('ref', { check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }] }, {})
  const once = polled(WATCH, over)
  expect(once?.settled).toBe(1)
  // A later workflow added a check: the count starts over.
  expect(polled(once ?? WATCH, checksOf('ref', { check_runs: [{ name: 'ship', status: 'queued' }] }, {}))?.settled).toBe(0)
  expect(polled(once ?? WATCH, over)).toBeUndefined()
  // A workflow run is over when GitHub says so.
  expect(polled({ ...WATCH, kind: 'run' }, checksOf('run', { status: 'completed' }, { jobs: [] }))).toBeUndefined()

  expect(summaryOf(watched(waiting, over, 3000), WATCH.url)).toBe(
    'The GitHub checks of "Checks · main" are over: 0 passed, 1 failed.\n✗ test\nhttps://github.com/acme/shop/commits/main',
  )
})
