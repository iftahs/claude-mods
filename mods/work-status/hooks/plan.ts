import type { Subagent, Task, TaskStatus, TimelineEvent } from '../types'

export type Args = Record<string, unknown>

export const PLAN_STATUS: Record<string, TaskStatus> = {
  pending: 'waiting',
  in_progress: 'in_progress',
  completed: 'done',
}

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export const TERMINAL_ICON: Record<TaskStatus, string> = { waiting: '○', in_progress: '', done: '✔', failed: '✖' }

export const FILE_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const PLAN_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'mcp__ccd_turn__update_plan', 'mcp__ccd_turn__wrap_up']

export const MAX_EVENTS = 10
export const MAX_ERRORS = 20
export const MAX_FILES_SHOWN = 15

const isClosed = (task: Task) => task.status === 'done' || task.status === 'failed'

export const isFreshPlan = (list: Task[]) => list.every(isClosed)

function timed(task: Task, startedAt?: number, endedAt?: number): Task {
  const { startedAt: _started, endedAt: _ended, ...rest } = task

  return { ...rest, ...(startedAt !== undefined && { startedAt }), ...(endedAt !== undefined && { endedAt }) }
}

// Keeps a task's times while its status holds; stamps the moment it starts or ends.
export function stamp(before: Task[], after: Task[], now: number): Task[] {
  return after.map(task => {
    const prev = before.find(p => p.id === task.id)

    if (prev?.status === task.status) return timed(task, prev.startedAt, prev.endedAt)
    if (task.status === 'in_progress') return timed(task, now)
    if (task.status === 'waiting') return timed(task)

    return timed(task, prev?.startedAt, now)
  })
}

function advance(list: Task[]): Task[] {
  const current = list.findIndex(task => task.status === 'in_progress')
  const closed = list.map((task, i) => (i === current ? { ...task, status: 'done' as const } : task))
  const nextUp = closed.findIndex(task => task.status === 'waiting')

  return closed.map((task, i) => (i === nextUp ? { ...task, status: 'in_progress' as const } : task))
}

// Mirrors mcp__ccd_turn__update_plan: a whole `items` list, then `done`, `start` and `advance`.
export function applyPlan(list: Task[], args: Args, now: number): Task[] {
  let next = list

  if (Array.isArray(args.items)) {
    next = args.items.map((item: { content?: unknown; status?: unknown }, i) => ({
      id: `plan-${i + 1}`,
      title: String(item.content ?? `Step ${i + 1}`),
      status: PLAN_STATUS[String(item.status)] ?? 'waiting',
    }))
  }

  const done = Array.isArray(args.done) ? args.done : []
  next = next.map((task, i) => (done.includes(i + 1) ? { ...task, status: 'done' as const } : task))

  if (typeof args.start === 'number') {
    next = next.map((task, i) => (i + 1 === args.start ? { ...task, status: 'in_progress' as const } : task))
  }

  return stamp(list, args.advance === true ? advance(next) : next, now)
}

export function fromTodos(list: Task[], args: Args, now: number): Task[] {
  const todos = Array.isArray(args.todos) ? args.todos : []

  return stamp(
    list,
    todos.map((todo: { content?: unknown; status?: unknown }, i) => ({
      id: `todo-${i + 1}`,
      title: String(todo.content ?? `Step ${i + 1}`),
      status: PLAN_STATUS[String(todo.status)] ?? 'waiting',
    })),
    now,
  )
}

export function wrapUp(list: Task[], now: number): Task[] {
  return stamp(list, list.map(task => (task.status === 'in_progress' ? { ...task, status: 'done' as const } : task)), now)
}

export function markTask(list: Task[], step: number, status: TaskStatus, now: number): Task[] {
  return stamp(list, list.map((task, i) => (i + 1 === step ? { ...task, status } : task)), now)
}

export function createTask(list: Task[], id: string, title: string, now: number): Task[] {
  return stamp(list, [...list, { id: `task-${id}`, title, status: 'waiting' }], now)
}

export function updateTask(list: Task[], args: Args, now: number): Task[] {
  const id = `task-${String(args.taskId)}`

  if (args.status === 'deleted') return list.filter(task => task.id !== id)

  const status = PLAN_STATUS[String(args.status)]

  return stamp(
    list,
    list.map(task =>
      task.id === id
        ? { ...task, title: typeof args.subject === 'string' ? args.subject : task.title, status: status ?? task.status }
        : task,
    ),
    now,
  )
}

export function planSummary(list: Task[]): string | undefined {
  if (list.length === 0) return undefined
  const done = list.filter(task => task.status === 'done').length

  return `${done}/${list.length} · ${Math.round((done / list.length) * 100)}%`
}

export function justCompleted(before: Task[], after: Task[]): boolean {
  const isAllDone = (list: Task[]) => list.length > 0 && list.every(task => task.status === 'done')

  return before.length > 0 && !isAllDone(before) && isAllDone(after)
}

export function textBar(columns: number, ratio: number): string {
  const width = Math.max(10, Math.min(40, columns - 8))
  const fill = Math.round(width * ratio)

  return '█'.repeat(fill) + '░'.repeat(width - fill)
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)

  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`

  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

export function ago(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))

  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`

  return `${Math.floor(seconds / 3600)}h ago`
}

export function taskTime(task: Task, now: number): string | undefined {
  if (task.startedAt === undefined) return undefined
  if (task.status === 'in_progress') return duration(now - task.startedAt)
  if (task.endedAt === undefined) return undefined

  return `${task.status === 'failed' ? 'failed after' : 'done in'} ${duration(task.endedAt - task.startedAt)}`
}

export function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function splitPath(path: string): { name: string; dir: string } {
  const parts = path.split(/[\\/]/)
  const name = parts.pop() || path
  const tail = parts.slice(-3).join('/')

  return { name, dir: parts.length > 3 ? `…/${tail}` : tail }
}

export function filePath(args: Args): string | undefined {
  const path = args.file_path ?? args.notebook_path

  return typeof path === 'string' && path !== '' ? path : undefined
}

export function addFile(files: string[], path: string): string[] {
  return files.includes(path) ? files : [...files, path]
}

export function pushEvent(events: TimelineEvent[], at: number, text: string): TimelineEvent[] {
  return [...events, { at, text }].slice(-MAX_EVENTS)
}

export function describeTool(tool: string, args: Args): string | undefined {
  if (PLAN_TOOLS.includes(tool)) return undefined

  const path = filePath(args)

  if (tool === 'Bash' || tool === 'PowerShell') return truncate(`${tool}: ${String(args.description ?? args.command ?? '')}`, 80)
  if (tool === 'Skill' && typeof args.skill === 'string') return truncate(`Skill: ${args.skill}`, 80)
  if (tool === 'Agent') return truncate(`Agent: ${String(args.description ?? args.subagent_type ?? '')}`, 80)
  if (path !== undefined) return `${tool} ${splitPath(path).name}`
  if (typeof args.pattern === 'string') return truncate(`${tool}: ${args.pattern}`, 80)

  return tool.split('__').pop() || tool
}

export function subagentOf(id: string, args: Args, startedAt: number): Subagent {
  const description = truncate(String(args.description ?? args.prompt ?? 'Subagent'), 80)

  return { id, description, startedAt, ...(typeof args.subagent_type === 'string' && { type: args.subagent_type }) }
}
