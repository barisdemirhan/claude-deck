import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const SESSION = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const HINT = {
  plugin: 'deck',
  surface: 'terminal',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const
// The terminal's fullscreen layout, where a pointer can press a button.
const FULLSCREEN = { columns: 120, rows: 40, isFullscreen: true } as const
const PANE = {
  plugin: 'deck',
  component: 'Pane',
  requestId: 'deck',
  props: {
    title: 'Deck',
    isFocused: true,
    bodyColumns: 64,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const
const STEP = { turnId: 'turn-1', index: 0, messageCount: 1 } as const

const said = (args: string) =>
  ({
    command: 'deck',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  }) as const

/**
 * The engine beneath the mod: its clock, the store every session shares, the
 * panes it holds open, what a Bash call answers and the effort each request
 * of the model went out with.
 */
const world = (on: On, entries: Readonly<Record<string, unknown>> = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const store = new Map(Object.entries(entries))
  const panes = new Set<string>()
  const efforts: unknown[] = []
  // What the next Bash call answers, and how long it takes.
  const bash = { result: {} as Record<string, unknown>, isError: false, ms: 0 }
  // The main thread's model, as `/model` set it.
  const model = { id: 'claude-fable-5-1' }
  // A row another mod beneath draws right under the hint line; empty for none.
  const hint = { row: '' }
  const tools: string[] = []
  const toasts: string[] = []
  const stops: string[] = []
  const tasks = { count: 0, prompts: [] as string[] }
  // Whether Claude Code draws a pane it is asked to open, or keeps it waiting.
  // On a narrow terminal it draws only what the person asked for: an open made
  // while their press is answered, and a pane it drew already.
  const seat = { isPlaced: true, isNarrow: false }
  const placed = new Set<string>()
  const person = { presses: 0 }
  // GitHub, as `gh api` and the API itself answer it: each path's JSON, the
  // paths asked each way, and what the mod submitted as a prompt.
  const github = {
    hasGh: true,
    answers: {} as Record<string, unknown>,
    asked: [] as string[],
    fetched: [] as { url: string; token: string }[],
    submitted: [] as string[],
    remote: 'git@github.com:acme/shop.git' as string | null,
    env: {} as Record<string, string>,
  }
  const ran = (exitCode: number, stdout: string, stderr = '') => ({
    value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('process.run', (_$, e) => {
    if (e.argv[0] === 'git') {
      return ran(0, 'main\n')
    }

    if (!github.hasGh) {
      throw new Error('gh: command not found')
    }

    const path = e.argv.at(-1) ?? ''
    const data = github.answers[path]
    github.asked.push(`${e.argv[3]} ${path}`)

    return data === undefined ? ran(1, '', 'gh: Not Found (HTTP 404)\n') : ran(0, JSON.stringify(data))
  })
  on('http.fetch', (_$, e) => {
    const data = github.answers[e.url.replace('https://api.github.com/', '')]
    github.fetched.push({ url: e.url, token: e.init?.headers?.authorization ?? '' })

    return {
      value: { status: data === undefined ? 404 : 200, ok: data !== undefined, headers: {}, text: JSON.stringify(data ?? {}) },
    }
  })
  on('env.get', (_$, e) => ({ value: github.env[e.name] }))
  on('session.repo', () => ({
    value: github.remote === null ? null : { root: '/', remote: github.remote, internal: false, name: null },
  }))
  on('prompt.submit', (_$, e) => {
    github.submitted.push(e.text)

    return { text: e.text }
  })

  // Which keys were read: each read is a read of the store's file.
  const reads: string[] = []
  on('store.get', (_$, e) => {
    reads.push(e.key)

    return { value: store.get(e.key) }
  })
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_$, e) => {
    store.delete(e.key)

    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('classic.Notification', () => ({}))
  on('tool.call', { tool: 'TaskStop' }, (_$, e) => {
    stops.push(e.tool === 'TaskStop' ? (e.task_id ?? '') : '')

    return { result: { message: 'stopped', task_id: stops.at(-1) ?? '', task_type: 'shell' } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.model', () => ({ value: model.id }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, percent: 23 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 34.2 },
        { kind: 'seven_day', percentUsed: 12 },
      ],
      cost: { usd: 1.239 },
    },
  }))
  // A press is the person's ask while its handler runs, the work it hands back included.
  on('ui.press', async (_$, e, next) => {
    person.presses += 1

    try {
      return await next(e)
    } finally {
      person.presses -= 1
    }
  })
  const isSeated = (id: string): boolean => seat.isPlaced && (!seat.isNarrow || placed.has(id))
  on('ui.open', (_$, e) => {
    panes.add(e.id)

    if (seat.isNarrow && person.presses > 0) {
      placed.add(e.id)
    }

    return {
      value: isSeated(e.id)
        ? { isPlaced: true }
        : { isPlaced: false, reason: seat.isNarrow ? '100 columns, 144 needed unasked' : '120 columns, 144 needed' },
    }
  })
  on('ui.close', (_$, e) => {
    panes.delete(e.id)
    placed.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...panes].map((id) => ({
      id,
      title: id,
      isShown: true,
      isFocused: false,
      isPlaced: isSeated(id),
    })),
  }))
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const line = <Text>{e.props.tail ?? ''}</Text>

    return hint.row === '' ? (
      line
    ) : (
      <Box flexDirection="column">
        {line}
        <Box columnGap={2}>
          <Text>{hint.row}</Text>
        </Box>
      </Box>
    )
  })
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{`Ran ${e.props.calls.length} tool calls`}</Text>
  })
  on('ui.render', { component: 'ToolProgress' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text dimColor>{e.props.hint}</Text>
  })
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.text}</Text>
  })
  on('tool.call', { tool: 'Bash' }, async () => {
    if (bash.ms > 0) {
      await clock.sleep(bash.ms)
    }

    return bash.isError
      ? { result: 'failed', isError: true as const }
      : { result: { stdout: '', stderr: '', interrupted: false, ...bash.result } }
  })
  on('turn.step', async function* (_$, e) {
    efforts.push(e.effort)

    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  on('agent.spawn', (_$, e) => {
    tasks.prompts.push(e.prompt)

    return { model: e.parentModel, agentId: 'agent-1' }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'You are Claude.', scope: 'shared' as const }] }))
  on('agent.list', () => ({
    value: [{ id: 'agent-1', description: 'deploy', type: 'general-purpose', status: 'running' as const }],
  }))
  on('tool.register', (_$, e) => {
    tools.push(e.name)

    return { value: { tool: `mcp__deck__${e.name}` } }
  })
  // Claude Code's task list: ids count up from 1.
  on('tool.call', { tool: 'TaskCreate' }, (_$, e) => {
    tasks.count += 1

    return { result: { task: { id: String(tasks.count), subject: e.tool === 'TaskCreate' ? e.subject : '' } } }
  })
  on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => ({
    result: { success: true, taskId: e.tool === 'TaskUpdate' ? e.taskId : '', updatedFields: ['status'] },
  }))

  return {
    clock,
    store,
    reads,
    panes,
    efforts,
    bash,
    tools,
    prompts: tasks.prompts,
    toasts,
    stops,
    model,
    hint,
    seat,
    placed,
    github,
  }
}

const run = async ($: Engine, args: string): Promise<string> =>
  (await $.command.run(said(args))).text ?? ''

/** One request of the main thread, read to its end. */
const step = async ($: Engine, effort?: 'low' | 'high', agentId?: string): Promise<void> => {
  const stream = $.turn.step({ ...STEP, model: 'claude-fable-5-1', effort, agentId })

  for await (const _chunk of stream) {
    // Nothing is read of the chunks.
  }
}

/** A button's label as it reads: the cells that keep its width are left out. */
const face = (label: unknown): string => String(label ?? '').trimEnd()

/** The hint line's tail, as the terminal's main screen draws it. */
const tail = async ($: Engine): Promise<string> => {
  const ui = await $.ui.mount(HINT)
  const text = (await ui.find({ type: 'Text' }))?.text ?? ''
  await ui.unmount()

  return text
}

/** Every text of the pane, on a surface. */
const paneTexts = async (
  $: Engine,
  surface: 'terminal' | 'desktop' = 'terminal',
): Promise<string[]> => {
  const pane = await $.ui.mount({ ...PANE, surface })
  const texts = (await pane.findAll({ type: 'Text' })).map((text) => text.text)
  // A shell's or an agent's title is a button: its label reads as the row's text.
  const titles = (await pane.findAll({ type: 'Button' })).map((button) => String(button.props.label))
  await pane.unmount()

  return [...texts, ...titles]
}

/** A background task's notification row, drawn as Claude Code draws one. */
const notified = async ($: Engine, id: string, status: string, durationMs?: number): Promise<void> => {
  const row = await $.ui.mount({
    plugin: 'deck',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: `row-${id}`,
    props: {
      text: 'A background command ended',
      origin: { kind: 'task-notification' },
      isExpanded: false,
      task: { id, status, durationMs },
    },
  })
  await row.unmount()
}

test('the label shows the model, its effort and what runs, and the pane lists the shell', async ($, on) => {
  const { clock, bash } = world(on)
  await $.session.start(SESSION)
  expect(await tail($)).toBe('Fable 5.1')

  await step($, 'high')
  expect(await tail($)).toBe('Fable 5.1 ▰▰▰▱▱ high')

  bash.ms = 72_000
  const call = $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })
  await clock.advance(10_000)
  expect(await tail($)).toBe('Fable 5.1 ▰▰▰▱▱ high · ⏵ 1')

  for (const surface of ['terminal', 'desktop'] as const) {
    const texts = await paneTexts($, surface)
    expect(texts).toContain('SHELLS · 1')
    expect(texts).toContain('Run the tests')
    expect(texts).toContain('10s')
    expect(texts).toContain('ctx ▰▰▱▱▱▱▱▱ 23%')
  }

  await clock.advance(62_000)
  await call
  expect(await tail($)).toBe('Fable 5.1 ▰▰▰▱▱ high')
  expect(await paneTexts($)).toEqual(expect.arrayContaining(['RECENT', '✓', 'Run the tests', '1m 12s']))
})

test('a failed command is listed as failed', async ($, on) => {
  const { bash } = world(on)
  await $.session.start(SESSION)
  bash.isError = true
  await $.tool.call({ tool: 'Bash', command: 'pytest -k auth' })

  expect(await paneTexts($)).toEqual(expect.arrayContaining(['RECENT', '✗', 'pytest -k auth']))
})

test('a background shell runs on until its notification row says how it ended and how long it ran', async ($, on) => {
  const { clock, bash } = world(on)
  await $.session.start(SESSION)
  bash.result = { backgroundTaskId: 'task-1' }
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
  await clock.advance(30_000)
  expect(await tail($)).toBe('Fable 5.1 · ⏵ 1')

  // The row reaches the screen late: the task says it ran 8 seconds.
  await notified($, 'task-1', 'failed', 8_000)
  await clock.advance(1_000)
  expect(await tail($)).toBe('Fable 5.1')
  expect(await paneTexts($)).toEqual(expect.arrayContaining(['✗', 'npm run dev', '8s']))
})

test('a background shell Claude Code no longer lists when it stops is closed', async ($, on) => {
  const { bash } = world(on)
  await $.session.start(SESSION)
  bash.result = { backgroundTaskId: 'task-1' }
  await $.tool.call({ tool: 'Bash', command: 'sleep 100', run_in_background: true })

  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'task-1', type: 'shell', status: 'running', description: 'sleep 100' }],
  })
  expect(await tail($)).toBe('Fable 5.1 · ⏵ 1')

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  expect(await tail($)).toBe('Fable 5.1')
})

test('a subagent is listed from its spawn to the end of its turn', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'Deploy it',
    description: 'Ship the release',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-fable-5-1',
    background: true,
    fork: false,
  })
  expect(await paneTexts($)).toEqual(
    expect.arrayContaining(['AGENTS · 1', 'general-purpose(Ship the release)']),
  )

  await $.turn.complete({
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    turnId: 'turn-9',
    reason: 'answer',
    agentId: 'agent-1',
  })
  expect(await paneTexts($)).toEqual(expect.arrayContaining(['RECENT', '✓']))
})

test('a press on the meter sends the main thread\'s next requests at the next level, and leaves a subagent\'s alone', async ($, on) => {
  const { efforts } = world(on)
  await $.session.start(SESSION)
  await step($, 'high')

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(face((await pane.find({ key: 'effort' }))?.props.label)).toBe('high ↑')
  // The bar beside it is drawn in its level's color.
  expect((await pane.find({ type: 'Text', text: '▰▰▰▱▱' }))?.props.color).toBe('warning')
  await pane.press({ key: 'effort' })
  expect(face((await pane.find({ key: 'effort' }))?.props.label)).toBe('xhigh ⟳')
  expect((await pane.find({ type: 'Text', text: '▰▰▰▰▱' }))?.props.color).toBe('claude')
  await pane.unmount()

  await step($, 'high')
  await step($, 'high', 'agent-7')
  expect(efforts).toEqual(['high', 'xhigh', 'high'])

  // /effort low: Claude Code's own level changed, and the deck lets go.
  await step($, 'low')
  await step($, 'low')
  expect(efforts.slice(3)).toEqual(['low', 'low'])
  expect(await tail($)).toBe('Fable 5.1 ▰▱▱▱▱ low')
})

test('the label is a button where there is a pointer, and a press opens and closes the pane', async ($, on) => {
  const { panes } = world(on)
  await $.session.start(SESSION)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HINT, surface, viewport: FULLSCREEN })
    // The deck's mark opens the pane; the model's name beside it is plain text.
    expect((await ui.find({ key: 'deck' }))?.props.label).toBe('◨')
    expect(await ui.find({ type: 'Text', text: 'Fable 5.1' })).toBeDefined()
    await ui.press({ key: 'deck' })
    expect([...panes]).toEqual(['deck'])
    await ui.press({ key: 'deck' })
    expect([...panes]).toEqual([])
    await ui.unmount()
  }

  expect(await run($, '')).toBe('Deck pane opened.')
  expect(await run($, '')).toBe('Deck pane closed.')
})

test('/deck close takes the label and the pane away, stops the reading and lets the effort go', async ($, on) => {
  const { store, panes, efforts, bash } = world(on)
  await $.session.start(SESSION)
  await step($, 'high')
  await run($, 'open')
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'effort' })
  await pane.unmount()

  await run($, 'close')
  expect(store.get('closed')).toBe(true)
  expect([...panes]).toEqual([])
  expect(await tail($)).toBe('')

  bash.isError = true
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'Build' })
  await step($, 'high')
  expect(efforts).toEqual(['high', 'high'])

  expect(await run($, '')).toBe('Deck is back, and its pane is open.')
  expect(await paneTexts($)).not.toContain('Build')
})

test('another session\'s /deck close is followed within two seconds', async ($, on) => {
  const { clock, store } = world(on)
  await $.session.start(SESSION)
  expect(await tail($)).toBe('Fable 5.1')

  store.set('closed', true)
  await clock.advance(2_000)
  expect(await tail($)).toBe('')
})

test('the label setting keeps it text, or off', { options: { hintLabel: 'off' } }, async ($, on) => {
  world(on)
  await $.session.start(SESSION)

  const ui = await $.ui.mount({ ...HINT, viewport: FULLSCREEN })
  expect(await ui.find({ key: 'deck' })).toBeUndefined()
  expect((await ui.find({ type: 'Text' }))?.text).toBe('')
  await ui.unmount()
})

const PLAN = [
  'Token rotation',
  '  Write the rotation',
  '  Test it',
  'Session cleanup',
  '  Move the old table',
  '  Remove the cron',
  'Documentation',
].join('\n')

test('Claude Code\'s task list shows as a run, on the label and in the pane', async ($, on) => {
  const { clock } = world(on)
  await $.session.start(SESSION)

  for (const subject of ['Read the code', 'Fix the bug', 'Run the tests']) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: 'Not read by the deck' })
  }

  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await clock.advance(41_000)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
  expect(await tail($)).toBe('Fable 5.1 · Tasks 1/3')

  for (const surface of ['terminal', 'desktop'] as const) {
    const texts = await paneTexts($, surface)
    expect(texts).toEqual(
      expect.arrayContaining(['Tasks', '1/3', 'Read the code', '41s', 'Fix the bug', 'Run the tests']),
    )
    expect(texts).not.toContain('Not read by the deck')
  }

  // A task made after the whole list is over begins a new run.
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'completed' })
  expect(await tail($)).toBe('Fable 5.1')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write it up', description: '' })
  expect(await tail($)).toBe('Fable 5.1 · Tasks 0/1')
})

test('out of the box Claude is given no tool', async ($, on) => {
  const { tools } = world(on)
  await $.session.start(SESSION)

  expect(tools).toEqual([])
})

test(
  'with the tool on, a plan opens a tree that step moves, a leaf at a time',
  { options: { modelTool: true } },
  async ($, on) => {
    const { clock, tools } = world(on)
    await $.session.start(SESSION)
    expect(tools).toEqual(['plan', 'step'])

    const plan = await $.tool.call({ tool: 'mcp__deck__plan', title: 'Auth renewal', steps: PLAN })
    expect(plan.result).toBe(
      [
        'Run r1 is shown, and step 1.1 is started. Call step as you move to the next one.',
        '1 Token rotation',
        '1.1 Write the rotation',
        '1.2 Test it',
        '2 Session cleanup',
        '2.1 Move the old table',
        '2.2 Remove the cron',
        '3 Documentation',
      ].join('\n'),
    )

    // The first step started with the plan.
    await clock.advance(90_000)
    // Starting the next step ends the one before it under the same parent.
    const next = await $.tool.call({ tool: 'mcp__deck__step', id: '1.2', state: 'start' })
    expect(next.result).toBe('1.2 start (1/5 done)')
    expect(await tail($)).toBe('Fable 5.1 · Auth renewal 1/5')

    const texts = await paneTexts($)
    expect(texts).toEqual(
      expect.arrayContaining(['Auth renewal', '▰▰▱▱▱▱▱▱', '1/5', 'Token rotation', '1/2', 'Write the rotation', '1m 30s', 'Test it']),
    )
    // A branch not yet begun is folded: its steps are not drawn.
    expect(texts).toContain('Session cleanup')
    expect(texts).not.toContain('Move the old table')

    // A parent follows its steps and takes no state of its own.
    const parent = await $.tool.call({ tool: 'mcp__deck__step', id: '2', state: 'start' })
    expect(parent.deny).toContain('Update one of: 2.1, 2.2')
    expect((await $.tool.call({ tool: 'mcp__deck__step', id: '9', state: 'done' })).deny).toContain('No step 9')
  },
)

test(
  'a failed step marks the branches above it, and a press folds and unfolds a branch',
  { options: { modelTool: true } },
  async ($, on) => {
    world(on)
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Auth renewal', steps: PLAN })
    await $.tool.call({ tool: 'mcp__deck__step', id: '1.1', state: 'done' })
    await $.tool.call({ tool: 'mcp__deck__step', id: '1.2', state: 'fail' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ ...PANE, surface })
      // The branch is over, so it folded by itself, under its failure's mark.
      expect((await pane.find({ key: 'fold:r1/1' }))?.props.label).toBe('✗')
      expect(await pane.find({ type: 'Text', text: 'Test it' })).toBeUndefined()

      await pane.press({ key: 'fold:r1/1' })
      expect((await pane.find({ key: 'fold:r1/1' }))?.props.label).toBe('▾')
      expect(await pane.find({ type: 'Text', text: 'Test it' })).toBeDefined()

      await pane.press({ key: 'fold:r1/1' })
      await pane.press({ key: 'fold:r1' })
      expect(await pane.find({ type: 'Text', text: 'Token rotation' })).toBeUndefined()
      await pane.press({ key: 'fold:r1' })
      await pane.unmount()
    }
  },
)

test(
  'a run a subagent opens carries its name, and its steps go to its own run',
  { options: { modelTool: true } },
  async ($, on) => {
    world(on)
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Auth renewal', steps: PLAN })
    await $.tool.call({
      tool: 'mcp__deck__plan',
      title: 'Ship the release',
      steps: 'Build\nShip',
      agentId: 'agent-1',
    })
    await $.tool.call({ tool: 'mcp__deck__step', id: '1', state: 'done', agentId: 'agent-1' })
    await $.tool.call({ tool: 'mcp__deck__step', id: '1.1', state: 'start' })

    const texts = await paneTexts($)
    expect(texts).toEqual(expect.arrayContaining(['Ship the release · general-purpose', '1/2', 'Auth renewal', '0/5']))
  },
)

const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'Find the callers',
  description: 'find callers',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-fable-5-1',
  background: false,
  fork: false,
} as const
const COMPOSE = {
  model: 'claude-fable-5-1',
  promptModel: 'claude-fable-5-1',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
} as const

test('out of the box no prompt is changed: not a subagent\'s task, not the system prompt', async ($, on) => {
  const { prompts } = world(on)
  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)

  expect(prompts).toEqual(['Find the callers'])
  expect((await $.prompt.compose(COMPOSE)).sections.map((section) => section.id)).toEqual(['core'])
})

test(
  'with the tool on, every agent is told the tools are there, until the deck is closed',
  { options: { modelTool: true } },
  async ($, on) => {
    const { prompts } = world(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN)
    // A fork carries the main thread's prompt, which already says so.
    await $.agent.spawn({ ...SPAWN, fork: true })

    expect(prompts[0]?.startsWith('Find the callers\n\nThe person follows progress in a pane called Deck,')).toBe(true)
    expect(prompts[0]).toContain('in the language the person writes in')
    expect(prompts[0]).toContain('mcp__deck__plan')
    expect(prompts[1]).toBe('Find the callers')

    const { sections } = await $.prompt.compose(COMPOSE)
    expect(sections.map((section) => `${section.id} ${section.scope}`)).toEqual(['core shared', 'deck:plan session'])

    await run($, 'close')
    await $.agent.spawn(SPAWN)
    expect(prompts[2]).toBe('Find the callers')
    expect((await $.prompt.compose(COMPOSE)).sections.map((section) => section.id)).toEqual(['core'])
  },
)

const HOUR = 60 * 60_000

test('the pane shows what the session cost and how full its limits are', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  await step($, 'high')

  expect(await paneTexts($)).toContain('$1.24 · 5h 34% · 7d 12%')
})

test('a press on a row opens its detail, and a background job can be stopped from there', async ($, on) => {
  const { bash, stops } = world(on)
  await $.session.start(SESSION)
  bash.result = { backgroundTaskId: 'task-1' }
  await $.tool.call({
    tool: 'Bash',
    command: 'npm run dev -- --port 3000',
    description: 'Start the dev server',
    run_in_background: true,
    tool_use_id: 'toolu_1',
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: '$ npm run dev -- --port 3000' })).toBeUndefined()
    await pane.press({ key: 'job:toolu_1' })
    expect(await pane.find({ type: 'Text', text: '$ npm run dev -- --port 3000' })).toBeDefined()
    await pane.press({ key: 'job:toolu_1' })
    await pane.unmount()
  }

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'job:toolu_1' })
  await pane.press({ key: 'stop:toolu_1' })
  await pane.unmount()
  expect(stops).toEqual(['task-1'])
  expect(await paneTexts($)).toEqual(expect.arrayContaining(['RECENT', '■', 'Start the dev server']))
})

test('a cut shell title and command wrap when its title or mark opens it, and stop stays pressable', async ($, on) => {
  const { bash, stops } = world(on)
  await $.session.start(SESSION)
  const title = 'Check the release against every supported platform before shipping it'
  const command = 'npm run verify -- --platform terminal --platform desktop --check build --check types --check tests'
  bash.result = { backgroundTaskId: 'task-long' }
  await $.tool.call({ tool: 'Bash', command, description: title, run_in_background: true, tool_use_id: 'long' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    for (const key of ['job:long', 'job-mark:long']) {
      expect((await pane.find({ key: 'job-mark:long' }))?.props.label).toBe('▸')
      expect((await pane.find({ key: 'job:long' }))?.props.label).toBe(`${title.slice(0, 48)}…`)
      expect(await pane.find({ type: 'Text', text: title })).toBeUndefined()
      expect(await pane.find({ type: 'Text', text: `$ ${command}` })).toBeUndefined()
      expect(await pane.find({ key: 'stop:long' })).toBeUndefined()

      await pane.press({ key })
      expect((await pane.find({ key: 'job-mark:long' }))?.props.label).toBe('▾')
      expect((await pane.find({ key: 'job:long' }))?.props.dimColor).toBe(false)
      expect((await pane.find({ type: 'Text', text: title }))?.props.wrap).toBe('wrap')
      expect((await pane.find({ type: 'Text', text: `$ ${command}` }))?.props.wrap).toBe('wrap')
      expect((await pane.find({ key: 'stop:long' }))?.props.label).toBe('■ stop')
      const texts = (await pane.findAll({ type: 'Text' })).map((text) => text.text)
      expect(texts.indexOf(title)).toBeLessThan(texts.indexOf(`$ ${command}`))
      expect(texts).toContain('⏵')
      await pane.press({ key })
      expect((await pane.find({ key: 'job-mark:long' }))?.props.label).toBe('▸')
      expect(await pane.find({ type: 'Text', text: title })).toBeUndefined()
      expect(await pane.find({ type: 'Text', text: `$ ${command}` })).toBeUndefined()
    }
    await pane.unmount()
  }

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'job-mark:long' })
  await pane.press({ key: 'stop:long' })
  expect(stops).toEqual(['task-long'])
  await pane.unmount()
})

test('an opened recent row is not dim, and a title that fits is not repeated', async ($, on) => {
  const { bash, clock } = world(on)
  await $.session.start(SESSION)
  bash.ms = 4_000
  const call = $.tool.call({ tool: 'Bash', command: 'make', description: 'Build it', tool_use_id: 'recent' })
  // A foreground job stays in recent once it has run long enough.
  await clock.advance(4_000)
  await call
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ key: 'job:recent' }))?.props.dimColor).toBe(true)
  expect((await pane.find({ key: 'job-mark:recent' }))?.props.label).toBe('▸')
  await pane.press({ key: 'job-mark:recent' })
  expect((await pane.find({ key: 'job:recent' }))?.props.dimColor).toBe(false)
  expect((await pane.find({ key: 'job-mark:recent' }))?.props.label).toBe('▾')
  expect(await pane.find({ type: 'Text', text: 'Build it' })).toBeUndefined()
  expect((await pane.find({ type: 'Text', text: '$ make' }))?.props.wrap).toBe('wrap')
  await pane.unmount()
})

test('a long command is bounded to eight lines worth of characters', async ($, on) => {
  const { bash } = world(on)
  await $.session.start(SESSION)
  bash.result = { backgroundTaskId: 'task-cap' }
  const command = 'x'.repeat(200)
  await $.tool.call({ tool: 'Bash', command, description: 'Long command', run_in_background: true, tool_use_id: 'cap' })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 30 } })
  await pane.press({ key: 'job:cap' })
  const text = (await pane.findAll({ type: 'Text' })).find((one) => one.text.startsWith('$ '))
  expect(text?.text).toBe(`$ ${'x'.repeat(189)}…`)
  expect(text?.text.length).toBe((30 - 2 - 4) * 8)
  expect(text?.props.wrap).toBe('wrap')
  expect((await pane.find({ key: 'stop:cap' }))?.props.label).toBe('■ stop')
  await pane.unmount()
})

test(
  'a cut run leaf opens its full title by title or mark, keeping its state apart from the run fold',
  { options: { modelTool: true } },
  async ($, on) => {
    world(on)
    await $.session.start(SESSION)
    const title = 'Verify the release against every supported platform before shipping it'
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Release', steps: `${title}\nShip` })
    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ ...PANE, surface })
      expect(await pane.find({ key: 'step:r1/2' })).toBeUndefined()
      expect(await pane.find({ type: 'Text', text: 'Ship' })).toBeDefined()
      expect(await pane.find({ key: 'fold:r1/1' })).toBeUndefined()
      expect(await pane.find({ type: 'Text', text: '⏵' })).toBeDefined()
      for (const key of ['step:r1/1', 'step-mark:r1/1']) {
        expect((await pane.find({ key: 'step-mark:r1/1' }))?.props.label).toBe('▸')
        expect((await pane.find({ key: 'step:r1/1' }))?.props.label).toBe(`${title.slice(0, 40)}…`)
        expect(await pane.find({ type: 'Text', text: title })).toBeUndefined()
        await pane.press({ key })
        expect((await pane.find({ key: 'step-mark:r1/1' }))?.props.label).toBe('▾')
        expect((await pane.find({ type: 'Text', text: title }))?.props.wrap).toBe('wrap')
        expect((await pane.find({ key: 'fold:r1' }))?.props.label).toBe('▾')
        await pane.press({ key: 'fold:r1' })
        expect(await pane.find({ type: 'Text', text: title })).toBeUndefined()
        await pane.press({ key: 'fold:r1' })
        expect((await pane.find({ type: 'Text', text: title }))?.props.wrap).toBe('wrap')
        await pane.press({ key })
        expect((await pane.find({ key: 'step-mark:r1/1' }))?.props.label).toBe('▸')
        expect(await pane.find({ type: 'Text', text: title })).toBeUndefined()
      }
      await pane.unmount()
    }
  },
)

test(
  'a leaf at the title width stays text, and one character past it can open',
  { options: { modelTool: true } },
  async ($, on) => {
    world(on)
    await $.session.start(SESSION)
    const fits = 'F'.repeat(43)
    const cut = 'C'.repeat(44)
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Boundary', steps: `${fits}\n${cut}` })
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await pane.find({ type: 'Text', text: fits }))?.props.wrap).toBe('truncate-end')
    expect(await pane.find({ key: 'step:r1/1' })).toBeUndefined()
    expect(await pane.find({ key: 'step-mark:r1/1' })).toBeUndefined()
    expect((await pane.find({ key: 'step:r1/2' }))?.props.label).toBe(`${'C'.repeat(40)}…`)
    await pane.press({ key: 'step:r1/2' })
    expect((await pane.find({ type: 'Text', text: cut }))?.props.wrap).toBe('wrap')
    expect((await pane.find({ key: 'step:r1/2' }))?.props.dimColor).toBe(false)
    await pane.unmount()
  },
)

test(
  'job and cut leaf rows leave room for every column at 36, 44 and 64 cells, including under an agent',
  { options: { modelTool: true } },
  async ($, on) => {
    const { bash } = world(on)
    await $.session.start(SESSION)
    const title = 'A'.repeat(70)
    bash.isError = true
    await $.tool.call({ tool: 'Bash', command: 'make', description: title, tool_use_id: 'width-recent' })
    bash.isError = false
    bash.result = { backgroundTaskId: 'task-width' }
    await $.tool.call({ tool: 'Bash', command: 'make', description: title, run_in_background: true, tool_use_id: 'width-top' })
    await $.agent.spawn({ ...SPAWN, parentModel: 'claude-sonnet-5-5' })
    await $.tool.call({ tool: 'Bash', command: 'make', description: title, run_in_background: true, tool_use_id: 'width-nested', ...({ agentId: 'agent-1' } as object) })
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Nested', steps: title, agentId: 'agent-1' })
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Top', steps: title })

    for (const bodyColumns of [36, 44, 64]) {
      const pane = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns } })
      // The labels are drawn text. Add the fixed columns and both pane pads:
      // fold, state, indent, kind where present, time, and a spare cell.
      for (const [id, indent, kind] of [['width-top', 0, 0], ['width-nested', 1, 0], ['width-recent', 0, 7]] as const) {
        const label = String((await pane.find({ key: `job:${id}` }))?.props.label)
        const fixed = 2 + 4 + 2 * indent + kind + 8 + 1
        expect(label).toBe(`${title.slice(0, bodyColumns - fixed - 1)}…`)
        expect([...label].length + fixed).toBe(bodyColumns)
        expect((await pane.find({ key: `job-mark:${id}` }))?.props.label).toBe('▸')
      }
      // A leaf has a count column too; the nested run adds one indent level.
      for (const [id, indent] of [['r1/1', 1], ['r2/1', 0]] as const) {
        const label = String((await pane.find({ key: `step:${id}` }))?.props.label)
        const fixed = 2 + 4 + 2 * (1 + indent) + 6 + 8 + 1
        expect(label).toBe(`${title.slice(0, bodyColumns - fixed - 1)}…`)
        expect([...label].length + fixed).toBe(bodyColumns)
      }
      await pane.unmount()
    }
  },
)

test(
  'a running agent has the run it opened and the shell it started under its own row',
  { options: { modelTool: true } },
  async ($, on) => {
    const { bash } = world(on)
    await $.session.start(SESSION)
    await $.agent.spawn({ ...SPAWN, parentModel: 'claude-sonnet-5-5' })
    await step($, 'high', 'agent-1')
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Find callers', steps: 'Search\nReport', agentId: 'agent-1' })
    bash.result = { backgroundTaskId: 'task-9' }
    await $.tool.call({
      tool: 'Bash',
      command: 'rg callers',
      description: 'Search the tree',
      run_in_background: true,
      ...({ agentId: 'agent-1' } as object),
    })
    // Both run, and the agent's shell is counted with it.
    expect(await tail($)).toBe('Fable 5.1 · ⏵ 2 · Find callers 0/2')

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const labels = (await pane.findAll({ type: 'Button' })).map((button) => String(button.props.label))
    // The agent's row comes first, its shell right after it.
    expect(labels.indexOf('Search the tree')).toBe(labels.indexOf('Explore(find callers)') + 2)
    const texts = (await pane.findAll({ type: 'Text' })).map((text) => text.text)
    // The run sits in the agents' section, under the agent's row.
    expect(texts.indexOf('Find callers')).toBeGreaterThan(texts.indexOf('AGENTS · 1'))
    // The agent's own shell is no row of the shells' section.
    expect(texts.some((text) => text.startsWith('SHELLS'))).toBe(false)
    expect(texts).toContain('Search')
    await pane.press({ key: 'job:agent-1' })
    expect(await pane.find({ type: 'Text', text: 'Fable 5.1 · high effort' })).toBeDefined()
    await pane.unmount()
  },
)

test(
  'a subagent that answers has its last step done for it, and the person is told the run finished',
  { options: { modelTool: true } },
  async ($, on) => {
    const { toasts } = world(on)
    await $.session.start(SESSION)
    await $.agent.spawn(SPAWN)
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Find callers', steps: 'Search\nReport', agentId: 'agent-1' })
    await $.tool.call({ tool: 'mcp__deck__step', id: '2', state: 'start', agentId: 'agent-1' })
    await $.turn.complete({
      answer: 'done',
      durationMs: 1000,
      isAborted: false,
      turnId: 'turn-9',
      reason: 'answer',
      agentId: 'agent-1',
    })

    expect(toasts).toEqual(['✓ Find callers 2/2'])
    expect(await tail($)).toBe('Fable 5.1')
  },
)

test('a background job that fails is told with a toast; with toasts off, nothing is', async ($, on) => {
  const { clock, bash, toasts } = world(on)
  await $.session.start(SESSION)
  bash.result = { backgroundTaskId: 'task-1' }
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'Build it', run_in_background: true })
  await clock.advance(8_000)
  await notified($, 'task-1', 'failed')
  await clock.advance(1_000)

  expect(toasts).toEqual(['✗ Build it · 9s'])
})

test('toasts can be turned off', { options: { toasts: false } }, async ($, on) => {
  const { clock, bash, toasts } = world(on)
  await $.session.start(SESSION)
  bash.result = { backgroundTaskId: 'task-1' }
  await $.tool.call({ tool: 'Bash', command: 'make', run_in_background: true })
  await notified($, 'task-1', 'failed')
  await clock.advance(1_000)

  expect(toasts).toEqual([])
})

test(
  'clear takes what is over out of the pane, by command or button, and half an hour does it by itself',
  { options: { modelTool: true } },
  async ($, on) => {
    const { clock, bash } = world(on)
    await $.session.start(SESSION)
    // The finished job is a subagent's: a plan of the main thread's own would
    // stop the one it has under way.
    const over = async (): Promise<void> => {
      bash.isError = true
      await $.tool.call({ tool: 'Bash', command: 'make', description: 'Build it' })
      bash.isError = false
      await $.tool.call({ tool: 'mcp__deck__plan', title: 'Done job', steps: 'Only', agentId: 'agent-1' })
      await $.tool.call({ tool: 'mcp__deck__step', id: '1', state: 'done', agentId: 'agent-1' })
    }
    const isShown = async (): Promise<boolean> => (await paneTexts($)).some((text) => text.startsWith('Done job'))

    await over()
    // A run still under way is kept by every clear.
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Open job', steps: 'One\nTwo' })
    expect(await isShown()).toBe(true)
    expect(await run($, 'clear')).toContain('Deck is cleared')
    expect(await paneTexts($)).not.toContain('Build it')
    expect(await isShown()).toBe(false)
    expect(await paneTexts($)).toContain('Open job')

    await over()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await pane.press({ key: 'clear' })
    await pane.unmount()
    expect(await isShown()).toBe(false)

    await over()
    await clock.advance(HOUR / 2 - 120_000)
    expect(await isShown()).toBe(true)
    await clock.advance(180_000)
    expect(await isShown()).toBe(false)
    expect(await paneTexts($)).toContain('Open job')
  },
)

test('out of the box nothing of the session is written to the store', async ($, on) => {
  const { clock, store, bash } = world(on)
  await $.session.start(SESSION)
  bash.isError = true
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'Build it' })
  await clock.advance(10_000)

  expect([...store.keys()]).toEqual([])
})

test(
  'a loop shows one run: a plan takes the place of the task list it was following, and its later tasks open none',
  { options: { modelTool: true } },
  async ($, on) => {
    world(on)
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'TaskCreate', subject: 'Read the code', description: '' })
    expect(await tail($)).toBe('Fable 5.1 · Tasks 0/1')

    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Fix the bug', steps: 'Read\nFix' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Fix the bug', description: '' })
    expect(await paneTexts($)).not.toContain('Tasks')
    expect(await tail($)).toBe('Fable 5.1 · Fix the bug 0/2')
  },
)

test(
  '/clear takes the runs and what is over away, and what still runs stays',
  { options: { modelTool: true } },
  async ($, on) => {
    const { bash } = world(on)
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Fix the bug', steps: 'Read\nFix' })
    bash.isError = true
    await $.tool.call({ tool: 'Bash', command: 'make', description: 'Build it' })
    bash.isError = false
    bash.result = { backgroundTaskId: 'task-1' }
    await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Dev server', run_in_background: true })

    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    const texts = await paneTexts($)
    expect(texts).not.toContain('Fix the bug')
    expect(texts).not.toContain('Build it')
    expect(texts).toContain('Dev server')
  },
)

test('a long title is cut to one line of the pane', async ($, on) => {
  const { clock, bash } = world(on)
  await $.session.start(SESSION)
  bash.ms = 10_000
  const call = $.tool.call({ tool: 'Bash', command: 'make', description: 'A'.repeat(70) })
  await clock.advance(1_000)

  const labels = await paneTexts($)
  // 64 cells: two of padding, four for the fold and state marks, eight for the time, one spare.
  expect(labels).toContain(`${'A'.repeat(48)}…`)
  await clock.advance(9_000)
  await call
})

test('a change of model shows on the label within two seconds, before any request', async ($, on) => {
  const { clock, model } = world(on)
  await $.session.start(SESSION)
  await step($, 'high')
  expect(await tail($)).toBe('Fable 5.1 ▰▰▰▱▱ high')

  model.id = 'claude-opus-5-5'
  await clock.advance(2_000)
  // The new model's effort is not known until it answers a request.
  expect(await tail($)).toBe('Opus 5.5')
})

test(
  'where it is a row, the label is in parts: the model, what runs, and the run with its failure',
  { options: { modelTool: true } },
  async ($, on) => {
    const { bash } = world(on)
    await $.session.start(SESSION)
    await step($, 'high')
    bash.result = { backgroundTaskId: 'task-1' }
    await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Fix the bug', steps: 'Read\nFix' })
    await $.tool.call({ tool: 'mcp__deck__step', id: '1', state: 'fail' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...HINT, surface, viewport: FULLSCREEN })
      expect((await ui.find({ key: 'deck' }))?.props.label).toBe('◨')
      expect((await ui.find({ type: 'Text', text: '▰▰▰▱▱' }))?.props.color).toBe('warning')
      expect(face((await ui.find({ key: 'deck-effort' }))?.props.label)).toBe('high')
      expect((await ui.find({ key: 'deck-run' }))?.props.label).toBe('Fix the bug 0/2')
      expect((await ui.findAll({ type: 'Text' })).map((text) => text.text)).toEqual(
        expect.arrayContaining(['⏵ 1', '✗']),
      )
      await ui.unmount()
    }
  },
)

test('the label joins a row another mod drew under the hint line, and its × sends it back to the line as text', async ($, on) => {
  const { store, hint } = world(on)
  hint.row = 'timer 18:42'
  await $.session.start(SESSION)

  const ui = await $.ui.mount({ ...HINT, viewport: FULLSCREEN })
  const texts = (await ui.findAll({ type: 'Text' })).map((text) => text.text)
  // One row for both: the other mod's text comes first on it.
  expect(texts.indexOf('timer 18:42')).toBe(1)
  expect((await ui.find({ key: 'deck' }))?.props.label).toBe('◨')

  await ui.press({ key: 'deck-row-close' })
  expect(store.get('row-closed')).toBe(true)
  expect(await ui.find({ key: 'deck' })).toBeUndefined()
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Fable 5.1')
  await ui.unmount()

  expect(await run($, 'row')).toContain('on a row under the hint line')
  // A switch turned off leaves the store.
  expect(store.has('row-closed')).toBe(false)
})

/** One call of a transcript group, as the transcript hands it to a hook. */
const call = (tool: string, id: string, input: object, more: object = {}) => ({
  tool,
  tool_use_id: id,
  input,
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  ...more,
})
const GROUP = { plugin: 'deck', component: 'ToolGroup', requestId: 'group-1' } as const

test('a group of tool calls in the transcript has a row for each of its shell commands, and a press opens the pane there', async ($, on) => {
  const { clock, bash, panes } = world(on)
  await $.session.start(SESSION)
  bash.ms = 8_000
  bash.isError = true
  const failing = $.tool.call({ tool: 'Bash', command: 'make check', description: 'Verify the profile', tool_use_id: 'toolu_2' })
  await clock.advance(8_000)
  await failing
  bash.isError = false
  bash.ms = 0
  bash.result = { backgroundTaskId: 'task-3' }
  await $.tool.call({ tool: 'Bash', command: 'daemon restart', description: 'Restart the daemon', run_in_background: true, tool_use_id: 'toolu_3' })
  await clock.advance(14_000)

  const calls = [
    // A quick command the deck kept no row of: its title is read from the call itself.
    call('Bash', 'toolu_1', { command: 'app --version', description: 'Check the version' }),
    call('Read', 'toolu_r', { file_path: '/secret/notes.md' }),
    call('Bash', 'toolu_2', { command: 'make check', description: 'Verify the profile' }, { isErrored: true }),
    // The call returned, but the command runs on in the background.
    call('Bash', 'toolu_3', { command: 'daemon restart', description: 'Restart the daemon' }),
  ]

  for (const surface of ['terminal', 'desktop'] as const) {
    const group = await $.ui.mount({ ...GROUP, surface, props: { calls, isActive: false, isExpanded: false } })
    const texts = (await group.findAll({ type: 'Text' })).map((text) => text.text)
    const titles = (await group.findAll({ type: 'Button' })).map((button) => String(button.props.label))
    // The transcript's own line stays first, and no other tool gets a row.
    expect(texts).toEqual(['Ran 4 tool calls', '✓', '✗', '8s', '⏵', '14s'])
    expect(titles).toEqual(['Check the version', 'Verify the profile', 'Restart the daemon'])
    await group.unmount()
  }

  const group = await $.ui.mount({ ...GROUP, surface: 'terminal', props: { calls, isActive: false, isExpanded: false } })
  await group.press({ key: 'call:toolu_3' })
  await group.unmount()
  expect([...panes]).toEqual(['deck'])
  expect(await paneTexts($)).toContain('$ daemon restart')

  // An expanded group is the transcript's alone.
  const open = await $.ui.mount({ ...GROUP, surface: 'terminal', props: { calls, isActive: false, isExpanded: true } })
  expect((await open.findAll({ type: 'Button' })).length).toBe(0)
  await open.unmount()
})

test('with transcript rows off, a group is drawn as it came', { options: { transcriptRows: false } }, async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  const calls = [call('Bash', 'toolu_1', { command: 'ls', description: 'List files' })]
  const group = await $.ui.mount({ ...GROUP, surface: 'terminal', props: { calls, isActive: false, isExpanded: false } })

  expect((await group.findAll({ type: 'Button' })).length).toBe(0)
  await group.unmount()
})

test('a press on the effort in the label steps it up as the pane\'s meter does, and the pane stays shut', async ($, on) => {
  const { efforts, panes } = world(on)
  await $.session.start(SESSION)
  await step($, 'high')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HINT, surface, viewport: FULLSCREEN })
    await ui.press({ key: 'deck-effort' })
    await ui.unmount()
  }

  // Two presses: high, xhigh, max.
  await step($, 'high')
  expect(efforts).toEqual(['high', 'max'])
  expect([...panes]).toEqual([])
})

test('the effort\'s button is as wide at every level, so the pointer that pressed it is still on it', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  await step($, 'high')

  const ui = await $.ui.mount({ ...HINT, viewport: FULLSCREEN })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const levels: string[] = []
  const widths = { label: new Set<number>(), pane: new Set<number>() }

  // Once round: high, xhigh, max, low, medium.
  for (let press = 0; press < 5; press += 1) {
    const label = String((await ui.find({ key: 'deck-effort' }))?.props.label)
    levels.push(face(label))
    widths.label.add(label.length)
    widths.pane.add(String((await pane.find({ key: 'effort' }))?.props.label).length)
    await ui.press({ key: 'deck-effort' })
  }

  await ui.unmount()
  await pane.unmount()
  expect(levels).toEqual(['high', 'xhigh', 'max', 'low', 'medium'])
  expect([...widths.label]).toEqual(['medium'.length])
  expect([...widths.pane]).toEqual(['medium ⟳'.length])
})

test(
  'a narrow pane keeps the titles: a run loses its bar, and a row its kind',
  { options: { modelTool: true } },
  async ($, on) => {
    const { bash } = world(on)
    await $.session.start(SESSION)
    bash.isError = true
    await $.tool.call({ tool: 'Bash', command: 'make', description: 'Build it' })
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Fix the bug', steps: 'Read\nFix' })
    const texts = async (bodyColumns: number): Promise<string[]> => {
      const pane = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns } })
      const found = (await pane.findAll({ type: 'Text' })).map((text) => text.text)
      await pane.unmount()

      return found
    }

    expect(await texts(64)).toEqual(expect.arrayContaining(['▱▱▱▱▱▱▱▱', 'shell', '0/2']))
    const narrow = await texts(30)
    expect(narrow).toEqual(expect.arrayContaining(['Fix the bug', '0/2']))
    expect(narrow).not.toContain('▱▱▱▱▱▱▱▱')
    expect(narrow).not.toContain('shell')
  },
)

test('a pane that waits undrawn is not up: a press opens it again and says why it waits', async ($, on) => {
  const { panes, seat, toasts } = world(on)
  await $.session.start(SESSION)
  seat.isPlaced = false

  const ui = await $.ui.mount({ ...HINT, viewport: FULLSCREEN })
  await ui.press({ key: 'deck' })
  await ui.press({ key: 'deck' })
  // Neither press closed it: the pane is still asked for.
  expect([...panes]).toEqual(['deck'])
  expect(toasts.at(-1)).toBe("Deck's pane waits: 120 columns, 144 needed")
  // A command says why in its answer, where it once said the pane was open.
  expect(await run($, 'open')).toBe("Deck's pane waits: 120 columns, 144 needed")

  seat.isPlaced = true
  await ui.press({ key: 'deck' })
  expect([...panes]).toEqual([])
  await ui.unmount()
})

test(
  'on a narrow terminal a press draws the pane at once, from the label and from a transcript row, with no word of waiting',
  async ($, on) => {
    const { panes, seat, placed, toasts } = world(on)
    await $.session.start(SESSION)
    seat.isNarrow = true

    const ui = await $.ui.mount({ ...HINT, viewport: { ...FULLSCREEN, columns: 100 } })
    await ui.press({ key: 'deck' })
    expect([...placed]).toEqual(['deck'])
    await ui.press({ key: 'deck' })
    expect([...panes]).toEqual([])
    await ui.unmount()

    const group = await $.ui.mount({
      ...GROUP,
      surface: 'terminal',
      props: { calls: [call('Bash', 'toolu_1', { command: 'make', description: 'Build it' })], isActive: false, isExpanded: false },
    })
    await group.press({ key: 'call:toolu_1' })
    await group.unmount()
    expect([...placed]).toEqual(['deck'])
    expect(toasts).toEqual([])
  },
)

const CHECKS = 'repos/acme/shop/commits/pull%2F12%2Fhead/check-runs?per_page=100'
const STATUSES = 'repos/acme/shop/commits/pull%2F12%2Fhead/status?per_page=100'
const check = (name: string, status: string, conclusion: string | null = null) => ({
  name,
  status,
  conclusion,
  started_at: '2026-10-06T10:00:00Z',
  completed_at: status === 'completed' ? '2026-10-06T10:01:30Z' : null,
})

test('with GitHub checks off, nothing is asked and no tool is listed', async ($, on) => {
  const { tools, github } = world(on)
  await $.session.start(SESSION)

  expect(tools).toEqual([])
  expect(await run($, 'watch 12')).toContain('GitHub checks are off')
  expect(github.asked).toEqual([])
})

test(
  'a watched pull request shows its checks as a run, follows them, and ends when they are over',
  { options: { github: true } },
  async ($, on) => {
    const { clock, tools, toasts, github } = world(on)
    await $.session.start(SESSION)
    expect(tools).toEqual(['watch'])

    github.answers[CHECKS] = { check_runs: [check('test', 'in_progress'), check('lint', 'completed', 'success')] }
    github.answers[STATUSES] = { statuses: [{ context: 'deploy/preview', state: 'pending' }] }
    github.answers['repos/acme/shop/pulls/12'] = { title: 'Fix the wallet' }

    expect(await run($, 'watch #12')).toContain('"PR #12 · Fix the wallet" is shown in the Deck: 1 of 3 checks are over.')
    expect(github.asked).toEqual([`github.com ${CHECKS}`, `github.com ${STATUSES}`, 'github.com repos/acme/shop/pulls/12'])
    expect(await paneTexts($)).toEqual(
      expect.arrayContaining(['PR #12 · Fix the wallet', '1/3', 'test', 'lint', 'deploy/preview']),
    )
    expect(await run($, 'watch 12')).toBe('It is shown in the Deck already.')

    github.answers[CHECKS] = { check_runs: [check('test', 'completed', 'failure'), check('lint', 'completed', 'success')] }
    github.answers[STATUSES] = { statuses: [{ context: 'deploy/preview', state: 'success' }] }
    await clock.advance(31_000)
    expect(toasts).toEqual(['✗ PR #12 · Fix the wallet: test failed'])

    // Over on two polls in a row: the watch ends, and GitHub is asked no more.
    await clock.advance(31_000)
    const asked = github.asked.length
    await clock.advance(60_000)
    expect(github.asked.length).toBe(asked)
    expect(github.submitted).toEqual([])
  },
)

test(
  'the watch tool follows a workflow run with its jobs and steps, and wakes Claude when it is over',
  { options: { github: true } },
  async ($, on) => {
    const { clock, github } = world(on)
    await $.session.start(SESSION)
    const job = (status: string, conclusion: string | null, second: string) => ({
      jobs: [
        {
          ...check('deploy', status, conclusion),
          steps: [check('Build', 'completed', 'success'), check('Release', second, second === 'completed' ? 'success' : null)],
        },
      ],
    })

    github.answers['repos/acme/shop/actions/runs/37387841808'] = { name: 'Deploy', display_title: 'Ship 1.4', status: 'in_progress' }
    github.answers['repos/acme/shop/actions/runs/37387841808/jobs?per_page=100'] = job('in_progress', null, 'in_progress')

    const answer = await $.tool.call({ tool: 'mcp__deck__watch', target: '37387841808', wake: true })
    expect(answer.result).toContain('"Deploy · Ship 1.4" is shown in the Deck: 1 of 2 checks are over. A message will tell you')
    expect(await paneTexts($)).toEqual(expect.arrayContaining(['Deploy · Ship 1.4', 'deploy', 'Build', 'Release']))

    github.answers['repos/acme/shop/actions/runs/37387841808'] = { name: 'Deploy', display_title: 'Ship 1.4', status: 'completed' }
    github.answers['repos/acme/shop/actions/runs/37387841808/jobs?per_page=100'] = job('completed', 'success', 'completed')
    await clock.advance(31_000)

    expect(github.submitted).toEqual([
      'The GitHub checks of "Deploy · Ship 1.4" are over: 2 passed, 0 failed.\nhttps://github.com/acme/shop/actions/runs/37387841808',
    ])

    const refused = await $.tool.call({ tool: 'mcp__deck__watch', target: '99' })
    expect(refused.deny).toBe('Nothing is shown: gh: Not Found (HTTP 404)')
  },
)

test(
  'without gh, GitHub is asked directly, and a token goes to github.com alone',
  { options: { github: true } },
  async ($, on) => {
    const { github } = world(on)
    await $.session.start(SESSION)
    github.hasGh = false
    github.env.GH_TOKEN = 'secret'
    github.answers['repos/acme/shop/commits/main/check-runs?per_page=100'] = { check_runs: [check('test', 'queued')] }
    github.answers['repos/acme/shop/commits/main/status?per_page=100'] = { statuses: [] }

    // With no words, the branch the session is on.
    expect(await run($, 'watch')).toContain('"Checks · main" is shown in the Deck: 0 of 1 checks are over.')
    expect(github.fetched).toEqual([
      { url: 'https://api.github.com/repos/acme/shop/commits/main/check-runs?per_page=100', token: 'Bearer secret' },
      { url: 'https://api.github.com/repos/acme/shop/commits/main/status?per_page=100', token: 'Bearer secret' },
    ])

    expect(await run($, 'watch https://git.corp.example/acme/shop/pull/3')).toBe(
      'Nothing is shown: Checks on git.corp.example need the gh command, signed in to it.',
    )
    expect(github.fetched.length).toBe(2)
    expect(await run($, 'unwatch')).toBe('Deck stopped following GitHub: the runs stay where they stood.')
  },
)

test('a transcript row\'s clock runs while the pane is closed', async ($, on) => {
  const { clock, bash, panes } = world(on)
  await $.session.start(SESSION)
  bash.result = { backgroundTaskId: 'task-3' }
  await $.tool.call({ tool: 'Bash', command: 'daemon restart', description: 'Restart the daemon', run_in_background: true, tool_use_id: 'toolu_3' })
  const calls = [call('Bash', 'toolu_3', { command: 'daemon restart', description: 'Restart the daemon' })]
  const group = await $.ui.mount({ ...GROUP, surface: 'terminal', props: { calls, isActive: false, isExpanded: false } })

  await clock.advance(5_000)
  expect([...panes]).toEqual([])
  expect((await group.findAll({ type: 'Text' })).map((text) => text.text)).toContain('5s')
  await group.unmount()
})

test(
  'a close in any session ends what runs here, stops what is followed on GitHub and wakes nobody',
  { options: { github: true, modelTool: true } },
  async ($, on) => {
    const { clock, store, github } = world(on)
    await $.session.start(SESSION)
    github.answers[CHECKS] = { check_runs: [check('test', 'in_progress')] }
    github.answers[STATUSES] = { statuses: [] }
    github.answers['repos/acme/shop/pulls/12'] = { title: 'Fix the wallet' }
    await $.tool.call({ tool: 'mcp__deck__watch', target: '12', wake: true })
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Ship it', steps: 'Build\nRelease' })
    await $.agent.spawn({ ...SPAWN, description: 'deploy' })
    expect(await tail($)).toContain('⏵ 1')

    // Another session closes the deck: nothing is asked of GitHub from here on.
    store.set('closed', true)
    await clock.advance(2_000)
    const asked = github.asked.length
    github.answers[CHECKS] = { check_runs: [check('test', 'completed', 'success')] }
    await clock.advance(5 * 60_000)
    expect(github.asked.length).toBe(asked)
    expect(github.submitted).toEqual([])

    // Back: what ran stopped where it stood, so nothing runs on, now or later.
    store.delete('closed')
    await clock.advance(2_000)
    expect(await tail($)).toBe('Fable 5.1')
    await clock.advance(HOUR)
    expect(await tail($)).toBe('Fable 5.1')
    expect(await paneTexts($)).not.toContain('AGENTS · 1')
  },
)

test(
  'a shell the person is asked about waits with no clock, and its clock starts two seconds before Claude Code\'s hint',
  async ($, on) => {
    const { clock, bash } = world(on)
    await $.session.start(SESSION)
    bash.ms = 60_000
    const call1 = $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests', tool_use_id: 'toolu_ask' })
    await clock.advance(1)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } })
    await clock.advance(7_999)

    expect(await paneTexts($)).toEqual(expect.arrayContaining(['?', 'Run the tests', 'waits']))
    // It is not counted as running on the label.
    expect(await tail($)).toBe('Fable 5.1')

    // Allowed at 8 s, the hint is drawn at 10 s: the clock reads from 8 s.
    await clock.advance(2_000)
    const hint = await $.ui.mount({
      plugin: 'deck',
      surface: 'terminal',
      component: 'ToolProgress',
      requestId: 'toolu_ask',
      props: { tool_use_id: 'toolu_ask', kind: 'background_hint', hint: '(ctrl+b to run in background)' },
    })
    await hint.unmount()
    await clock.advance(1_000)
    expect(await tail($)).toBe('Fable 5.1 · ⏵ 1')

    await clock.advance(49_000)
    await call1
    expect(await paneTexts($)).toEqual(expect.arrayContaining(['RECENT', 'Run the tests', '52s']))
  },
)

test(
  'the label fits the screen: its run\'s title is cut, then the model goes, beside the docked pane and another mod\'s row',
  { options: { modelTool: true } },
  async ($, on) => {
    const { clock, hint } = world(on)
    await $.session.start(SESSION)
    await step($, 'high')
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Ship the release to production', steps: 'Build\nTest\nShip' })
    const label = async (columns: number): Promise<{ run: string; hasModel: boolean }> => {
      const ui = await $.ui.mount({ ...HINT, viewport: { ...FULLSCREEN, columns } })
      const run = face((await ui.find({ key: 'deck-run' }))?.props.label)
      const hasModel = (await ui.find({ type: 'Text', text: 'Fable 5.1' })) !== undefined
      expect(await ui.find({ key: 'deck-row-close' })).toBeDefined()
      await ui.unmount()

      return { run, hasModel }
    }

    expect(await label(120)).toEqual({ run: 'Ship the release to pro… 0/3', hasModel: true })
    expect(await label(50)).toEqual({ run: 'Ship the release… 0/3', hasModel: true })
    expect(await label(36)).toEqual({ run: 'Ship the rel… 0/3', hasModel: false })

    // Docked, the pane takes its body's 64 cells and 3 more.
    await run($, 'open')
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await pane.unmount()
    await clock.advance(1_000)
    expect(await label(117)).toEqual({ run: 'Ship the release… 0/3', hasModel: true })

    // Another mod's row of 11 cells, 2 apart, shares the line.
    expect(await run($, '')).toBe('Deck pane closed.')
    await clock.advance(1_000)
    hint.row = 'timer 18:42'
    expect(await label(63)).toEqual({ run: 'Ship the release… 0/3', hasModel: true })
  },
)

test('a transcript row\'s title is cut to the conversation\'s width', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  const title = 'Build every package of the workspace and run the tests'
  const calls = [call('Bash', 'toolu_w', { command: 'make', description: title })]
  const titleAt = async (columns: number): Promise<string> => {
    const group = await $.ui.mount({ ...GROUP, surface: 'terminal', viewport: { ...FULLSCREEN, columns }, props: { calls, isActive: false, isExpanded: false } })
    const label = String((await group.find({ key: 'call:toolu_w' }))?.props.label)
    await group.unmount()

    return label
  }

  expect(await titleAt(120)).toBe(title)
  expect(await titleAt(40)).toBe(`${title.slice(0, 26)}…`)
})

test('above the prompt the pane lists the three newest ended jobs and counts the rest', async ($, on) => {
  const { bash } = world(on)
  await $.session.start(SESSION)
  bash.isError = true

  for (const name of ['one', 'two', 'three', 'four', 'five']) {
    await $.tool.call({ tool: 'Bash', command: name, description: name })
  }

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline' } })
  const titles = (await pane.findAll({ type: 'Button' })).map((button) => String(button.props.label))
  const texts = (await pane.findAll({ type: 'Text' })).map((text) => text.text)
  await pane.unmount()
  expect(titles).toEqual(expect.arrayContaining(['five', 'four', 'three']))
  expect(titles).not.toContain('two')
  expect(texts).toEqual(expect.arrayContaining(['+2 more', '$1.24 · 5h 34% · 7d 12%']))
  // Beside the conversation all of them are listed.
  expect(await paneTexts($)).toEqual(expect.arrayContaining(['one', 'two']))
})

test(
  'a new plan stops the loop\'s old one, and a subagent cannot move a plan it did not open',
  { options: { modelTool: true } },
  async ($, on) => {
    const { clock } = world(on)
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Left behind', steps: 'One\nTwo' })
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Current', steps: 'Alpha\nBeta' })

    const refused = await $.tool.call({ tool: 'mcp__deck__step', id: '2', state: 'start', agentId: 'agent-1' })
    expect(refused.deny).toBe('No plan of yours is open. Call plan first, or name its run.')

    // The stopped plan leaves with what is over; the current one stays.
    await clock.advance(HOUR / 2 + 60_000)
    const texts = await paneTexts($)
    expect(texts).not.toContain('Left behind')
    expect(texts).toEqual(expect.arrayContaining(['Current', 'Alpha']))
  },
)

test(
  'a step opened in a run under way stays open through a clear, and a run that takes a freed id starts with no folds',
  { options: { modelTool: true } },
  async ($, on) => {
    world(on)
    await $.session.start(SESSION)
    const long = 'Move every table of the old schema to the new one'
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Migrate', steps: `${long}\nVerify` })
    // Narrow, the step's title is cut and opens to the whole of it.
    const narrow = { ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 36 } } as const
    const pane = await $.ui.mount(narrow)
    await pane.press({ key: 'step-mark:r1/1' })
    await pane.unmount()
    // A finished subagent's run gives the clear something to take.
    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Side', steps: 'Only', agentId: 'agent-1' })
    await $.tool.call({ tool: 'mcp__deck__step', id: '1', state: 'done', agentId: 'agent-1' })
    await run($, 'clear')
    const after = await $.ui.mount(narrow)
    expect((await after.findAll({ type: 'Text' })).map((text) => text.text)).toContain(long)
    // Folded by the person, then finished and pushed out by six newer runs.
    await after.press({ key: 'fold:r1' })
    await after.unmount()
    await $.tool.call({ tool: 'mcp__deck__step', id: '2', state: 'done' })
    await $.tool.call({ tool: 'mcp__deck__step', id: '1', state: 'done' })

    for (const title of ['A', 'B', 'C', 'D', 'E', 'F']) {
      await $.tool.call({ tool: 'mcp__deck__plan', title, steps: 'Only' })
      await $.tool.call({ tool: 'mcp__deck__step', id: '1', state: 'done' })
    }

    await $.tool.call({ tool: 'mcp__deck__plan', title: 'Fresh', steps: 'First\nSecond' })
    expect(await paneTexts($)).toEqual(expect.arrayContaining(['Fresh', 'First', 'Second']))
  },
)

test('the switches every session shares cost one read of the store while none is set', async ($, on) => {
  const { clock, reads } = world(on)
  await $.session.start(SESSION)
  await clock.advance(10_000)
  expect(reads).toEqual([])

  expect(await run($, 'row')).toContain('as text')
  await clock.advance(2_000)
  expect(reads).toEqual(['row-closed'])
})
