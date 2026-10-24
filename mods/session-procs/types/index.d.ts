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

declare module 'claude-code' {
  interface PluginState {
    'session-procs': {
      snapshot: Snapshot | null
      history: HistoryPoint[]
      showHelpers: boolean
      isPaneOpen: boolean
      error: string | null
    }
  }
}
