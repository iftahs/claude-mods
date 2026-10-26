export type TaskStatus = 'waiting' | 'in_progress' | 'done' | 'failed'
export type Task = { id: string; title: string; status: TaskStatus; startedAt?: number; endedAt?: number }

export type ActivityKind = 'working' | 'waiting' | 'input' | 'stopped'
export type Activity = { kind: ActivityKind; text: string }

export type Wait = { text: string; source: 'claude' | 'background' | 'schedule' }
export type TimelineEvent = { at: number; text: string }
export type Subagent = { id: string; description: string; type?: string; startedAt: number }
export type ToolError = { tool: string; text: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'work-status': {
      activity: Activity | null
      waits: Wait[]
      background: Wait[]
      tasks: Task[]
      frame: number
      now: number
      isPaneOpen: boolean
      files: string[]
      events: TimelineEvent[]
      turnStartedAt: number | null
      contextPercent: number | null
      agents: Subagent[]
      errors: ToolError[]
      decision: string | null
    }
  }
}
