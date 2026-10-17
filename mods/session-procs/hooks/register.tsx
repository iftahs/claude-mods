import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { HistoryPoint, ProcGroup, Snapshot } from '../types'
import { callout, cardWidth, groupsCard, kpiStrip, layoutFor } from './svg'
import {
  POSIX_PROBE_ARGV,
  buildSnapshot,
  cleanText,
  clip,
  formatAge,
  formatBytes,
  helperProcessCount,
  parsePosixProbe,
  parseWindowsProbe,
  redactSecrets,
  safeSystemRoot,
  toolProcessCount,
  totalRss,
  windowsProbeArgv,
} from './tree'
import type { Probe } from './tree'

const PANE = 'session-procs'
const TITLE = 'Session processes'
const TICK_MS = 5000
const IDLE_PROBE_MS = 30000
const AFTER_TOOL_MS = 1500
const HISTORY_SIZE = 40
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const SIDEBAR_COLUMNS = 38
const SPARK = '▁▂▃▄▅▆▇█'
const MAX_TERMINAL_ROWS = 120
const MAX_ERROR = 300

const snapshot = atom({ plugin: 'session-procs', key: 'snapshot' } as const, null)
const history = atom({ plugin: 'session-procs', key: 'history' } as const, [])
const showHelpers = atom({ plugin: 'session-procs', key: 'showHelpers' } as const, false)
const error = atom({ plugin: 'session-procs', key: 'error' } as const, null)

let isWindows: boolean | undefined
let isProbing = false
let lastProbeAt = 0
let hasLoggedRoot = false
let known = new Map<number, number | null>()
let pending: Timer | undefined
let ticker: Timer | undefined

async function probe($: EngineInterface, now: number): Promise<Probe> {
  isWindows ??= (await $.env.get('OS')) === 'Windows_NT'
  const systemRoot = safeSystemRoot(isWindows ? await $.env.get('SystemRoot') : undefined)
  const ran = isWindows
    ? await $.process.run(windowsProbeArgv(systemRoot), { timeoutMs: 20000, cwd: `${systemRoot}\\System32` })
    : await $.process.run([...POSIX_PROBE_ARGV], { timeoutMs: 20000 })
  if (ran.exitCode !== 0) {
    const detail = redactSecrets(cleanText(ran.stderr)).replace(/\s+/g, ' ').trim()
    throw new Error(`Could not list processes (exit ${ran.exitCode}).${detail === '' ? '' : ` ${clip(detail, 240)}`}`)
  }
  if (ran.isStdoutTruncated) throw new Error('The process list was too large to read.')
  try {
    return isWindows ? parseWindowsProbe(ran.stdout) : parsePosixProbe(ran.stdout, now)
  } catch {
    throw new Error('Could not read the process list.')
  }
}

async function refresh($: EngineInterface): Promise<void> {
  if (isProbing) return
  isProbing = true
  try {
    const startedAt = await $.clock.now()
    lastProbeAt = startedAt
    const built = buildSnapshot(await probe($, startedAt), startedAt, known)
    known = built.known
    if (!hasLoggedRoot) {
      hasLoggedRoot = true
      $.ui.log(`session-procs: root ${built.snapshot.rootLabel}; chain ${built.snapshot.chain}`, { to: 'debug' })
    }
    const point: HistoryPoint = { at: startedAt, tools: toolProcessCount(built.snapshot), rss: totalRss(built.snapshot) }
    await update($, snapshot, () => built.snapshot)
    await update($, history, points => [...(points ?? []), point].slice(-HISTORY_SIZE))
    await update($, error, () => null)
    $.ui.status(point.tools > 0 ? `procs: ${point.tools} running from tools` : undefined)
  } catch (err) {
    const message = clip(redactSecrets(cleanText(err instanceof Error ? err.message : String(err))), MAX_ERROR)
    await update($, error, () => message)
    $.ui.log(`session-procs: ${message}`, { to: 'debug' })
  } finally {
    isProbing = false
  }
}

async function tick($: EngineInterface): Promise<void> {
  const isShown = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
  const now = await $.clock.now()
  if (isShown || now - lastProbeAt >= IDLE_PROBE_MS) await refresh($)
}

function startTicker($: EngineInterface): void {
  ticker?.cancel()
  ticker = $.clock.every(TICK_MS, () => void tick($))
}

function refreshSoon($: EngineInterface): void {
  pending?.cancel()
  pending = $.clock.after(AFTER_TOOL_MS, () => void refresh($))
}

async function openPane($: EngineInterface) {
  const surfaces = await $.session.surfaces()
  const isTerminalOnly = surfaces.length > 0 && surfaces.every(surface => surface === 'terminal')
  return $.ui.open(isTerminalOnly ? { id: PANE, title: TITLE } : { id: PANE, title: TITLE, columns: SIDEBAR_COLUMNS })
}

function toggleHelpers($: EngineInterface): Promise<unknown> {
  return update($, showHelpers, shown => !shown)
}

function sparkText(values: readonly number[]): string {
  if (values.length < 2) return ''
  const max = Math.max(...values)
  const min = Math.min(...values)
  return values
    .slice(-16)
    .map(value => SPARK[max === min ? 3 : Math.round(((value - min) / (max - min)) * (SPARK.length - 1))])
    .join('')
}

function meterText(ratio: number): string {
  const filled = Math.max(1, Math.round(Math.min(1, ratio) * 6))
  return '▰'.repeat(filled) + '▱'.repeat(6 - filled)
}

function uptime(snap: Snapshot): string {
  return formatAge(snap.rootStartedAt === null ? null : snap.takenAt - snap.rootStartedAt)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'procs',
      description: 'Show the processes this session started (tool shells, dev servers, MCP servers)',
    })
    void openPane($).catch(() => undefined)
    startTicker($)
    void refresh($)

    return next(e)
  })

  on('command.run', { command: 'procs' }, async $ => {
    const opened = await openPane($)
    void refresh($)

    return { text: opened.isPlaced ? 'Session processes pane opened.' : `Session processes pane waits: ${opened.reason}` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (SHELL_TOOLS.has(String(e.tool))) refreshSoon($)

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const snap = await read($, snapshot)
    const points = await read($, history)
    const isShowingHelpers = await read($, showHelpers)
    const failure = await read($, error)

    const toolGroups = snap?.groups.filter(group => group.kind !== 'helper') ?? []
    const helperGroups = snap?.groups.filter(group => group.kind === 'helper') ?? []
    const helperCount = snap ? helperProcessCount(snap) : 0
    const helpersLabel = isShowingHelpers ? 'Hide MCP & helpers' : `Show MCP & helpers (${helperCount})`

    if (e.surface === 'terminal') {
      const { Box, Button, Text } = $.ui.resolve(e)
      const takenAt = snap?.takenAt ?? 0
      const age = (startedAt: number | null) => formatAge(startedAt === null ? null : takenAt - startedAt)
      const tiles = snap
        ? [
            { label: 'RUNNING', value: String(toolProcessCount(snap)), spark: sparkText(points.map(point => point.tools)) },
            { label: 'MCP & HELPERS', value: String(helperCount), spark: '' },
            { label: 'MEMORY', value: formatBytes(totalRss(snap)), spark: sparkText(points.map(point => point.rss)) },
            { label: 'SESSION', value: uptime(snap), spark: '' },
          ]
        : []

      const drawGroups = (groups: readonly ProcGroup[]) => {
        const maxRss = Math.max(1, ...groups.map(group => group.rss))
        let budget = MAX_TERMINAL_ROWS
        let hidden = 0
        const drawn = groups.flatMap(whole => {
          if (budget <= 0) {
            hidden += 1 + whole.rows.length
            return []
          }
          budget -= 1
          const rows = whole.rows.slice(0, budget)
          budget -= rows.length
          hidden += whole.rows.length - rows.length
          return [{ ...whole, rows }]
        })
        const cards = drawn.map(group => (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={group.kind === 'detached' ? 'warning' : 'success'}>●</Text>
              {group.kind === 'detached' && <Text color="warning">detached</Text>}
              <Box flexGrow={1} flexShrink={1}>
                <Text bold wrap="truncate-end">{group.title}</Text>
              </Box>
              <Box flexShrink={0} gap={1}>
                <Text color="subtle">{String(group.pid).padStart(7)}</Text>
                <Text color="claude">{meterText(group.rss / maxRss)}</Text>
                <Text>{formatBytes(group.rss).padStart(7)}</Text>
                <Text color="subtle">{age(group.startedAt).padStart(7)}</Text>
              </Box>
            </Box>
            {group.rows.map(row => (
              <Box flexDirection="row" gap={1} paddingLeft={2 + row.depth * 2}>
                <Text color="subtle">└</Text>
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="truncate-end">{row.label}</Text>
                </Box>
                <Box flexShrink={0} gap={1}>
                  <Text color="subtle">{String(row.pid).padStart(7)}</Text>
                  <Text color="claude">{meterText(row.rss / maxRss)}</Text>
                  <Text color="subtle">{formatBytes(row.rss).padStart(7)}</Text>
                  <Text color="subtle">{age(row.startedAt).padStart(7)}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        ))
        return hidden > 0 ? [...cards, <Text color="subtle">{`+${hidden} more not shown`}</Text>] : cards
      }

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row" gap={1}>
              <Text bold>Session processes</Text>
              {snap && failure === null && <Text color="success">● live</Text>}
              {failure !== null && <Text color="warning">● stale</Text>}
            </Box>
            <Text color="subtle" wrap="truncate-end">{snap ? `${snap.rootLabel} · up ${uptime(snap)}` : 'Looking for processes'}</Text>
          </Box>
          {tiles.length > 0 && (
            <Box flexDirection="row" gap={3}>
              {tiles.map(one => (
                <Box flexDirection="column">
                  <Text color="subtle">{one.label}</Text>
                  <Box flexDirection="row" gap={1}>
                    <Text bold>{one.value}</Text>
                    {one.spark !== '' && <Text color="claude">{one.spark}</Text>}
                  </Box>
                </Box>
              ))}
            </Box>
          )}
          <Box flexDirection="row" gap={1}>
            <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void refresh($)} />
            <Button key="helpers" label={helpersLabel} hotkey="h" onPress={() => void toggleHelpers($)} />
          </Box>
          {failure !== null && <Text color="warning" wrap="truncate-end">{failure}</Text>}
          {snap?.warning && <Text color="warning" wrap="truncate-end">{snap.warning}</Text>}
          <Box flexDirection="column">
            <Text color="subtle">{`STARTED BY TOOLS · ${toolGroups.length}`}</Text>
            {snap !== null && toolGroups.length === 0 && (
              <Text color="subtle">Nothing running from tools. Start a dev server with Bash and it shows up here.</Text>
            )}
            {drawGroups(toolGroups)}
          </Box>
          {isShowingHelpers && (
            <Box flexDirection="column">
              <Text color="subtle">{`MCP SERVERS & HELPERS · ${formatBytes(snap ? totalRss(snap, 'helpers') : 0)}`}</Text>
              {helperGroups.length === 0 && <Text color="subtle">None.</Text>}
              {drawGroups(helperGroups)}
            </Box>
          )}
        </Box>
      )
    }

    const { Box, Button, Svg, Text } = $.ui.resolve(e)
    const width = cardWidth(e.props.bodyColumns)
    const cards = snap
      ? [
          kpiStrip(snap, points, width),
          groupsCard({
            title: 'Started by tools',
            groups: toolGroups,
            width,
            takenAt: snap.takenAt,
            emptyTitle: 'Nothing running from tools',
            emptyHint: 'Start a dev server with Bash and it shows up here.',
          }),
          ...(isShowingHelpers
            ? [
                groupsCard({
                  title: 'MCP servers & helpers',
                  groups: helperGroups,
                  width,
                  takenAt: snap.takenAt,
                  emptyTitle: 'No MCP servers or helpers',
                  emptyHint: 'Servers this session starts show up here.',
                }),
              ]
            : []),
        ]
      : []
    const notice = failure ?? snap?.warning ?? null
    const isCompact = layoutFor(width) === 'compact'
    const toggleLabel = isCompact ? (isShowingHelpers ? 'Hide helpers' : `Helpers (${helperCount})`) : helpersLabel

    return (
      <Box flexDirection="column" gap={1}>
        <Box
          flexDirection={isCompact ? 'column' : 'row'}
          justifyContent="space-between"
          alignItems={isCompact ? 'flex-start' : 'center'}
          gap={1}
        >
          <Box flexDirection="row" gap={1}>
            <Text bold>Session processes</Text>
            {snap && failure === null && <Text color="success">●</Text>}
            {snap && failure === null && <Text dimColor>Live</Text>}
          </Box>
          <Box flexDirection="row" gap={1}>
            <Button key="helpers" label={toggleLabel} hotkey="h" onPress={() => void toggleHelpers($)} />
            <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void refresh($)} />
          </Box>
        </Box>
        {notice !== null && <Svg {...svgProps(callout(failure !== null ? 'danger' : 'warning', notice, width))} />}
        {snap === null && failure === null && <Text dimColor>Looking for this session's processes</Text>}
        {cards.map(one => (
          <Svg {...svgProps(one)} />
        ))}
      </Box>
    )
  })
}

function svgProps(one: { source: string; alt: string; width: number; height: number }) {
  return { source: one.source, alt: one.alt }
}
