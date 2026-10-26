import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActivityKind, Task, TaskStatus, Wait } from '../types'
import { COLOR, HOURGLASS, progressBar, pulse, taskIcon } from './icons'
import {
  FILE_TOOLS,
  MAX_ERRORS,
  MAX_FILES_SHOWN,
  PLAN_STATUS,
  SPINNER,
  TERMINAL_ICON,
  addFile,
  ago,
  applyPlan,
  createTask,
  describeTool,
  duration,
  filePath,
  fromTodos,
  isFreshPlan,
  justCompleted,
  markTask,
  planSummary,
  pushEvent,
  splitPath,
  subagentOf,
  taskTime,
  textBar,
  truncate,
  updateTask,
  wrapUp,
} from './plan'
import type { Args } from './plan'

const PANE = 'work-status'
const TITLE = 'Work status'
const SET_WAITING = 'mcp__work-status__set_waiting'
const MARK_TASK = 'mcp__work-status__mark_task'
const UPDATE_PLAN = 'mcp__ccd_turn__update_plan'
const WRAP_UP = 'mcp__ccd_turn__wrap_up'
const WORKING = 'Working on it'
const SUBAGENT_WAIT = 'Waiting for'
const USAGE_EVERY_MS = 10_000
const STATUSES = ['waiting', 'in_progress', 'done', 'failed']

const activity = atom({ plugin: 'work-status', key: 'activity' } as const, null)
const waits = atom({ plugin: 'work-status', key: 'waits' } as const, [])
const background = atom({ plugin: 'work-status', key: 'background' } as const, [])
const tasks = atom({ plugin: 'work-status', key: 'tasks' } as const, [])
const frame = atom({ plugin: 'work-status', key: 'frame' } as const, 0)
const clockNow = atom({ plugin: 'work-status', key: 'now' } as const, 0)
const isPaneOpen = atom({ plugin: 'work-status', key: 'isPaneOpen' } as const, false)
const files = atom({ plugin: 'work-status', key: 'files' } as const, [])
const events = atom({ plugin: 'work-status', key: 'events' } as const, [])
const turnStartedAt = atom({ plugin: 'work-status', key: 'turnStartedAt' } as const, null)
const contextPercent = atom({ plugin: 'work-status', key: 'contextPercent' } as const, null)
const agents = atom({ plugin: 'work-status', key: 'agents' } as const, [])
const errors = atom({ plugin: 'work-status', key: 'errors' } as const, [])
const decision = atom({ plugin: 'work-status', key: 'decision' } as const, null)

const GUIDE = `The work-status mod shows the person, in a side pane, what you are doing or waiting on and how your task list is going.
- Whenever the work is blocked on something outside this turn (CI or e2e tests, someone's code review, a build, a deploy, a reply), call ${SET_WAITING} with the full list of what you are waiting on, each a short phrase such as "e2e tests on the PR" or "Code review from <reviewer>". Call it with an empty list as soon as nothing is pending.
- When a step of your task list fails and you are not retrying it right away, call ${MARK_TASK} with its 1-based number and status "failed".`

const subagentWait = (count: number) => `${SUBAGENT_WAIT} ${count} subagent${count === 1 ? '' : 's'}`

let ticker: { cancel: () => void } | undefined
let tickerMs = 0
let lastUsageAt = 0
let agentSeq = 0

async function setActivity($: EngineInterface, kind: ActivityKind, text: string) {
  await update($, activity, now => (now?.kind === kind && now.text === text ? now : { kind, text }))
  $.ui.status(text)
}

// Renders may read state but not write it, so the clock is read here and stored for them.
async function touch($: EngineInterface): Promise<number> {
  const at = await $.clock.now()
  await update($, clockNow, n => Math.max(n, at))

  return at
}

async function refreshContext($: EngineInterface) {
  try {
    const usage = await $.session.usage()
    await update($, contextPercent, () => usage.context.percent ?? null)
  } catch {
    // The figure stays as it was.
  }
}

async function tick($: EngineInterface) {
  const at = await $.clock.now()
  const second = (ms: number) => Math.floor(ms / 1000)
  await update($, clockNow, n => (second(n) === second(at) ? n : Math.max(n, at)))
  if (tickerMs < 1000) await update($, frame, n => (n + 1) % SPINNER.length)

  if (at - lastUsageAt >= USAGE_EVERY_MS) {
    lastUsageAt = at
    await refreshContext($)
  }
}

// Elapsed times need a redraw on every surface; the terminal also spins, so it ticks faster.
async function syncTicker($: EngineInterface) {
  const now = await read($, activity)
  const isRunning =
    now?.kind === 'working' ||
    (await read($, turnStartedAt)) !== null ||
    (await read($, agents)).length > 0
  const ms = (await $.session.surfaces()).includes('terminal') ? 120 : 1000

  if (ticker !== undefined && (!isRunning || tickerMs !== ms)) {
    ticker.cancel()
    ticker = undefined
  }

  if (isRunning && ticker === undefined) {
    tickerMs = ms
    ticker = $.clock.every(ms, () => void tick($).catch(() => undefined))
  }
}

function announce($: EngineInterface, text: string) {
  for (const send of [() => $.ui.toast(text), () => $.ui.notify(text, { title: TITLE })]) {
    try {
      void Promise.resolve(send()).catch(() => undefined)
    } catch {
      // A notification is never worth failing a turn.
    }
  }
}

async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  await update($, isPaneOpen, () => opened.isPlaced)

  return opened
}

async function syncPaneOpen($: EngineInterface) {
  const panes = await $.ui.panes()
  await update($, isPaneOpen, () => panes.some(pane => pane.id === PANE && pane.isPlaced))
}

async function setTasks($: EngineInterface, fn: (list: Task[]) => Task[]) {
  let before: Task[] = []
  let after: Task[] = []
  await update($, tasks, list => {
    before = list
    after = fn(list)

    return after
  })
  await syncTicker($)

  if (justCompleted(before, after)) announce($, 'All tasks are done')
}

async function resetRun($: EngineInterface) {
  await update($, files, () => [])
  await update($, errors, () => [])
}

type Ran = { isError?: boolean; text?: string; result?: unknown; deny?: string }

async function recordOutcome($: EngineInterface, tool: string, args: Args, ran: Ran) {
  if (ran.deny !== undefined) return

  if (ran.isError) {
    const at = await $.clock.now()
    const text = truncate(ran.text || `${tool} failed`, 120)
    await update($, errors, list => [...list, { tool: tool.split('__').pop() || tool, text, at }].slice(-MAX_ERRORS))
    return
  }

  const path = FILE_TOOLS.includes(tool) ? filePath(args) : undefined
  if (path !== undefined) await update($, files, list => addFile(list, path))
}

async function setWaiting($: EngineInterface, args: Args) {
  const items = Array.isArray(args.items) ? args.items.map(String).filter(text => text.trim() !== '') : []
  await update($, waits, () => items.map((text): Wait => ({ text, source: 'claude' })))

  return { result: items.length === 0 ? 'Nothing is shown as pending.' : `Shown as waiting on: ${items.join('; ')}` }
}

async function markStep($: EngineInterface, args: Args) {
  const step = Number(args.step)
  const status = String(args.status)
  const list = await read($, tasks)

  if (!STATUSES.includes(status)) {
    return { result: `Unknown status "${status}"; use one of ${STATUSES.join(', ')}.` }
  }

  if (!Number.isInteger(step) || step < 1 || step > list.length) {
    return { result: `There is no step ${String(args.step)}; the list has ${list.length}.` }
  }

  const at = await touch($)
  await setTasks($, all => markTask(all, step, status as TaskStatus, at))

  return { result: `Step ${step} is now ${status}.` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'work-status',
      description: 'Open the work status pane; "/work-status clear" resets it',
    })
    await $.tool.register({
      name: 'set_waiting',
      description:
        'Shows the person what the work is waiting on outside this turn (tests, CI, a code review, a deploy). Pass the full list each time; an empty list clears it.',
      inputSchema: {
        type: 'object',
        properties: { items: { type: 'array', items: { type: 'string' }, description: 'Short phrases, e.g. "e2e tests on the PR"' } },
        required: ['items'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'mark_task',
      description: 'Sets the status of one step of the current task list in the work status pane, e.g. to mark it failed.',
      inputSchema: {
        type: 'object',
        properties: {
          step: { type: 'integer', minimum: 1, description: '1-based step number' },
          status: { type: 'string', enum: ['waiting', 'in_progress', 'done', 'failed'] },
        },
        required: ['step', 'status'],
      },
      isDeferred: false,
    })
    void syncPaneOpen($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'work-status' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, waits, () => [])
      await update($, background, () => [])
      await update($, tasks, () => [])
      await update($, events, () => [])
      await resetRun($)
      await syncTicker($)

      return { text: 'Work status cleared.' }
    }

    const opened = await openPane($)

    return { text: opened.isPlaced ? 'Work status pane opened.' : `Work status pane waits: ${opened.reason}` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isPaneOpen, () => false)

    return closed
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isPaneOpen))) return next(e)

    const now = await read($, activity)
    const pending = (await read($, waits)).length + (await read($, background)).length
    const plan = planSummary(await read($, tasks))
    const startedAt = await read($, turnStartedAt)
    const elapsed = startedAt === null ? undefined : duration((await read($, clockNow)) - startedAt)
    const errorCount = (await read($, errors)).length
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const chip = [plan && `Plan ${plan}`, pending > 0 && `${pending} pending`, elapsed].filter(Boolean).join(' · ')

    // The band is one site shared by every mod: sit beside what the mods beneath it drew.
    return (
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={3}>
        <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1}>
          <Text color={COLOR[now?.kind ?? 'input']}>●</Text>
          <Box flexShrink={1}>
            <Text wrap="truncate-end">{now?.text ?? 'Idle'}</Text>
          </Box>
          {chip !== '' && (
            <Box flexShrink={0}>
              <Text dimColor>{chip}</Text>
            </Box>
          )}
          {errorCount > 0 && (
            <Box flexShrink={0}>
              <Text color={COLOR.failed}>{`· ${errorCount} error${errorCount === 1 ? '' : 's'}`}</Text>
            </Box>
          )}
          <Box flexShrink={0}>
            <Button key="open-work-status" label="Status" hotkey="w" onPress={() => openPane($)} />
          </Box>
        </Box>
        {below}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    // Registered tools can fail to reach the model; don't send it looking for tools it lacks.
    if (!e.tools.includes(SET_WAITING) || !e.tools.includes(MARK_TASK)) return composed

    return { sections: [...composed.sections, { id: 'work-status:guide', text: GUIDE, scope: 'session' as const }] }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, decision, () => null)
      const at = await touch($)
      await update($, turnStartedAt, () => at)
      await setActivity($, 'working', WORKING)
      void refreshContext($)
      await syncTicker($)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const args = e as unknown as Args
    const isMain = e.agentId === undefined

    if (tool === SET_WAITING) return setWaiting($, args)
    if (tool === MARK_TASK) return markStep($, args)

    const at = isMain ? await touch($) : 0
    let subagent: string | undefined

    if (isMain) {
      const line = describeTool(tool, args)
      if (line !== undefined) await update($, events, list => pushEvent(list, at, line))

      const list = await read($, tasks)

      switch (tool) {
        case UPDATE_PLAN:
          if (Array.isArray(args.items) && isFreshPlan(list)) await resetRun($)
          await setTasks($, all => applyPlan(Array.isArray(args.items) && isFreshPlan(all) ? [] : all, args, at))
          break
        case 'TodoWrite':
          if (isFreshPlan(list)) await resetRun($)
          await setTasks($, all => fromTodos(isFreshPlan(all) ? [] : all, args, at))
          break
        case WRAP_UP:
          await setTasks($, all => wrapUp(all, at))
          if (args.blocked === true || typeof args.ask === 'string') {
            const ask = typeof args.ask === 'string' ? args.ask : 'your decision'
            await update($, decision, () => ask)
          }
          break
        case 'AskUserQuestion':
          await setActivity($, 'input', 'Waiting for your answer')
          break
        case 'Bash':
        case 'PowerShell':
          if (args.run_in_background !== true) {
            await setActivity($, 'working', `Running: ${String(args.description ?? args.command).slice(0, 80)}`)
          }
          break
        case 'Agent': {
          const id = String(++agentSeq)
          subagent = id
          await update($, agents, all => [...all, subagentOf(id, args, at)])
          await setActivity($, 'working', subagentWait((await read($, agents)).length))
          await syncTicker($)
          break
        }
      }
    }

    let ran: Awaited<ReturnType<typeof next>>

    try {
      ran = await next(e)
    } finally {
      if (isMain && tool === 'Agent' && subagent !== undefined) {
        const gone = subagent
        await update($, agents, all => all.filter(agent => agent.id !== gone))
        const count = (await read($, agents)).length
        await setActivity($, 'working', count > 0 ? subagentWait(count) : WORKING)
        await syncTicker($)
      } else if (isMain && (tool === 'Bash' || tool === 'PowerShell' || tool === 'AskUserQuestion')) {
        await setActivity($, 'working', WORKING)
      }
    }

    await recordOutcome($, tool, args, ran as Ran)

    if (!isMain) return ran

    const later = await touch($)

    switch (tool) {
      case 'TaskCreate': {
        const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
        if (id !== undefined) {
          if ((await read($, tasks)).length === 0) await resetRun($)
          await setTasks($, list => createTask(list, id, String(args.subject), later))
        }
        break
      }
      case 'TaskUpdate':
        await setTasks($, list => updateTask(list, args, later))
        break
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Stop carries the session's background work and scheduled wake-ups.
  on('classic.Stop', async ($, e, next) => {
    const running = (e.background_tasks ?? []).map((task): Wait => ({ text: task.description, source: 'background' }))
    const crons = (e.session_crons ?? []).map((cron): Wait => ({ text: `Check-in scheduled (${cron.schedule})`, source: 'schedule' }))
    await update($, background, () => [...running, ...crons])

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    const at = await touch($)
    await update($, agents, () => [])
    await update($, turnStartedAt, () => null)
    const pending = [...(await read($, waits)), ...(await read($, background))]
    const asked = await read($, decision)

    if (e.reason === 'aborted') {
      await setActivity($, 'stopped', 'Stopped. Waiting for you')
    } else if (e.reason === 'error' || e.reason === 'refusal') {
      await setActivity($, 'stopped', 'Stopped on an error')
    } else if (asked !== null) {
      await setActivity($, 'input', `Waiting for your decision: ${asked}`)
    } else if (pending.length > 0) {
      await setActivity($, 'waiting', `Waiting on ${pending.length} thing${pending.length === 1 ? '' : 's'}`)
    } else {
      await setActivity($, 'input', 'Waiting for your input')
    }

    const label = e.reason === 'aborted' ? 'Turn stopped' : e.reason === 'answer' ? 'Turn done' : 'Turn failed'
    await update($, events, list => pushEvent(list, at, label))
    if (e.reason === 'error') announce($, 'Claude stopped on an error')

    void refreshContext($)
    await syncTicker($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const now = await read($, activity)
    const pending = [...(await read($, waits)), ...(await read($, background))]
    const list = await read($, tasks)
    const clock = await read($, clockNow)
    const startedAt = await read($, turnStartedAt)
    const context = await read($, contextPercent)
    const subagents = await read($, agents)
    const touched = await read($, files)
    const recent = await read($, events)
    const failures = await read($, errors)
    const done = list.filter(task => task.status === 'done').length
    const failed = list.filter(task => task.status === 'failed').length
    const isRunning = list.some(task => task.status === 'in_progress')
    const ratio = list.length === 0 ? 0 : done / list.length
    const percent = Math.round(ratio * 100)
    const summary = `${done} of ${list.length} done${failed > 0 ? ` · ${failed} failed` : ''} · ${percent}%`
    const kind = now?.kind ?? 'input'
    const isWaitingOnAgents = subagents.length > 0 && now?.text.startsWith(SUBAGENT_WAIT) === true
    const headline = isWaitingOnAgents ? WORKING : (now?.text ?? 'Idle')
    const step = kind === 'working' && now !== null && now.text !== WORKING && !isWaitingOnAgents ? now.text : undefined
    const status = [startedAt === null ? undefined : `Working ${duration(clock - startedAt)}`, context === null ? undefined : `context ${context}%`]
      .filter(Boolean)
      .join(' · ')
    const fileRows = touched.slice(0, MAX_FILES_SHOWN).map(splitPath)
    const moreFiles = touched.length - fileRows.length
    const agentRows = subagents.map(agent => ({
      title: agent.description,
      meta: [agent.type, duration(clock - agent.startedAt)].filter(Boolean).join(' · '),
    }))
    const eventRows = recent.map(event => ({ ago: ago(clock - event.at), text: event.text }))

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      const spin = SPINNER[await read($, frame)] ?? SPINNER[0]

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text bold color={COLOR[kind]}>
              {kind === 'working' ? spin : '●'} {headline}
            </Text>
            {status !== '' && <Text dimColor>{status}</Text>}
          </Box>
          {pending.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>Waiting on</Text>
              {pending.map(wait => (
                <Text color={COLOR.waiting}>⧗ {wait.text}</Text>
              ))}
            </Box>
          )}
          {agentRows.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>Subagents · {agentRows.length}</Text>
              {agentRows.map(row => (
                <Box flexDirection="row" gap={1}>
                  <Text color={COLOR.working}>◆ {row.title}</Text>
                  <Text dimColor>{row.meta}</Text>
                </Box>
              ))}
            </Box>
          )}
          {list.length === 0 ? (
            <Text dimColor>No plan yet.</Text>
          ) : (
            <Box flexDirection="column">
              <Text dimColor>Plan · {summary}</Text>
              <Text color={ratio === 1 ? COLOR.done : COLOR.in_progress}>{textBar(e.props.bodyColumns, ratio)}</Text>
              {list.map(task => (
                <Box flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Text color={task.status === 'waiting' ? undefined : COLOR[task.status]} dimColor={task.status === 'waiting'}>
                      {task.status === 'in_progress' ? spin : TERMINAL_ICON[task.status]} {task.title}
                    </Text>
                    {taskTime(task, clock) !== undefined && <Text dimColor>{taskTime(task, clock)}</Text>}
                  </Box>
                  {task.status === 'in_progress' && step !== undefined && <Text dimColor>{`   ${step}`}</Text>}
                </Box>
              ))}
            </Box>
          )}
          {failures.length > 0 && (
            <Box flexDirection="column">
              <Text color={COLOR.failed}>Errors · {failures.length}</Text>
              {failures.map(error => (
                <Text color={COLOR.failed}>
                  ✖ {error.tool}: {error.text}
                </Text>
              ))}
            </Box>
          )}
          {touched.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>Files touched · {touched.length}</Text>
              {fileRows.map(row => (
                <Box flexDirection="row" gap={1}>
                  <Text>{row.name}</Text>
                  <Text dimColor>{row.dir}</Text>
                </Box>
              ))}
              {moreFiles > 0 && <Text dimColor>+{moreFiles} more</Text>}
            </Box>
          )}
          {eventRows.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>Timeline</Text>
              {eventRows.map(row => (
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>{row.ago}</Text>
                  <Text>{row.text}</Text>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    const { Box, Text, Svg } = $.ui.resolve(e)
    const barWidth = Math.max(120, Math.min(560, e.props.bodyColumns * 7))

    return (
      <Box flexDirection="column" gap={2}>
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={pulse(kind)} alt={kind} width={18} height={18} isInteractive />
            <Text weight="semibold">{headline}</Text>
          </Box>
          {status !== '' && (
            <Text size="caption" dimColor>
              {status}
            </Text>
          )}
        </Box>
        {pending.length > 0 && (
          <Box flexDirection="column" gap={1}>
            <Text size="caption" dimColor>
              WAITING ON
            </Text>
            {pending.map(wait => (
              <Box flexDirection="row" alignItems="center" gap={1}>
                <Svg source={HOURGLASS} alt="waiting" width={14} height={14} isInteractive />
                <Text>{wait.text}</Text>
              </Box>
            ))}
          </Box>
        )}
        {agentRows.length > 0 && (
          <Box flexDirection="column" gap={1}>
            <Text size="caption" dimColor>
              SUBAGENTS · {agentRows.length}
            </Text>
            {agentRows.map(row => (
              <Box flexDirection="row" alignItems="center" gap={1}>
                <Svg source={taskIcon('in_progress')} alt="running" width={16} height={16} isInteractive />
                <Text>{row.title}</Text>
                <Text size="caption" dimColor>
                  {row.meta}
                </Text>
              </Box>
            ))}
          </Box>
        )}
        {list.length === 0 ? (
          <Text dimColor>No plan yet.</Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Text size="caption" dimColor>
              PLAN · {summary}
            </Text>
            <Svg
              source={progressBar(barWidth, ratio, isRunning, failed > 0)}
              alt={`${percent}% done`}
              width={barWidth}
              height={10}
              isInteractive={isRunning}
            />
            {list.map(task => (
              <Box flexDirection="column">
                <Box flexDirection="row" alignItems="center" gap={1}>
                  <Svg
                    source={taskIcon(task.status)}
                    alt={task.status}
                    width={16}
                    height={16}
                    isInteractive={task.status === 'in_progress'}
                  />
                  <Text
                    dimColor={task.status === 'waiting'}
                    strikethrough={task.status === 'done'}
                    color={task.status === 'failed' ? COLOR.failed : undefined}
                  >
                    {task.title}
                  </Text>
                  {taskTime(task, clock) !== undefined && (
                    <Text size="caption" dimColor>
                      {taskTime(task, clock)}
                    </Text>
                  )}
                </Box>
                {task.status === 'in_progress' && step !== undefined && (
                  <Box paddingLeft={3}>
                    <Text size="caption" dimColor>
                      {step}
                    </Text>
                  </Box>
                )}
              </Box>
            ))}
          </Box>
        )}
        {failures.length > 0 && (
          <Box flexDirection="column" gap={1}>
            <Text size="caption" color={COLOR.failed}>
              ERRORS · {failures.length}
            </Text>
            {failures.map(error => (
              <Text color={COLOR.failed}>
                {error.tool}: {error.text}
              </Text>
            ))}
          </Box>
        )}
        {touched.length > 0 && (
          <Box flexDirection="column" gap={1}>
            <Text size="caption" dimColor>
              FILES TOUCHED · {touched.length}
            </Text>
            {fileRows.map(row => (
              <Box flexDirection="row" gap={1}>
                <Text>{row.name}</Text>
                <Text size="caption" dimColor>
                  {row.dir}
                </Text>
              </Box>
            ))}
            {moreFiles > 0 && (
              <Text size="caption" dimColor>
                +{moreFiles} more
              </Text>
            )}
          </Box>
        )}
        {eventRows.length > 0 && (
          <Box flexDirection="column" gap={1}>
            <Text size="caption" dimColor>
              TIMELINE
            </Text>
            {eventRows.map(row => (
              <Box flexDirection="row" gap={1}>
                <Text size="caption" dimColor>
                  {row.ago}
                </Text>
                <Text>{row.text}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
