import { describe, expect, test } from 'claude-code/testing'

import type { ProcGroup, Snapshot } from '../types'
import { callout, cardWidth, esc, fit, groupsCard, kpiStrip, sparkline } from './svg'

const T0 = 1_792_000_000_000
const MB = 1024 * 1024

const tools: ProcGroup[] = [
  {
    id: 'tool-1',
    kind: 'tool',
    title: '$ node -e "a < b && c > d"',
    pid: 31600,
    startedAt: T0 - 120_000,
    rss: 180 * MB,
    rows: [{ pid: 105836, depth: 0, label: 'node -e "a < b && c > d"', rss: 150 * MB, startedAt: T0 - 119_000 }],
  },
  { id: 'detached-2', kind: 'detached', title: 'node server.js', pid: 7000, startedAt: T0 - 3_600_000, rss: 1.5 * 1024 * MB, rows: [] },
]

const snap: Snapshot = {
  takenAt: T0,
  rootPid: 97264,
  rootLabel: 'claude #97264',
  rootStartedAt: T0 - 8_040_000,
  chain: '',
  groups: [...tools, { id: 'helper-3', kind: 'helper', title: 'context7-mcp', pid: 91316, startedAt: T0 - 8_000_000, rss: 100 * MB, rows: [] }],
  warning: null,
}

function isBalanced(source: string): boolean {
  const opened = source.match(/<text\b/g)?.length ?? 0
  const closed = source.match(/<\/text>/g)?.length ?? 0
  return opened === closed && source.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && source.endsWith('</svg>')
}

function textContents(source: string): string[] {
  return [...source.matchAll(/<text[^>]*>([^]*?)<\/text>/g)].map(match => match[1] ?? '')
}

describe('svg cards', () => {
  test('escapes command lines and keeps every text node free of raw markup', () => {
    const one = groupsCard({ title: 'Started by tools', groups: tools, width: 720, takenAt: T0, emptyTitle: 'x', emptyHint: 'y' })
    expect(isBalanced(one.source)).toBe(true)
    expect(one.source).toContain('&lt; b &amp;&amp; c &gt; d')
    for (const content of textContents(one.source)) expect(/[<>]/.test(content)).toBe(false)
    expect(one.source).toContain(`height="${one.height}"`)
  })

  test('marks the detached group and warns on a process over 1 GB', () => {
    const one = groupsCard({ title: 'Started by tools', groups: tools, width: 720, takenAt: T0, emptyTitle: 'x', emptyHint: 'y' })
    expect(one.source).toContain('>Detached</text>')
    expect(one.source).toContain('class="warning" x=')
    expect(one.source).toContain('>1.5 GB</text>')
    expect(one.source).toContain('>1h 0m</text>')
  })

  test('narrow cards drop the pid and meter columns', () => {
    const one = groupsCard({ title: 'Started by tools', groups: tools, width: 400, takenAt: T0, emptyTitle: 'x', emptyHint: 'y' })
    expect(one.source).not.toContain('>PID</text>')
    expect(one.source).not.toContain('class="track"')
  })

  test('sidebar width stacks each process on two lines and keeps text inside the card', () => {
    const one = groupsCard({ title: 'Started by tools', groups: tools, width: 277, takenAt: T0, emptyTitle: 'x', emptyHint: 'y' })
    expect(one.source).not.toContain('>MEMORY</text>')
    expect(one.source).toContain('>180 MB · 2m 0s · 31600</text>')
    expect(one.source).toContain('class="track"')
    for (const match of one.source.matchAll(/<text x="([\d.]+)"[^>]*>([^<]*)<\/text>/g)) {
      const x = Number(match[1])
      const isAnchoredEnd = match[0].includes('text-anchor="end"')
      const shown = (match[2] ?? '').replace(/&(lt|gt|amp|quot);/g, '_')
      const right = isAnchoredEnd ? x : x + shown.length * 7.8
      expect(right <= 277).toBe(true)
    }
    const kpi = kpiStrip(snap, [], 277)
    expect(kpi.height).toBe(82 * 2 + 8)
    expect(isBalanced(kpi.source)).toBe(true)
  })

  test('empty state says what is missing and what makes it appear', () => {
    const one = groupsCard({
      title: 'Started by tools',
      groups: [],
      width: 600,
      takenAt: T0,
      emptyTitle: 'Nothing running from tools',
      emptyHint: 'Start a dev server with Bash and it shows up here.',
    })
    expect(one.alt).toBe('Started by tools: Nothing running from tools')
    expect(one.source).toContain('Start a dev server with Bash and it shows up here.')
  })

  test('row cap keeps big trees bounded', () => {
    const many: ProcGroup = {
      ...tools[0]!,
      rows: Array.from({ length: 300 }, (_, i) => ({ pid: i + 1, depth: 0, label: `worker ${i}`, rss: MB, startedAt: T0 })),
    }
    const one = groupsCard({ title: 'Started by tools', groups: [many], width: 720, takenAt: T0, emptyTitle: 'x', emptyHint: 'y' })
    expect(one.source).toContain('+181 more not shown')
    expect(one.source.length).toBeLessThan(131_072)
  })

  test('a card stays under 128 KiB when every title is 300 characters that escape to six', () => {
    const groups: ProcGroup[] = Array.from({ length: 120 }, (_, i) => ({
      id: `detached-${i}`,
      kind: 'detached' as const,
      title: '"'.repeat(300),
      pid: 1000 + i,
      startedAt: T0 - 60_000,
      rss: MB,
      rows: [],
    }))
    const one = groupsCard({ title: 'Started by tools', groups, width: 960, takenAt: T0, emptyTitle: 'x', emptyHint: 'y' })
    expect(one.source.length).toBeLessThanOrEqual(131_072)
    expect(one.source).toContain('more not shown')
    expect(isBalanced(one.source)).toBe(true)
    expect(one.height).toBeGreaterThan(0)
  })

  test('a card that already fits keeps every row', () => {
    const one = groupsCard({ title: 'Started by tools', groups: tools, width: 720, takenAt: T0, emptyTitle: 'x', emptyHint: 'y' })
    expect(one.source).not.toContain('more not shown')
  })

  test('truncation counts code points and never leaves half an emoji', () => {
    const isBroken = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
    const emoji = '\u{1F600}'.repeat(20)
    const cut = fit(emoji, 60, 12, true)
    expect(Array.from(cut).length).toBe(8)
    expect(cut).toBe(`${'\u{1F600}'.repeat(7)}…`)
    expect(isBroken.test(cut)).toBe(false)
    const many: ProcGroup[] = Array.from({ length: 40 }, (_, i) => ({
      id: `detached-${i}`,
      kind: 'detached' as const,
      title: emoji.repeat(10),
      pid: i + 1,
      startedAt: null,
      rss: MB,
      rows: [],
    }))
    const one = groupsCard({ title: 'Started by tools', groups: many, width: 720, takenAt: T0, emptyTitle: 'x', emptyHint: 'y' })
    expect(Array.from(one.alt).length).toBe(600)
    expect(isBroken.test(one.alt)).toBe(false)
    expect(isBroken.test(one.source)).toBe(false)
  })

  test('kpi strip lays out four tiles, two rows when narrow', () => {
    const history = [1, 2, 2, 3].map((n, i) => ({ at: T0 + i, tools: n, rss: n * MB }))
    const wide = kpiStrip(snap, history, 800)
    const narrow = kpiStrip(snap, history, 400)
    expect(wide.height).toBe(96)
    expect(narrow.height).toBe(96 * 2 + 12)
    expect(wide.alt).toBe('Running: 2, Helpers: 1, Memory: 1.8 GB, Session: 2h 14m')
    expect(wide.source).toContain('>RUNNING</text>')
    expect(wide.source).toContain('class="success pulse"')
    expect(isBalanced(wide.source)).toBe(true)
  })

  test('sparkline needs two points and stays inside its box', () => {
    expect(sparkline(0, 0, 100, 20, [5])).toBe('')
    const line = sparkline(10, 40, 100, 20, [0, 10, 5])
    const points = /<polyline[^>]*points="([^"]+)"/.exec(line)?.[1]?.split(' ') ?? []
    for (const point of points) {
      const [x, y] = point.split(',').map(Number)
      expect(x! >= 10 && x! <= 110 && y! >= 40 && y! <= 60).toBe(true)
    }
  })

  test('helpers', () => {
    expect(esc('a<b>&"c"\u0007')).toBe('a&lt;b&gt;&amp;&quot;c&quot; ')
    expect(esc('a\ud800b\udc00c\ufffed\uffffe\u{1F600}')).toBe('a b c d e\u{1F600}')
    expect(fit('abcdefgh', 60, 12, true)).toBe('abcdefgh')
    expect(fit('abcdefghijklmnop', 60, 12, true)).toBe('abcdefg…')
    expect(cardWidth(undefined)).toBe(642)
    expect(cardWidth(10)).toBe(260)
    expect(cardWidth(500)).toBe(960)
    expect(callout('danger', 'Could not list processes', 500).source).toContain('class="danger-soft"')
  })
})
