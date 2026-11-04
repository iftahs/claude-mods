import { expect, mock, test } from 'claude-code/testing'

import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { Task } from '../types'
import { cleanError, errorTitle, isScratch, relativeDir, splitFiles, wrapUp } from '../hooks/plan'

const PANE = {
  plugin: 'work-status',
  component: 'Pane',
  requestId: 'work-status',
  props: {
    title: 'Work status',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'work-status',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const T0 = 1_700_000_000_000
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
type Call = { tool: string; agentId?: string; [key: string]: unknown }
type Answer = { result: object; isError?: boolean; text?: string }

type Options = {
  toolCall?: (e: Call) => Answer | Promise<Answer>
  onOpen?: (e: unknown) => void
  hasEngineRow?: boolean
}

function boot(on: On, options: Options = {}) {
  const clock = mock.clock(on, { now: T0 })
  const toasts: string[] = []
  const notes: { text: string; title?: string }[] = []
  let usageCalls = 0
  on('command.register', () => ({ value: { command: 'work-status' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__work-status__${e.name}` } }))
  on('ui.open', (_, e) => {
    options.onOpen?.(e)
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('session.surfaces', () => ({ value: ['desktop' as const] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => {
    usageCalls += 1
    return { value: { startedAt: T0, context: { window: 200_000, tokens: 68_000, percent: 34 }, rateLimits: [] } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    notes.push(e)
    return { value: { isSent: false as const, reason: 'disabled' as const } }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_, e) => (options.toolCall?.(e as Call) ?? { result: {} }) as never)
  if (options.hasEngineRow) on('ui.render', ($, e) => h($.ui.resolve(e).Text, null, 'engine') as RenderElement)

  return { clock, toasts, notes, usageCalls: () => usageCalls }
}

const turnEnd = (reason: 'answer' | 'error') =>
  ({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason }) as const

const text = (re: RegExp) => ({ type: 'Text', text: re }) as const

const WRAP_UP = 'mcp__ccd_turn__wrap_up'

// The host-generated tool types do not list these MCP tool names.
const callMcp = ($: Engine, tool: string, args: object = {}) => $.tool.call({ tool, ...args } as never)

const edit = (file_path: string, agentId?: string) => ({ tool: 'Edit' as const, file_path, old_string: 'a', new_string: 'b', ...(agentId && { agentId }) })
const write = (file_path: string, agentId?: string) => ({ tool: 'Write' as const, file_path, content: '', ...(agentId && { agentId }) })

const mountPane = ($: Engine, surface: Surface) => $.ui.mount({ ...PANE, surface })

const ITEMS = [
  { content: 'Write the fix', status: 'in_progress' },
  { content: 'Run e2e tests', status: 'pending' },
  { content: 'Open the PR', status: 'pending' },
  { content: 'Hand off to QA', status: 'pending' },
]

test('the pane shows the plan, its progress and what Claude waits on', async ($, on) => {
  boot(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: ITEMS, scope: 'first_task' })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  await $.tool.call({ tool: 'mcp__work-status__mark_task', step: 3, status: 'failed' })
  await $.tool.call({
    tool: 'mcp__work-status__set_waiting',
    items: ['e2e tests on the PR', 'Code review from a teammate'],
  })

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)

    expect((await ui.find({ type: 'Text', text: /2 of 4 done · 1 failed · 50%/ }))?.text).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Code review from a teammate/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Hand off to QA/ })).toBeDefined()
    await ui.unmount()
  }

  const desktop = await mountPane($, 'desktop')
  expect((await desktop.find({ type: 'Svg' }))?.props).toBeDefined()
  await desktop.unmount()
})

test('TodoWrite lists are tracked too', async ($, on) => {
  boot(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'One', status: 'completed', activeForm: 'Doing one' },
      { content: 'Two', status: 'in_progress', activeForm: 'Doing two' },
    ],
  })

  const ui = await mountPane($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /1 of 2 done · 50%/ })).toBeDefined()
  await ui.unmount()
})

test('the band sums up the work beside the rows beneath it, and only its button opens the pane', async ($, on) => {
  const opens: unknown[] = []
  boot(on, { onOpen: e => opens.push(e), hasEngineRow: true })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opens).toEqual([])

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: ITEMS, scope: 'first_task' })
  await $.tool.call({ tool: 'mcp__work-status__set_waiting', items: ['e2e tests on the PR'] })
  expect(opens).toEqual([])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /^Plan 0\/4 · 0% · 1 pending$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'open-work-status' }))?.props.label).toBe('Status')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'open-work-status' })
  expect(opens).toEqual([{ id: 'work-status', title: 'Work status' }])
  expect(await ui.find({ type: 'Button', key: 'open-work-status' })).toBeUndefined()
  await ui.unmount()
})

for (const surface of SURFACES) {
  test(`files touched include a subagent's edits, once each, on ${surface}`, async ($, on) => {
    boot(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.tool.call(edit('/src/app/a.ts'))
    await $.tool.call(edit('/src/app/a.ts', 'sub-1'))
    await $.tool.call(write('C:\\proj\\b.ts', 'sub-1'))
    await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/n/c.ipynb', new_source: '' })
    await $.tool.call({ tool: 'Read', file_path: '/src/never.ts' })

    const ui = await mountPane($, surface)
    expect(await ui.find(text(/^files · 3$/i))).toBeDefined()
    expect(await ui.find(text(/^a\.ts$/))).toBeDefined()
    expect(await ui.find(text(/^b\.ts$/))).toBeDefined()
    expect(await ui.find(text(/^c\.ipynb$/))).toBeDefined()
    expect(await ui.find(text(/^never\.ts$/))).toBeUndefined()
    await ui.unmount()
  })

  test(`a long file list shows eight until Show all, and /work-status clear empties and collapses it, on ${surface}`, async ($, on) => {
    boot(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    for (let i = 1; i <= 45; i += 1) await $.tool.call(write(`/src/f${i}.ts`))

    const ui = await mountPane($, surface)
    const toggle = async () => (await ui.find({ type: 'Button', key: 'toggle-files' }))?.props.label
    expect(await ui.find(text(/^files · 45$/i))).toBeDefined()
    expect(await ui.find(text(/^f8\.ts$/))).toBeDefined()
    expect(await ui.find(text(/^f9\.ts$/))).toBeUndefined()
    expect(await toggle()).toBe('Show all (45)')

    await ui.press({ key: 'toggle-files' })
    expect(await toggle()).toBe('Show less')
    expect(await ui.find(text(/^f40\.ts$/))).toBeDefined()
    expect(await ui.find(text(/^f41\.ts$/))).toBeUndefined()
    expect(await ui.find(text(/^\+5 more$/))).toBeDefined()

    await $.command.run({ command: 'work-status', args: 'clear', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    expect(await ui.find(text(/files/i))).toBeUndefined()

    for (let i = 1; i <= 9; i += 1) await $.tool.call(write(`/src/g${i}.ts`))
    expect(await ui.find(text(/^g8\.ts$/))).toBeDefined()
    expect(await ui.find(text(/^g9\.ts$/))).toBeUndefined()
    expect(await toggle()).toBe('Show all (9)')
    await ui.unmount()
  })

  test(`files under the project show their folder relative to it, scratch files are only counted, on ${surface}`, async ($, on) => {
    boot(on)
    await $.session.start({ cwd: 'E:\\dev\\app', surface, isInteractive: true })
    await $.tool.call(edit('E:\\dev\\app\\src\\domain\\user.ts'))
    await $.tool.call(write('e:/dev/app/readme.md'))
    await $.tool.call(write('E:\\dev\\application\\other.ts'))
    await $.tool.call(write('C:\\Users\\me\\AppData\\Local\\Temp\\claude\\proj\\scratchpad\\frames.py'))
    await $.tool.call(write('/tmp/one.ts'))

    const ui = await mountPane($, surface)
    expect(await ui.find(text(/^files · 5$/i))).toBeDefined()
    expect(await ui.find(text(/^user\.ts$/))).toBeDefined()
    expect(await ui.find(text(/^src\/domain$/))).toBeDefined()
    expect(await ui.find(text(/^readme\.md$/))).toBeDefined()
    expect(await ui.find(text(/^other\.ts$/))).toBeDefined()
    expect(await ui.find(text(/^E:\/dev\/application$/))).toBeDefined()
    expect(await ui.find(text(/^frames\.py$/))).toBeUndefined()
    expect(await ui.find(text(/^one\.ts$/))).toBeUndefined()
    expect(await ui.find(text(/^\+2 scratch files$/))).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'toggle-files' })).toBeUndefined()
    await ui.unmount()
  })

  test(`a fresh plan starts with no files or errors, on ${surface}`, async ($, on) => {
    boot(on, { toolCall: e => (e.tool === 'Bash' ? { result: {}, isError: true, text: 'old failure' } : { result: {} }) })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.tool.call(write('/src/old.ts'))
    await $.tool.call({ tool: 'Bash', command: 'false' })
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'One', status: 'in_progress', activeForm: 'Doing one' }] })

    const ui = await mountPane($, surface)
    expect(await ui.find(text(/^old\.ts$/))).toBeUndefined()
    expect(await ui.find(text(/old failure/))).toBeUndefined()
    expect(await ui.find(text(/errors/i))).toBeUndefined()
    await ui.unmount()
  })

  test(`failed tool calls of any agent are listed behind Show, and the band counts them, on ${surface}`, async ($, on) => {
    boot(on, {
      hasEngineRow: true,
      toolCall: e => (e.tool === 'Bash' ? { result: {}, isError: true, text: `npm ERR! ${e.agentId ?? 'main'}` } : { result: {} }),
    })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'sub-1' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })

    const ui = await mountPane($, surface)
    expect(await ui.find(text(/errors · 3/i))).toBeDefined()
    expect(await ui.find(text(/npm ERR! sub-1/))).toBeUndefined()
    await ui.press({ key: 'toggle-errors' })
    expect(await ui.find(text(/npm ERR! sub-1/))).toBeDefined()
    await ui.unmount()

    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find(text(/^· 3 errors$/))).toBeDefined()
    await band.unmount()
  })

  test(`an error shows what failed, its exit code and a cleaned first line, newest first, and Clear empties the list, on ${surface}`, async ($, on) => {
    const failing: Record<string, string> = {
      Bash: 'Exit code 2\n\uFFFD\uFFFD\uFFFD /usr/bin/bash: -c:  line 169: unexpected EOF while looking for matching\nsecond line',
      Edit: 'String to replace not found',
    }
    boot(on, { toolCall: e => (e.tool in failing ? { result: {}, isError: true, text: failing[e.tool] } : { result: {} }) })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'bash build.sh', description: 'Run the build' })
    await $.tool.call(edit('/src/app/a.ts'))

    const ui = await mountPane($, surface)
    const label = async () => (await ui.find({ type: 'Button', key: 'toggle-errors' }))?.props.label
    expect(await label()).toBe('Show')
    expect(await ui.find(text(/^Run the build$/))).toBeUndefined()

    await ui.press({ key: 'toggle-errors' })
    expect(await label()).toBe('Hide')
    const titles = await ui.findAll(text(/^(Run the build|a\.ts)$/))
    expect(titles.map(row => row.text)).toEqual(['a.ts', 'Run the build'])
    expect(await ui.find(text(/^Bash · exit 2 · now$/))).toBeDefined()
    expect(await ui.find(text(/^Edit · now$/))).toBeDefined()
    expect(await ui.find(text(/^String to replace not found$/))).toBeDefined()
    expect(await ui.find(text(/^\/usr\/bin\/bash: -c: line 169: unexpected EOF while looking for matching$/))).toBeDefined()
    expect(await ui.find(text(/second line|Exit code|\uFFFD/))).toBeUndefined()

    await ui.press({ key: 'clear-errors' })
    expect(await ui.find(text(/errors/i))).toBeUndefined()
    await ui.unmount()
  })

  test(`/work-status clear collapses the errors again, on ${surface}`, async ($, on) => {
    boot(on, { toolCall: e => (e.tool === 'Bash' ? { result: {}, isError: true, text: 'Exit code 1\nboom' } : { result: {} }) })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'false' })

    const ui = await mountPane($, surface)
    await ui.press({ key: 'toggle-errors' })
    expect(await ui.find(text(/^boom$/))).toBeDefined()

    await $.command.run({ command: 'work-status', args: 'clear', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    await $.tool.call({ tool: 'Bash', command: 'false' })
    expect((await ui.find({ type: 'Button', key: 'toggle-errors' }))?.props.label).toBe('Show')
    expect(await ui.find(text(/^boom$/))).toBeUndefined()
    await ui.unmount()
  })

  test(`an error stored before titles and exit codes existed still renders, on ${surface}`, async ($, on) => {
    boot(on)
    on('state.get', { plugin: 'work-status', key: 'errors' }, () => ({
      value: { value: [{ tool: 'Bash', text: 'old failure', at: T0 }], version: 1 },
    }))
    await $.session.start({ cwd: '/', surface, isInteractive: true })

    const ui = await mountPane($, surface)
    expect(await ui.find(text(/^errors · 1$/i))).toBeDefined()
    await ui.press({ key: 'toggle-errors' })
    expect(await ui.find(text(/^Bash$/))).toBeDefined()
    expect(await ui.find(text(/^old failure$/))).toBeDefined()
    await ui.unmount()
  })

  test(`tasks show live and final elapsed time, on ${surface}`, async ($, on) => {
    const { clock } = boot(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: ITEMS, scope: 'first_task' })
    await clock.advance(72_000)

    const ui = await mountPane($, surface)
    expect(await ui.find(text(/^1m 12s$/))).toBeDefined()

    await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
    await clock.advance(5_000)
    expect(await ui.find(text(/^done in 1m 12s$/))).toBeDefined()
    expect(await ui.find(text(/^5s$/))).toBeDefined()
    await ui.unmount()
  })

  test(`the turn timer and context show in the pane and on the band, and stop with the turn, on ${surface}`, { timeoutMs: 15_000 }, async ($, on) => {
    const { clock, usageCalls } = boot(on, { hasEngineRow: true })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(192_000)

    const ui = await mountPane($, surface)
    expect(await ui.find(text(/^Working 3m 12s · context 34%$/))).toBeDefined()
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find(text(/^3m 12s$/))).toBeDefined()

    await $.turn.complete(turnEnd('answer'))
    expect(await ui.find(text(/^Working /))).toBeUndefined()
    expect(await band.find(text(/^3m 12s$/))).toBeUndefined()
    expect(await band.find(text(/^Done in 3m 12s$/))).toBeDefined()
    expect(await ui.find(text(/context 34%/))).toBeDefined()

    await clock.settle()
    const calls = usageCalls()
    await clock.advance(60_000)
    expect(usageCalls()).toBe(calls)
    await ui.unmount()
    await band.unmount()
  })

  test(`a running subagent and the current step are shown while they run, a background launch leaves no row behind, on ${surface}`, { timeoutMs: 15_000 }, async ($, on) => {
    const seen: Record<string, boolean> = {}
    const ctx = boot(on, {
      toolCall: async e => {
        if (e.description === 'Later job') return { result: { status: 'async_launched' } }
        if (e.tool !== 'Agent' && e.tool !== 'Bash') return { result: {} }
        const ui = await mountPane($, surface)
        await ctx.clock.advance(7_000)
        seen[e.tool === 'Bash' ? 'bash' : String(e.description)] = (await ui.find(text(/subagents · 1/i))) !== undefined
        seen.meta = seen.meta || (await ui.find(text(/reviewer · 7s/))) !== undefined
        seen.step = seen.step || (await ui.find(text(/Running: npm test/))) !== undefined
        await ui.unmount()

        return { result: {} }
      },
    })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: ITEMS, scope: 'first_task' })
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'npm test' })
    await $.tool.call({ tool: 'Agent', description: 'Review the diff', subagent_type: 'reviewer', prompt: 'x' })
    expect(seen.step).toBe(true)
    expect(seen['Review the diff']).toBe(true)
    expect(seen.meta).toBe(true)

    await $.tool.call({ tool: 'Agent', description: 'Later job', prompt: 'x' })

    const ui = await mountPane($, surface)
    expect(await ui.find(text(/subagents/i))).toBeUndefined()
    await ui.unmount()
  })

  test(`the timeline shows the last six calls, on ${surface}`, async ($, on) => {
    const { clock } = boot(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'npm test' })
    for (let i = 1; i <= 5; i += 1) await $.tool.call(edit(`/src/t${i}.ts`))
    await clock.advance(125_000)
    for (let i = 6; i <= 10; i += 1) await $.tool.call(edit(`/src/t${i}.ts`))

    const ui = await mountPane($, surface)
    expect(await ui.find(text(/^Edit t10\.ts$/))).toBeDefined()
    expect(await ui.find(text(/^Edit t5\.ts$/))).toBeDefined()
    expect(await ui.find(text(/^Edit t4\.ts$/))).toBeUndefined()
    expect(await ui.find(text(/^Bash: npm test$/))).toBeUndefined()
    expect(await ui.find(text(/^2m ago$/))).toBeDefined()
    await ui.unmount()
  })

  test(`a turn that ends with nothing to ask or wait for reads Done in its time, and the wrap-up closes the plan, on ${surface}`, async ($, on) => {
    const { clock } = boot(on, { hasEngineRow: true })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await callMcp($, 'mcp__ccd_turn__update_plan', { items: ITEMS, scope: 'first_task' })
    await callMcp($, 'mcp__ccd_turn__update_plan', { advance: true })
    await clock.advance(72_000)
    await callMcp($, WRAP_UP)
    await $.turn.complete(turnEnd('answer'))

    const ui = await mountPane($, surface)
    expect(await ui.find(text(/Done in 1m 12s/))).toBeDefined()
    expect(await ui.find(text(/4 of 4 done · 100%/))).toBeDefined()
    expect(await ui.find(text(/waiting for/i))).toBeUndefined()
    if (surface === 'desktop') expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('done')
    await ui.unmount()

    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find(text(/^Done in 1m 12s$/))).toBeDefined()
    expect(await band.find(text(/^Plan 4\/4 · 100%$/))).toBeDefined()
    expect(await band.find(text(/waiting for/i))).toBeUndefined()
    await band.unmount()
  })

  test(`a wrap-up that asks or is blocked keeps the turn waiting for the decision, on ${surface}`, async ($, on) => {
    boot(on, { hasEngineRow: true })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await callMcp($, WRAP_UP, { ask: 'Ship it?' })
    await $.turn.complete(turnEnd('answer'))

    const ui = await mountPane($, surface)
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find(text(/Waiting for your decision: Ship it\?/))).toBeDefined()
    expect(await band.find(text(/^Waiting for your decision: Ship it\?$/))).toBeDefined()
    expect(await band.find(text(/Done/))).toBeUndefined()

    await $.turn.start({ text: 'ok', turnId: 't2' })
    await callMcp($, WRAP_UP, { blocked: true })
    await $.turn.complete(turnEnd('answer'))
    expect(await band.find(text(/^Waiting for your decision: your decision$/))).toBeDefined()
    await ui.unmount()
    await band.unmount()
  })
}

test('cleanError parses the exit code and keeps one clean line', () => {
  expect(cleanError('Exit code 1 he query \uFFFD\uFFFD\uFFFD\uFFFD\uFFFD he-IL total 23')).toEqual({ code: 1, text: 'he query he-IL total 23' })
  expect(cleanError('Exit code 2\n/usr/bin/bash: -c: line 169: unexpected EOF')).toEqual({ code: 2, text: '/usr/bin/bash: -c: line 169: unexpected EOF' })
  expect(cleanError('\u001b[31mError:\u001b[0m\u0007 no such file\r\nat main.js:1')).toEqual({ text: 'Error: no such file' })
  expect(cleanError('Exit code 1\n\n  \uFFFD\uFFFD \n---\nreal cause here\nmore')).toEqual({ code: 1, text: 'real cause here' })
  expect(cleanError('Exit code 3')).toEqual({ code: 3, text: '' })
  expect(cleanError('x'.repeat(300)).text).toHaveLength(160)
})

test('errorTitle names what failed from the call, by tool', () => {
  expect(errorTitle('Bash', { command: 'npm test', description: 'Run the tests' })).toBe('Run the tests')
  expect(errorTitle('PowerShell', { command: `git ${'status '.repeat(30)}` }).length).toBeLessThanOrEqual(80)
  expect(errorTitle('Bash', { command: 'npm test' })).toBe('npm test')
  expect(errorTitle('Edit', { file_path: 'C:\\proj\\src\\a.ts' })).toBe('a.ts')
  expect(errorTitle('Read', { file_path: '/src/b.ts' })).toBe('b.ts')
  expect(errorTitle('NotebookEdit', { notebook_path: '/n/c.ipynb' })).toBe('c.ipynb')
  expect(errorTitle('Grep', { pattern: 'TODO' })).toBe('TODO')
  expect(errorTitle('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
  expect(errorTitle('mcp__chrome-devtools__click', { uid: '1' })).toBe('click')
  expect(errorTitle('WebFetch', {})).toBe('WebFetch')
})

test('splitFiles keeps project files relative, folds scratch files and leaves other files short', () => {
  expect(relativeDir('E:\\dev\\app', 'e:/dev/app/src/domain/user.ts')).toBe('src/domain')
  expect(relativeDir('E:\\dev\\app\\', 'E:\\dev\\app\\readme.md')).toBe('')
  expect(relativeDir('E:\\dev\\app', 'E:\\dev\\application\\x.ts')).toBeUndefined()
  expect(relativeDir('/', '/src/app/a.ts')).toBe('src/app')
  expect(relativeDir('/home/me/app', '/home/ME/app/a.ts')).toBeUndefined()

  expect(isScratch('C:\\Users\\ME~1\\AppData\\Local\\Temp\\claude\\x.py')).toBe(true)
  expect(isScratch('/tmp/x.ts')).toBe(true)
  expect(isScratch('/home/me/.claude/scratchpad/x.ts')).toBe(true)
  expect(isScratch('/home/me/app/tmpfile.ts')).toBe(false)

  const paths = ['/work/app/src/a.ts', '/work/app/tmp/b.ts', '/tmp/c.ts', 'D:\\other\\deep\\er\\than\\that\\d.ts']
  expect(splitFiles(paths, '/work/app')).toEqual({
    rows: [
      { name: 'a.ts', dir: 'src' },
      { name: 'b.ts', dir: 'tmp' },
      { name: 'd.ts', dir: '…/er/than/that' },
    ],
    scratch: 1,
  })
  expect(splitFiles(['/work/app/src/a.ts'], null).rows).toEqual([{ name: 'a.ts', dir: '…/work/app/src' }])
})

test('a turn with no recorded start reads plain Done', async ($, on) => {
  boot(on, { hasEngineRow: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(turnEnd('answer'))

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find(text(/^Done$/))).toBeDefined()
  await band.unmount()
})

test('wrapUp closes every waiting and in-progress step and leaves done and failed ones alone', () => {
  const list: Task[] = [
    { id: 'a', title: 'A', status: 'done', startedAt: 1, endedAt: 2 },
    { id: 'b', title: 'B', status: 'failed', startedAt: 2, endedAt: 3 },
    { id: 'c', title: 'C', status: 'in_progress', startedAt: 3 },
    { id: 'd', title: 'D', status: 'waiting' },
  ]

  expect(wrapUp(list, 9)).toEqual([
    list[0],
    list[1],
    { id: 'c', title: 'C', status: 'done', startedAt: 3, endedAt: 9 },
    { id: 'd', title: 'D', status: 'done', endedAt: 9 },
  ])
})

test('wrap_up closes the whole plan but keeps a failed step failed', async ($, on) => {
  const { toasts, clock } = boot(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await callMcp($, 'mcp__ccd_turn__update_plan', { items: ITEMS, scope: 'first_task' })
  await callMcp($, 'mcp__ccd_turn__update_plan', { advance: true })
  await callMcp($, 'mcp__work-status__mark_task', { step: 3, status: 'failed' })
  await callMcp($, WRAP_UP)
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find(text(/3 of 4 done · 1 failed · 75%/))).toBeDefined()
    await ui.unmount()
  }

  expect(toasts).toEqual([])
})

test('wrap_up that finishes the plan notifies once, however often it is called', async ($, on) => {
  const { toasts, notes, clock } = boot(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await callMcp($, 'mcp__ccd_turn__update_plan', { items: ITEMS, scope: 'first_task' })
  await callMcp($, WRAP_UP)
  await callMcp($, WRAP_UP)
  await clock.settle()

  const ui = await mountPane($, 'desktop')
  expect(await ui.find(text(/4 of 4 done · 100%/))).toBeDefined()
  await ui.unmount()
  expect(toasts).toEqual(['All tasks are done'])
  expect(notes.length).toBe(1)
})

test('it notifies when the plan completes or the turn errors, never for a wait on the person', async ($, on) => {
  const { toasts, notes, clock } = boot(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: ITEMS, scope: 'first_task' })
  await $.turn.complete(turnEnd('answer'))
  await clock.settle()
  expect(toasts).toEqual([])
  expect(notes).toEqual([])

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', done: [1, 2, 3] })
  await clock.settle()
  expect(toasts).toEqual([])

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', done: [4] })
  await clock.settle()
  expect(toasts).toEqual(['All tasks are done'])
  expect(notes).toEqual([{ text: 'All tasks are done', title: 'Work status' }])

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', done: [4] })
  await clock.settle()
  expect(notes.length).toBe(1)

  await $.turn.start({ text: 'again', turnId: 't1' })
  await $.turn.complete(turnEnd('error'))
  await clock.settle()
  expect(notes.map(note => note.text)).toEqual(['All tasks are done', 'Claude stopped on an error'])
})

test('nothing ticks after the turn ends, even with a step left in progress', async ($, on) => {
  const { clock, usageCalls } = boot(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: ITEMS, scope: 'first_task' })
  await clock.advance(1_000)
  await $.turn.complete(turnEnd('error'))
  await clock.settle()

  const calls = usageCalls()
  const at = clock.now()
  await clock.advance(60_000)
  expect(usageCalls()).toBe(calls)

  const ui = await mountPane($, 'terminal')
  expect(await ui.find(text(/^1s$/))).toBeDefined()
  await ui.unmount()
  expect(clock.now()).toBe(at + 60_000)
})

test('an Agent call that throws leaves no subagent row behind', async ($, on) => {
  boot(on, {
    toolCall: e => {
      if (e.tool === 'Agent') throw new Error('boom')
      return { result: {} }
    },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'Review the diff', prompt: 'x' }).catch(() => undefined)

  const ui = await mountPane($, 'desktop')
  expect(await ui.find(text(/subagents/i))).toBeUndefined()
  await ui.unmount()
})

test('mark_task rejects a status it does not know and leaves the task alone', async ($, on) => {
  boot(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: ITEMS, scope: 'first_task' })

  const answer = await $.tool.call({ tool: 'mcp__work-status__mark_task', step: 1, status: 'exploded' })
  expect(JSON.stringify(answer)).toMatch(/Unknown status/)

  const ui = await mountPane($, 'desktop')
  expect(await ui.find(text(/0 of 4 done · 0%/))).toBeDefined()
  await ui.unmount()
})

test('two plan writes that finish the plan together notify once', async ($, on) => {
  const { notes, clock } = boot(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: ITEMS, scope: 'first_task' })
  await Promise.all([
    $.tool.call({ tool: 'mcp__ccd_turn__update_plan', done: [1, 2, 3, 4] }),
    $.tool.call({ tool: 'mcp__ccd_turn__update_plan', done: [1, 2, 3, 4] }),
  ])
  await clock.settle()
  expect(notes.length).toBe(1)
})

for (const hasTools of [true, false]) {
  test(`the guide reaches the model only when its tools did (${hasTools ? 'tools present' : 'tools missing'})`, async ($, on) => {
    boot(on)
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

    const tools = hasTools ? ['Bash', 'mcp__work-status__set_waiting', 'mcp__work-status__mark_task'] : ['Bash']
    const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['desktop'], tools, outputStyle: null, traits: [] })

    expect(sections.some(section => section.id === 'work-status:guide')).toBe(hasTools)
  })
}
