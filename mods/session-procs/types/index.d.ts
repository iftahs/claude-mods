export type ProcRow = {
  pid: number
  depth: number
  label: string
  rss: number
  startedAt: number | null
}

export type ProcGroupKind = 'tool' | 'detached' | 'helper'

export type ProcGroup = {
  id: string
  kind: ProcGroupKind
  title: string
  label?: string
  pid: number
  startedAt: number | null
  rss: number
  rows: ProcRow[]
}

export type Snapshot = {
  takenAt: number
  rootPid: number
  rootLabel: string
  rootStartedAt: number | null
  chain: string
  groups: ProcGroup[]
  warning: string | null
}

export type HistoryPoint = {
  at: number
  tools: number
  rss: number
}

export type LabelRecord = {
  tool: 'Bash' | 'PowerShell'
  command: string
  label: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-procs': {
      snapshot: Snapshot | null
      history: HistoryPoint[]
      labels: LabelRecord[]
      showHelpers: boolean
      isPaneOpen: boolean
      theme: 'dark' | 'light' | null
      error: string | null
    }
  }
}
