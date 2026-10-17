import type { ProcGroup, ProcGroupKind, ProcRow, Snapshot } from '../types'

export type RawProc = {
  pid: number
  ppid: number
  name: string
  cmd: string
  rss: number
  startedAt: number | null
}

export type Probe = { self: number; procs: RawProc[] }

export type Known = ReadonlyMap<number, number | null>

const WRAPPER_NAMES = new Set([
  'powershell.exe',
  'pwsh.exe',
  'pwsh',
  'cmd.exe',
  'conhost.exe',
  'sh',
  'bash',
  'bash.exe',
  'zsh',
  'dash',
  'fish',
])
const HIDDEN_NAMES = new Set(['conhost.exe'])
const TOOL_SHELL = /shell-snapshots|CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT/
const DESKTOP_HOST = /WindowsApps[\\/]Claude_|\.app\/Contents\/MacOS\/|--type=/i
const CLAUDE_CLI = /claude-code|@anthropic-ai[\\/]claude/i
const START_TOLERANCE_MS = 2000
const MAX_CHAIN = 64

export const WINDOWS_PROBE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$procs = Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,CreationDate | ForEach-Object {' +
    ' $c = $_.CommandLine;' +
    ' if ($c -and $c.Length -gt 2000) { $c = $c.Substring(0, 2000) };' +
    ' $t = $null;' +
    ' if ($_.CreationDate) { $t = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() };' +
    ' [pscustomobject]@{ i = [int]$_.ProcessId; p = [int]$_.ParentProcessId; n = $_.Name; c = $c; m = [int64]$_.WorkingSetSize; t = $t }' +
    ' }',
  '@{ self = $PID; procs = @($procs) } | ConvertTo-Json -Compress -Depth 3',
].join('; ')

export const POSIX_PROBE_ARGV = [
  '/bin/sh',
  '-c',
  'echo $$; PATH=$(command -p getconf PATH 2>/dev/null || echo /usr/bin:/bin); export PATH; exec ps -A -o pid= -o ppid= -o rss= -o etime= -o args=',
] as const

const DEFAULT_SYSTEM_ROOT = 'C:\\Windows'
const SYSTEM_ROOT_PATTERN = /^[A-Za-z]:\\[^"<>|?*\r\n]{1,200}$/

export function safeSystemRoot(value: string | undefined): string {
  const trimmed = (value ?? '').replace(/\\+$/, '')
  return SYSTEM_ROOT_PATTERN.test(trimmed) ? trimmed : DEFAULT_SYSTEM_ROOT
}

export function windowsProbeArgv(systemRoot: string): string[] {
  return [
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_PROBE_SCRIPT,
  ]
}

const MAX_TEXT = 2000
const MAX_LABEL = 300
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const chars = Array.from(text.slice(0, max * 2))
  return text.length <= max * 2 && chars.length <= max ? text : chars.slice(0, max).join('')
}

export function cleanText(text: string): string {
  return clip(text, MAX_TEXT).replace(/\r/g, ' ').replace(CONTROL_CHARS, '\ufffd')
}

function safeLabel(text: string): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim()
  return clip(flat, MAX_LABEL) === flat ? flat : `${clip(flat, MAX_LABEL - 1)}…`
}

type WindowsRow = {
  i: number
  p: number
  n: string | null
  c: string | null
  m: number | null
  t: number | null
}

export function parseWindowsProbe(stdout: string): Probe {
  const data = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as {
    self: number
    procs: WindowsRow[] | WindowsRow
  }
  const rows = Array.isArray(data.procs) ? data.procs : [data.procs]
  return {
    self: data.self,
    procs: rows.map(row => ({
      pid: row.i,
      ppid: row.p,
      name: cleanText(row.n ?? ''),
      cmd: cleanText(row.c ?? row.n ?? ''),
      rss: row.m ?? 0,
      startedAt: row.t ?? null,
    })),
  }
}

export function parseElapsed(etime: string): number {
  const dash = etime.indexOf('-')
  const days = dash < 0 ? 0 : Number(etime.slice(0, dash))
  const parts = (dash < 0 ? etime : etime.slice(dash + 1)).split(':').map(Number).reverse()
  const seconds = (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600 + days * 86400
  return Math.round(seconds * 1000)
}

export function parsePosixProbe(stdout: string, now: number): Probe {
  const [first = '', ...lines] = stdout.split('\n')
  const procs: RawProc[] = []
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.-]+)\s+(.*)$/.exec(line)
    if (!match) continue
    const [, pid = '', ppid = '', rss = '', etime = '', args = ''] = match
    const cmd = cleanText(args).trim()
    procs.push({
      pid: Number(pid),
      ppid: Number(ppid),
      name: basename(splitExe(cmd).exe).replace(/^-/, ''),
      cmd,
      rss: Number(rss) * 1024,
      startedAt: now - parseElapsed(etime),
    })
  }
  return { self: Number(first.trim()), procs }
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

export function splitExe(cmd: string): { exe: string; rest: string } {
  const text = cmd.trim()
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1)
    if (end > 0) return { exe: text.slice(1, end), rest: text.slice(end + 1).trim() }
  }
  const space = text.indexOf(' ')
  return space < 0 ? { exe: text, rest: '' } : { exe: text.slice(0, space), rest: text.slice(space + 1).trim() }
}

function shortExe(exe: string): string {
  return basename(exe).replace(/\.exe$/i, '')
}

function shortenPath(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean)
  return segments.length <= 3 ? path : `…/${segments.slice(-2).join('/')}`
}

function shortenPaths(text: string): string {
  return text.replace(
    /"([A-Za-z]:\\[^"]*|\/[^"]*)"|([A-Za-z]:\\\S+|\/\S+\/\S+)/g,
    (_whole, quoted: string | undefined, bare: string | undefined) => shortenPath(quoted ?? bare ?? ''),
  )
}

export function commandLabel(proc: RawProc): string {
  if (!proc.cmd) return shortExe(proc.name)
  const { exe, rest } = splitExe(proc.cmd)
  return [shortExe(exe || proc.name), shortenPaths(redactSecrets(rest))].filter(Boolean).join(' ')
}

export function toolShellTitle(proc: RawProc): string {
  const unescaped = proc.cmd.replace(/\\"/g, '"')
  const evaluated = /eval '((?:[^']|'"'"'|'\\'')*)(?:'|$)/.exec(unescaped)?.[1]
  if (evaluated) return `$ ${redactSecrets(evaluated.replace(/'"'"'|'\\''/g, "'").trim())}`
  if (proc.cmd.includes('CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT')) return 'PowerShell tool command'
  return `${shortExe(proc.name)} tool command`
}

const SECRET_WORD = String.raw`(?:token|secret|password|passwd|pwd|api[-_]?key|apikey|access[-_]?key|private[-_]?key|client[-_]?secret|account[-_]?key|authorization|auth|credentials?)`.replace(
  /[a-z]/g,
  letter => `[${letter}${letter.toUpperCase()}]`,
)
const SECRET_FLAG = new RegExp(
  String.raw`(^|\s)(-{1,2}(?!-)(?![nN][oO]-)[\w-]{0,40}?${SECRET_WORD}(?![a-z])[\w-]{0,40})(?:(=)("[^"]*"|'[^']*'|["'][^"']*|\S+)|(\s+)("[^"]*"|'[^']*'|["'][^"']*|[^\s-]\S*))`,
  'g',
)
const SECRET_FLAG_REFERENCE = /(?:-|[a-z])(?:stdin|file|path|prompt|env)$/i
const SECRET_ASSIGNMENT = new RegExp(String.raw`\b(\w{0,40}?${SECRET_WORD}(?![a-z])\w{0,40})=("[^"]*"|'[^']*'|[^\s;&"']+|["'][^"']*)`, 'g')
const HEADER = /((?:X-[\w-]{0,40}(?:Key|Token|Secret|Auth)|Cookie|Authorization|Proxy-Authorization)\s*:\s*)[^"'\n]+/gi
const AUTH_HEADER = /\b(Bearer|Basic|Token)\s+[\w.~+/=-]{8,}/g
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@:]{0,256}:[^\s/@]{1,2000}@/gi
const WEBHOOK_URL = /(https?:\/\/(?:hooks\.slack\.com\/services|discord(?:app)?\.com\/api\/webhooks)\/)\S+/gi
const TELEGRAM_BOT = /(api\.telegram\.org\/bot)[^\s/]+/gi
const KNOWN_TOKENS = new RegExp(
  String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{20,512}|github_pat_\w{20,512}|sk-ant-[\w-]{10,512}|sk-(?:proj|svcacct|admin)-[\w-]{20,512}|sk-[A-Za-z0-9]{20,512}|[sr]k_(?:live|test)_\w{16,256}|xox[abposr]-[\w-]{10,512}|npm_\w{36}|glpat-[\w-]{20,256}|hf_\w{30,256}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[\w-]{35})`,
  'g',
)
const JWT = /(?<!\w)eyJ[\w-]{8,4096}\.[\w-]{8,4096}\.[\w-]{8,4096}/g

const anyCase = (word: string): string => word.replace(/[a-z]/gi, letter => `[${letter.toLowerCase()}${letter.toUpperCase()}]`)
const TOOL_GAP = String.raw`(?=\s)[^|;&\n]{0,200}?`
const TOOL_VALUE = String.raw`("[^"]*"|'[^']*'|[^\s"'-][^\s"']*)`
const toolCommand = (...names: string[]): string => String.raw`\b(?:${names.map(anyCase).join('|')})(?:\.[Ee][Xx][Ee])?`

const MYSQL_PASSWORD = new RegExp(String.raw`(${toolCommand('mysql', 'mysqldump', 'mysqladmin', 'mariadb', 'mariadb-dump', 'mariadb-admin')}${TOOL_GAP}\s)-p("[^"]*"|'[^']*'|\S+)`, 'g')
const REDIS_PASSWORD = new RegExp(String.raw`(${toolCommand('redis-cli')}${TOOL_GAP}\s-a\s+)${TOOL_VALUE}`, 'g')
const CURL_USER = new RegExp(String.raw`(${toolCommand('curl')}${TOOL_GAP}\s(?:-u\s*|--(?:proxy-)?user(?:=|\s+))["']?[^\s:"']{0,256}:)[^\s"']+`, 'g')
const SQLCMD_PASSWORD = new RegExp(String.raw`(${toolCommand('sqlcmd')}${TOOL_GAP}\s-P)\s*${TOOL_VALUE}`, 'g')
const SSHPASS_PASSWORD = new RegExp(String.raw`(${toolCommand('sshpass')}${TOOL_GAP}\s-p)\s*${TOOL_VALUE}`, 'g')
const DOCKER_LOGIN_PASSWORD = new RegExp(String.raw`(\b${anyCase('docker')}(?:\.[Ee][Xx][Ee])?\s+login${TOOL_GAP}\s-p)\s*${TOOL_VALUE}`, 'g')
const OPENSSL_PASS = new RegExp(String.raw`(${toolCommand('openssl')}${TOOL_GAP}\s-pass(?:in|out)?(?:=|\s+)["']?pass:)[^\s"']+`, 'g')
const AWS_CONFIGURE_SECRET = new RegExp(
  String.raw`(${toolCommand('aws')}\s+configure\s+set\s+(?:[^\s|;&]{1,100}\s+){0,3}?[^\s|;&]{0,100}(?:secret|token|key)[^\s|;&]{0,100}\s+)${TOOL_VALUE}`,
  'gi',
)

function maskFlag(match: string, lead: string, name: string, equals: string | undefined, _equalsValue: string | undefined, space: string | undefined): string {
  return SECRET_FLAG_REFERENCE.test(name) ? match : `${lead}${name}${equals ?? space ?? ''}***`
}

export function redactSecrets(text: string): string {
  return text
    .replace(WEBHOOK_URL, '$1***')
    .replace(TELEGRAM_BOT, '$1***')
    .replace(URL_CREDENTIALS, '$1***@')
    .replace(HEADER, '$1***')
    .replace(AUTH_HEADER, '$1 ***')
    .replace(SECRET_FLAG, maskFlag)
    .replace(SECRET_ASSIGNMENT, '$1=***')
    .replace(MYSQL_PASSWORD, '$1-p***')
    .replace(REDIS_PASSWORD, '$1***')
    .replace(CURL_USER, '$1***')
    .replace(SQLCMD_PASSWORD, '$1 ***')
    .replace(SSHPASS_PASSWORD, '$1 ***')
    .replace(DOCKER_LOGIN_PASSWORD, '$1 ***')
    .replace(OPENSSL_PASS, '$1***')
    .replace(AWS_CONFIGURE_SECRET, '$1***')
    .replace(KNOWN_TOKENS, '***')
    .replace(JWT, '***')
}

function isCmdShim(proc: RawProc): boolean {
  return proc.name.toLowerCase() === 'cmd.exe' && /\s\/c\s/i.test(proc.cmd)
}

export function helperTitle(proc: RawProc): string {
  const afterC = /\s\/c\s+(.*)$/i.exec(proc.cmd)?.[1]
  if (isCmdShim(proc) && afterC) {
    const { exe, rest } = splitExe(afterC.replace(/\^/g, ''))
    return [shortExe(exe).replace(/\.(cmd|bat)$/i, ''), shortenPaths(redactSecrets(rest))].filter(Boolean).join(' ')
  }
  const { exe, rest } = splitExe(proc.cmd)
  if (/^node(\.exe)?$/i.test(basename(exe)) && rest) {
    return basename(splitExe(redactSecrets(rest)).exe)
  }
  return shortExe(proc.name || exe)
}

function isTransparent(proc: RawProc): boolean {
  return HIDDEN_NAMES.has(proc.name.toLowerCase()) || TOOL_SHELL.test(proc.cmd) || isCmdShim(proc)
}

function isClaudeCli(proc: RawProc): boolean {
  if (CLAUDE_CLI.test(proc.cmd)) return true
  return /^claude(\.exe)?$/i.test(proc.name) && !DESKTOP_HOST.test(proc.cmd)
}

function ancestry(byPid: ReadonlyMap<number, RawProc>, self: number): RawProc[] {
  const chain: RawProc[] = []
  const seen = new Set<number>()
  let current = byPid.get(self)
  while (current && !seen.has(current.pid) && chain.length < MAX_CHAIN) {
    chain.push(current)
    seen.add(current.pid)
    current = byPid.get(current.ppid)
  }
  return chain
}

export function findRootIndex(chain: readonly RawProc[]): number {
  let index = chain.findIndex((proc, i) => i > 0 && !WRAPPER_NAMES.has(proc.name.toLowerCase()))
  if (index < 0) return chain.length > 1 ? 1 : 0
  while (index + 1 < chain.length && isClaudeCli(chain[index]!) && isClaudeCli(chain[index + 1]!)) {
    index++
  }
  return index
}

function sameStart(a: number | null | undefined, b: number | null): boolean {
  return a === null || a === undefined || b === null || Math.abs(a - b) <= START_TOLERANCE_MS
}

function byStart(a: RawProc, b: RawProc): number {
  return (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.pid - b.pid
}

export function buildSnapshot(
  probe: Probe,
  takenAt: number,
  known: Known = new Map(),
): { snapshot: Snapshot; known: Map<number, number | null> } {
  const byPid = new Map<number, RawProc>()
  const children = new Map<number, RawProc[]>()
  for (const proc of probe.procs) byPid.set(proc.pid, proc)
  for (const proc of probe.procs) {
    if (proc.pid === proc.ppid) continue
    const list = children.get(proc.ppid) ?? []
    list.push(proc)
    children.set(proc.ppid, list)
  }
  for (const list of children.values()) list.sort(byStart)

  const chain = ancestry(byPid, probe.self)
  const rootIndex = findRootIndex(chain)
  const root = chain[rootIndex]
  const excluded = new Set<number>(chain.slice(0, rootIndex).map(proc => proc.pid))
  const visited = new Set<number>()
  const nextKnown = new Map<number, number | null>()
  const groups: ProcGroup[] = []

  const exclude = (pid: number): void => {
    excluded.add(pid)
    for (const child of children.get(pid) ?? []) if (!excluded.has(child.pid)) exclude(child.pid)
  }
  exclude(probe.self)

  const remember = (proc: RawProc): void => {
    visited.add(proc.pid)
    nextKnown.set(proc.pid, proc.startedAt)
  }

  const collect = (pid: number, depth: number, rows: ProcRow[], total: { rss: number }): void => {
    for (const child of children.get(pid) ?? []) {
      if (excluded.has(child.pid) || visited.has(child.pid)) continue
      remember(child)
      total.rss += child.rss
      if (isTransparent(child)) {
        collect(child.pid, depth, rows, total)
        continue
      }
      rows.push(toRow(child, depth))
      collect(child.pid, depth + 1, rows, total)
    }
  }

  const addGroup = (top: RawProc, kind: ProcGroupKind, title: string): void => {
    remember(top)
    const rows: ProcRow[] = []
    const total = { rss: top.rss }
    const showsTop = kind !== 'tool' && !isTransparent(top)
    if (showsTop) rows.push(toRow(top, 0))
    collect(top.pid, showsTop ? 1 : 0, rows, total)
    groups.push({ id: `${kind}-${top.pid}`, kind, title: safeLabel(title), pid: top.pid, startedAt: top.startedAt, rss: total.rss, rows })
  }

  if (root && root.pid !== probe.self) {
    remember(root)
    for (const child of children.get(root.pid) ?? []) {
      if (excluded.has(child.pid) || visited.has(child.pid)) continue
      if (HIDDEN_NAMES.has(child.name.toLowerCase())) {
        remember(child)
        continue
      }
      if (TOOL_SHELL.test(child.cmd)) addGroup(child, 'tool', toolShellTitle(child))
      else addGroup(child, 'helper', helperTitle(child))
    }

    const lineage = new Set(chain.slice(rootIndex).map(proc => proc.pid))
    const wasKnown = (pid: number, startedAt: number | null): boolean =>
      known.has(pid) && sameStart(known.get(pid), startedAt)
    const parentGone = (proc: RawProc): boolean => {
      const parent = byPid.get(proc.ppid)
      if (!parent) return true
      return parent.startedAt !== null && proc.startedAt !== null && parent.startedAt > proc.startedAt + START_TOLERANCE_MS
    }
    const isDetached = (proc: RawProc): boolean => {
      if (visited.has(proc.pid) || excluded.has(proc.pid) || lineage.has(proc.pid)) return false
      if (HIDDEN_NAMES.has(proc.name.toLowerCase())) return false
      if (wasKnown(proc.pid, proc.startedAt)) return true
      if (!parentGone(proc) || !known.has(proc.ppid)) return false
      const parentStart = known.get(proc.ppid)
      return parentStart === null || parentStart === undefined || proc.startedAt === null || parentStart <= proc.startedAt + START_TOLERANCE_MS
    }
    for (const proc of [...probe.procs].sort(byStart)) {
      if (isDetached(proc)) addGroup(proc, 'detached', commandLabel(proc))
    }
  }

  const snapshot: Snapshot = {
    takenAt,
    rootPid: root?.pid ?? 0,
    rootLabel: root ? `${shortExe(root.name)} #${root.pid}` : 'unknown',
    rootStartedAt: root?.startedAt ?? null,
    chain: chain.map(proc => `${proc.name}#${proc.pid}`).join(' < '),
    groups,
    warning: !root || root.pid === probe.self ? 'Could not find the session process above the probe.' : null,
  }
  return { snapshot, known: nextKnown }
}

function toRow(proc: RawProc, depth: number): ProcRow {
  return { pid: proc.pid, depth, label: safeLabel(commandLabel(proc)), rss: proc.rss, startedAt: proc.startedAt }
}

export function toolProcessCount(snapshot: Snapshot): number {
  return snapshot.groups
    .filter(group => group.kind !== 'helper')
    .reduce((sum, group) => sum + Math.max(1, group.rows.length), 0)
}

export function helperProcessCount(snapshot: Snapshot): number {
  return snapshot.groups
    .filter(group => group.kind === 'helper')
    .reduce((sum, group) => sum + Math.max(1, group.rows.length), 0)
}

export function totalRss(snapshot: Snapshot, kind?: 'tools' | 'helpers'): number {
  return snapshot.groups
    .filter(group => (kind === undefined ? true : kind === 'helpers' ? group.kind === 'helper' : group.kind !== 'helper'))
    .reduce((sum, group) => sum + group.rss, 0)
}

export function formatAge(ms: number | null): string {
  if (ms === null || ms < 0) return '-'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`
}
