import type { HistoryPoint, ProcGroup, Snapshot } from '../types'
import { clip, formatAge, formatBytes, helperProcessCount, toolProcessCount, totalRss } from './tree'

export type SvgCard = { source: string; width: number; height: number; alt: string }

export type CardLayout = 'wide' | 'medium' | 'compact'

const SANS = "Inter, 'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, sans-serif"
const MONO = "'JetBrains Mono', 'Cascadia Mono', Consolas, ui-monospace, Menlo, monospace"
const SANS_EM = 0.56
const MONO_EM = 0.6
const LABEL_EM = 0.72
const PX_PER_COLUMN = 7.3
const GB = 1024 * 1024 * 1024
const MAX_SOURCE = 131072
const MAX_ALT = 600
const MIN_ROWS = 8

const DARK = {
  card: '#15151a',
  border: '#26262f',
  borderStrong: '#3a3a46',
  hover: '#22222b',
  fg: '#ededf0',
  muted: '#a6a6b0',
  subtle: '#8e8e99',
  accent: '#d97757',
  accentSoft: '#2b1c16',
  success: '#35b58a',
  warning: '#e0a12b',
  warningSoft: '#2a2010',
  warningFg: '#f0b94e',
  danger: '#f0605f',
  dangerSoft: '#2e1616',
  dangerFg: '#ff9090',
}

const LIGHT: typeof DARK = {
  card: '#ffffff',
  border: '#e4e4e0',
  borderStrong: '#cfcfca',
  hover: '#ececea',
  fg: '#19191d',
  muted: '#55555e',
  subtle: '#696972',
  accent: '#bd5230',
  accentSoft: '#fbeee8',
  success: '#0c8a60',
  warning: '#b97400',
  warningSoft: '#fcf2da',
  warningFg: '#805100',
  danger: '#cf3a3a',
  dangerSoft: '#fdeaea',
  dangerFg: '#ad2626',
}

function rules(p: typeof DARK): string {
  return [
    `.card{fill:${p.card};stroke:${p.border}}`,
    `.track,.badge{fill:${p.hover}}`,
    `.rule{stroke:${p.border}}`,
    `.tree{stroke:${p.borderStrong};fill:none}`,
    `.fg{fill:${p.fg}}`,
    `.muted{fill:${p.muted}}`,
    `.subtle{fill:${p.subtle}}`,
    `.accent{fill:${p.accent}}`,
    `.spark{stroke:${p.accent};fill:none}`,
    `.spark-area{fill:${p.accentSoft}}`,
    `.success{fill:${p.success}}`,
    `.warning{fill:${p.warning}}`,
    `.warning-soft{fill:${p.warningSoft}}`,
    `.warning-fg{fill:${p.warningFg}}`,
    `.danger{fill:${p.danger}}`,
    `.danger-soft{fill:${p.dangerSoft}}`,
    `.danger-fg{fill:${p.dangerFg}}`,
  ].join('')
}

const STYLE = [
  rules(DARK),
  `.sans{font-family:${SANS}}`,
  `.mono{font-family:${MONO}}`,
  'text{font-variant-numeric:tabular-nums;white-space:pre}',
  '.pulse{transform-box:fill-box;transform-origin:center;animation:pulse 2.4s ease-out infinite}',
  '@keyframes pulse{0%{opacity:.55;transform:scale(1)}100%{opacity:0;transform:scale(2.8)}}',
  '@media (prefers-reduced-motion: reduce){.pulse{animation:none;opacity:0}}',
  `@media (prefers-color-scheme: light){${rules(LIGHT)}}`,
].join('')

export function cardWidth(bodyColumns: number | undefined): number {
  return Math.max(260, Math.min(960, Math.round((bodyColumns ?? 88) * PX_PER_COLUMN)))
}

export function layoutFor(width: number): CardLayout {
  if (width >= 520) return 'wide'
  return width >= 400 ? 'medium' : 'compact'
}

const UNSAFE_XML_CHARS = /[\u0000-\u001f\u007f]+|[\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

export function esc(value: string): string {
  return value
    .replace(UNSAFE_XML_CHARS, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function fit(value: string, px: number, size: number, isMono = false, em = isMono ? MONO_EM : SANS_EM): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  const max = Math.floor(px / (size * em))
  if (max < 2) return ''
  if (flat.length <= max) return flat
  const chars = Array.from(flat)
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`
}

function num(value: number): string {
  return String(Math.round(value * 10) / 10)
}

type TextOptions = {
  cls: string
  size: number
  weight?: number
  anchor?: 'end' | 'middle'
  isMono?: boolean
  spacing?: number
}

function text(x: number, y: number, value: string, o: TextOptions): string {
  const attrs = [`x="${num(x)}"`, `y="${num(y)}"`, `class="${o.isMono ? 'mono' : 'sans'} ${o.cls}"`, `font-size="${o.size}"`]
  if (o.weight) attrs.push(`font-weight="${o.weight}"`)
  if (o.anchor) attrs.push(`text-anchor="${o.anchor}"`)
  if (o.spacing) attrs.push(`letter-spacing="${o.spacing}"`)
  return `<text ${attrs.join(' ')}>${esc(value)}</text>`
}

function textWidth(value: string, size: number, isMono = false): number {
  return value.length * size * (isMono ? MONO_EM : SANS_EM)
}

function dot(cx: number, cy: number, cls: string, isLive: boolean): string {
  const ring = isLive ? `<circle class="${cls} pulse" cx="${num(cx)}" cy="${num(cy)}" r="4"/>` : ''
  return `${ring}<circle class="${cls}" cx="${num(cx)}" cy="${num(cy)}" r="4"/>`
}

function memoryClass(bytes: number): string {
  if (bytes >= 2 * GB) return 'danger'
  if (bytes >= GB) return 'warning'
  return 'accent'
}

function meter(x: number, cy: number, width: number, ratio: number, cls: string): string {
  const filled = Math.max(3, Math.round(width * Math.min(1, Math.max(0, ratio))))
  const y = num(cy - 2)
  return `<rect class="track" x="${num(x)}" y="${y}" width="${num(width)}" height="4" rx="2"/><rect class="${cls}" x="${num(x)}" y="${y}" width="${num(filled)}" height="4" rx="2"/>`
}

function card(x: number, y: number, width: number, height: number): string {
  return `<rect class="card" x="${num(x + 0.5)}" y="${num(y + 0.5)}" width="${num(width - 1)}" height="${num(height - 1)}" rx="10" stroke-width="1"/>`
}

function wrap(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${STYLE}</style>${body}</svg>`
}

export function sparkline(x: number, y: number, width: number, height: number, values: readonly number[]): string {
  if (values.length < 2) return ''
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min
  const points = values.map((value, i) => {
    const level = span === 0 ? 0.5 : (value - min) / span
    return [x + (width * i) / (values.length - 1), y + height - level * height] as const
  })
  const line = points.map(([px, py]) => `${num(px)},${num(py)}`).join(' ')
  const area = `${num(x)},${num(y + height)} ${line} ${num(x + width)},${num(y + height)}`
  const last = points[points.length - 1]!
  return (
    `<polygon class="spark-area" points="${area}"/>` +
    `<polyline class="spark" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" points="${line}"/>` +
    `<circle class="accent" cx="${num(last[0])}" cy="${num(last[1])}" r="2.5"/>`
  )
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

type Tile = { label: string; value: string; sub: string; series?: number[]; isLive?: boolean }

type TileMetrics = { pad: number; height: number; labelY: number; valueY: number; sparkY: number; sparkH: number; subInset: number }

const TILE_REGULAR: TileMetrics = { pad: 16, height: 96, labelY: 28, valueY: 60, sparkY: 42, sparkH: 20, subInset: 16 }
const TILE_COMPACT: TileMetrics = { pad: 12, height: 82, labelY: 22, valueY: 50, sparkY: 34, sparkH: 18, subInset: 12 }

function tile(t: Tile, x: number, y: number, width: number, m: TileMetrics): string {
  const parts = [card(x, y, width, m.height)]
  const labelRoom = width - m.pad * 2 - (t.isLive ? 14 : 0)
  parts.push(text(x + m.pad, y + m.labelY, fit(t.label.toUpperCase(), labelRoom, 12, false, LABEL_EM), { cls: 'subtle', size: 12, weight: 500, spacing: 0.5 }))
  if (t.isLive) parts.push(dot(x + width - m.pad - 4, y + m.labelY - 4, 'success', true))
  const value = fit(t.value, width - m.pad * 2, 20, false, 0.62)
  parts.push(text(x + m.pad, y + m.valueY, value, { cls: 'fg', size: 20, weight: 600 }))
  const sparkLeft = x + m.pad + textWidth(value, 20) * 1.1 + 12
  const sparkWidth = Math.min(120, x + width - m.pad - sparkLeft)
  if (t.series !== undefined && t.series.length >= 2 && sparkWidth >= 28) {
    parts.push(sparkline(x + width - m.pad - sparkWidth, y + m.sparkY, sparkWidth, m.sparkH, t.series.slice(-30)))
  }
  parts.push(text(x + m.pad, y + m.height - m.subInset, fit(t.sub, width - m.pad * 2, 12), { cls: 'subtle', size: 12 }))
  return parts.join('')
}

export function kpiStrip(snap: Snapshot, history: readonly HistoryPoint[], width: number): SvgCard {
  const toolGroups = snap.groups.filter(group => group.kind !== 'helper')
  const detached = snap.groups.filter(group => group.kind === 'detached').length
  const servers = snap.groups.filter(group => group.kind === 'helper').length
  const tools = toolProcessCount(snap)
  const commands = toolGroups.length - detached
  const tiles: Tile[] = [
    {
      label: 'Running',
      value: String(tools),
      sub: toolGroups.length === 0 ? 'Nothing running' : [commands ? plural(commands, 'command') : '', detached ? `${detached} detached` : ''].filter(Boolean).join(', '),
      series: history.map(point => point.tools),
      isLive: tools > 0,
    },
    { label: 'Helpers', value: String(helperProcessCount(snap)), sub: plural(servers, 'server') },
    {
      label: 'Memory',
      value: formatBytes(totalRss(snap)),
      sub: `Tools ${formatBytes(totalRss(snap, 'tools'))}`,
      series: history.map(point => point.rss),
    },
    {
      label: 'Session',
      value: formatAge(snap.rootStartedAt === null ? null : snap.takenAt - snap.rootStartedAt),
      sub: snap.rootLabel,
    },
  ]
  const isCompact = layoutFor(width) === 'compact'
  const metrics = isCompact ? TILE_COMPACT : TILE_REGULAR
  const cols = width >= 600 ? 4 : 2
  const gap = isCompact ? 8 : 12
  const tileWidth = (width - gap * (cols - 1)) / cols
  const rows = Math.ceil(tiles.length / cols)
  const height = rows * metrics.height + (rows - 1) * gap
  const body = tiles
    .map((one, i) => tile(one, (i % cols) * (tileWidth + gap), Math.floor(i / cols) * (metrics.height + gap), tileWidth, metrics))
    .join('')
  return {
    source: wrap(width, height, body),
    width,
    height,
    alt: tiles.map(one => `${one.label}: ${one.value}`).join(', '),
  }
}

export type GroupsCardOptions = {
  title: string
  groups: readonly ProcGroup[]
  width: number
  takenAt: number
  emptyTitle: string
  emptyHint: string
  maxRows?: number
}

type RowCells = { pid: number; rss: number; startedAt: number | null }

function renderGroupsCard(o: GroupsCardOptions, maxRows: number): SvgCard {
  const W = o.width
  const layout = layoutFor(W)
  const isCompact = layout === 'compact'
  const PAD = isCompact ? 14 : 20
  const HEAD = isCompact ? 46 : 52
  const GROUP_H = isCompact ? 50 : 40
  const ROW_H = isCompact ? 42 : 30
  const R = W - PAD
  const ageX = R
  const memX = R - 76
  const meterW = 56
  const meterX = memX - 56 - meterW
  const pidX = layout === 'wide' ? meterX - 16 : memX - 56
  const labelRight = isCompact ? R : layout === 'wide' ? pidX - 56 : pidX - 8
  const age = (startedAt: number | null) => formatAge(startedAt === null ? null : o.takenAt - startedAt)
  const maxRss = Math.max(1, ...o.groups.map(group => group.rss))
  const count = o.groups.reduce((sum, group) => sum + Math.max(1, group.rows.length), 0)
  const titleY = isCompact ? 28 : 31

  const parts: string[] = []
  parts.push(text(PAD, titleY, o.title, { cls: 'fg', size: 14, weight: 600 }))
  if (o.groups.length > 0) {
    const label = String(count)
    const badgeX = PAD + textWidth(o.title, 14) + 10
    const badgeW = Math.max(20, textWidth(label, 12) + 14)
    parts.push(`<rect class="badge" x="${num(badgeX)}" y="${titleY - 15}" width="${num(badgeW)}" height="20" rx="10"/>`)
    parts.push(text(badgeX + badgeW / 2, titleY - 1, label, { cls: 'muted', size: 12, weight: 500, anchor: 'middle' }))
    if (!isCompact) {
      if (layout === 'wide') parts.push(text(pidX, titleY, 'PID', { cls: 'subtle', size: 12, weight: 500, anchor: 'end', spacing: 0.5 }))
      parts.push(text(memX, titleY, 'MEMORY', { cls: 'subtle', size: 12, weight: 500, anchor: 'end', spacing: 0.5 }))
      parts.push(text(ageX, titleY, 'AGE', { cls: 'subtle', size: 12, weight: 500, anchor: 'end', spacing: 0.5 }))
    }
  }
  parts.push(`<line class="rule" x1="${PAD}" y1="${HEAD - 6}" x2="${R}" y2="${HEAD - 6}" stroke-width="1"/>`)

  const columns = (cy: number, cells: RowCells, isGroup: boolean) => {
    const cls = isGroup ? 'muted' : 'subtle'
    const out = []
    if (layout === 'wide') {
      out.push(text(pidX, cy + 4, String(cells.pid), { cls: 'subtle', size: 12, anchor: 'end', isMono: true }))
      out.push(meter(meterX, cy, meterW, cells.rss / maxRss, memoryClass(cells.rss)))
    }
    out.push(text(memX, cy + 4, formatBytes(cells.rss), { cls, size: 12, anchor: 'end', isMono: true }))
    out.push(text(ageX, cy + 4, age(cells.startedAt), { cls, size: 12, anchor: 'end', isMono: true }))
    return out.join('')
  }

  const metaLine = (x: number, baseline: number, cells: RowCells) => {
    const compactMeterW = 40
    const meta = `${formatBytes(cells.rss)} · ${age(cells.startedAt)} · ${cells.pid}`
    return (
      text(x, baseline, fit(meta, R - compactMeterW - 10 - x, 12, true), { cls: 'subtle', size: 12, isMono: true }) +
      meter(R - compactMeterW, baseline - 4, compactMeterW, cells.rss / maxRss, memoryClass(cells.rss))
    )
  }

  let y = HEAD
  let drawn = 0
  let hidden = 0
  if (o.groups.length === 0) {
    parts.push(text(W / 2, HEAD + 30, fit(o.emptyTitle, W - PAD * 2, 14), { cls: 'fg', size: 14, weight: 500, anchor: 'middle' }))
    const hint = fit(o.emptyHint, W - PAD * 2, 13)
    parts.push(text(W / 2, HEAD + 52, hint, { cls: 'muted', size: 13, anchor: 'middle' }))
    y = HEAD + 76
  }
  o.groups.forEach((group, gi) => {
    if (drawn >= maxRows) {
      hidden += 1 + group.rows.length
      return
    }
    if (gi > 0) parts.push(`<line class="rule" x1="${PAD}" y1="${num(y)}" x2="${R}" y2="${num(y)}" stroke-width="1"/>`)
    const cy = isCompact ? y + 18 : y + GROUP_H / 2
    const isDetached = group.kind === 'detached'
    parts.push(dot(PAD + 4, cy, isDetached ? 'warning' : 'success', group.kind === 'tool'))
    let labelX = PAD + 18
    if (isDetached) {
      parts.push(`<rect class="warning-soft" x="${labelX}" y="${num(cy - 10)}" width="68" height="20" rx="6"/>`)
      parts.push(text(labelX + 8, cy + 4, 'Detached', { cls: 'warning-fg', size: 12, weight: 500 }))
      labelX += 76
    }
    const isCommand = group.kind !== 'helper'
    const titleSize = isCommand ? 13 : 14
    parts.push(
      text(labelX, cy + 4.5, fit(group.title, labelRight - labelX, titleSize, isCommand), {
        cls: 'fg',
        size: titleSize,
        weight: isCommand ? undefined : 500,
        isMono: isCommand,
      }),
    )
    parts.push(isCompact ? metaLine(PAD + 18, cy + 22, group) : columns(cy, group, true))
    y += GROUP_H
    drawn += 1

    for (const row of group.rows) {
      if (drawn >= maxRows) {
        hidden += 1
        continue
      }
      const rowCy = isCompact ? y + 12 : y + ROW_H / 2 - 3
      const connX = PAD + 4 + row.depth * (isCompact ? 12 : 16)
      const reach = isCompact ? ROW_H - 2 : ROW_H - 4
      parts.push(`<path class="tree" stroke-width="1" d="M${num(connX)} ${num(rowCy - reach)} V${num(rowCy)} H${num(connX + 9)}"/>`)
      const rowLabelX = connX + 15
      parts.push(text(rowLabelX, rowCy + 4, fit(row.label, labelRight - rowLabelX, 12, true), { cls: 'muted', size: 12, isMono: true }))
      parts.push(isCompact ? metaLine(rowLabelX, rowCy + 21, row) : columns(rowCy, row, false))
      y += ROW_H
      drawn += 1
    }
    if (group.rows.length > 0) y += isCompact ? 2 : 6
  })
  if (hidden > 0) {
    parts.push(text(PAD, y + 20, `+${hidden} more not shown`, { cls: 'subtle', size: 12 }))
    y += 30
  }
  const height = Math.ceil(y + 10)
  const alt = `${o.title}: ${o.groups.length === 0 ? o.emptyTitle : o.groups.map(group => (group.rows.length ? `${group.title} (${group.rows.map(row => row.label).join(', ')})` : group.title)).join('; ')}`
  return { source: wrap(W, height, card(0, 0, W, height) + parts.join('')), width: W, height, alt: clip(alt, MAX_ALT) }
}

export function groupsCard(o: GroupsCardOptions): SvgCard {
  let maxRows = o.maxRows ?? 120
  let result = renderGroupsCard(o, maxRows)
  while (result.source.length > MAX_SOURCE && maxRows > MIN_ROWS) {
    maxRows = Math.max(MIN_ROWS, Math.floor(maxRows / 2))
    result = renderGroupsCard(o, maxRows)
  }
  return result
}

export function callout(kind: 'warning' | 'danger', message: string, width: number): SvgCard {
  const height = 40
  const body =
    `<rect class="${kind}-soft" x="0" y="0" width="${width}" height="${height}" rx="8"/>` +
    dot(18, 20, kind, false) +
    text(32, 24.5, fit(message, width - 48, 13), { cls: `${kind}-fg`, size: 13 })
  return { source: wrap(width, height, body), width, height, alt: clip(message, MAX_ALT) }
}
