import { describe, expect, test } from 'claude-code/testing'

import type { ProcGroup, Snapshot } from '../types'
import type { CardTheme } from './svg'
import { DARK, LIGHT, callout, cardWidth, esc, fit, groupsCard, kpiStrip, sparkline, wrapLines } from './svg'

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

  describe('long commands', () => {
    const LONG = '$ cd "/e/dev-projects/Movies App/app" && npx expo start --port 8081 --clear --offline --host lan --scheme movies'
    const CARD = { title: 'Started by tools', takenAt: T0, emptyTitle: 'x', emptyHint: 'y' }
    const group = (title: string, extra: Partial<ProcGroup> = {}): ProcGroup => ({
      id: 'tool-9',
      kind: 'tool',
      title,
      pid: 9,
      startedAt: T0 - 60_000,
      rss: 50 * MB,
      rows: [],
      ...extra,
    })
    const commandLines = (source: string) =>
      [...source.matchAll(/<text x="[\d.]+" y="[\d.]+" class="mono (?:fg|muted)" font-size="1[23]">([^<]*)<\/text>/g)].map(match =>
        (match[1] ?? '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
      )
    const words = (lines: string[]) => lines.join(' ').split(' ').filter(Boolean)

    test('wrapLines breaks at spaces, hard-breaks long tokens and ends in … only when text is left', () => {
      expect(wrapLines('aaa bbb ccc', 60, 12, true, 5)).toEqual(['aaa bbb', 'ccc'])
      expect(wrapLines('aaa  bbb\n ccc', 1000, 12, true, 5)).toEqual(['aaa bbb ccc'])
      expect(wrapLines('a'.repeat(20), 60, 12, true, 5)).toEqual(['a'.repeat(8), 'a'.repeat(8), 'aaaa'])
      expect(wrapLines('xx ' + 'a'.repeat(10), 60, 12, true, 5)).toEqual(['xx', 'a'.repeat(8), 'aa'])
      expect(wrapLines('aaa bbb ccc ddd eee', 60, 12, true, 2)).toEqual(['aaa bbb', 'ccc ddd…'])
      expect(wrapLines('aaa bbb ccc ddd', 60, 12, true, 2)).toEqual(['aaa bbb', 'ccc ddd'])
      expect(wrapLines('a'.repeat(30), 60, 12, true, 2)).toEqual(['a'.repeat(8), 'a'.repeat(7) + '…'])
      expect(wrapLines('a'.repeat(40), 60, 12, true, 3)).toEqual(['a'.repeat(8), 'a'.repeat(8), 'a'.repeat(7) + '…'])
      expect(wrapLines('', 60, 12, true, 3)).toEqual([])
      expect(wrapLines('aaa bbb', 60, 12, true, 0)).toEqual([])
    })

    test('wrapLines gives the first line its own width and never splits a code point', () => {
      expect(wrapLines('aaa bbb ccc ddd', 60, 12, true, 5, 36)).toEqual(['aaa', 'bbb ccc', 'ddd'])
      const emoji = '\u{1F600}'.repeat(20)
      const lines = wrapLines(emoji, 60, 12, true, 4)
      expect(lines.map(line => Array.from(line).length)).toEqual([8, 8, 4])
      expect(lines.join('')).toBe(emoji)
      expect(wrapLines(emoji, 60, 12, true, 2).at(-1)).toBe(`${'\u{1F600}'.repeat(7)}…`)
    })

    test('a long command takes more lines and keeps every word of it', () => {
      for (const width of [720, 277]) {
        const short = groupsCard({ ...CARD, groups: [group('$ npm run dev')], width })
        const long = groupsCard({ ...CARD, groups: [group(LONG)], width })
        expect(long.height).toBeGreaterThan(short.height)
        expect(words(commandLines(long.source))).toEqual(LONG.split(' '))
        expect(long.alt).toContain(LONG)
        expect(isBalanced(long.source)).toBe(true)
      }
    })

    test('a label takes the first line and the command wraps in mono below it', () => {
      const one = groupsCard({ ...CARD, groups: [group(LONG, { label: 'Start Expo dev server · Movies App/app' })], width: 720 })
      expect(one.source).toContain('font-weight="600">Start Expo dev server · Movies App/app</text>')
      expect(commandLines(one.source).length).toBeGreaterThan(1)
      expect(one.source).toMatch(/class="mono muted" font-size="12">\$ cd/)
      expect(words(commandLines(one.source))).toEqual(LONG.split(' '))
      expect(one.alt).toBe(`Started by tools: Start Expo dev server · Movies App/app - ${LONG}`)
      const plain = groupsCard({ ...CARD, groups: [group(LONG)], width: 720 })
      expect(plain.source).not.toContain('>Start Expo')
      expect(plain.source).toMatch(/class="mono fg" font-size="13">\$ cd/)
    })

    test('the label sits on the same line as the columns, and the dot stays level with it', () => {
      const one = groupsCard({ ...CARD, groups: [group(LONG, { label: 'Start Expo dev server' })], width: 720 })
      const labelY = /<text x="[\d.]+" y="([\d.]+)"[^>]*font-weight="600">Start Expo/.exec(one.source)?.[1]
      const dotY = /<circle class="success pulse" cx="[\d.]+" cy="([\d.]+)"/.exec(one.source)?.[1]
      const memY = /<text x="[\d.]+" y="([\d.]+)"[^>]*text-anchor="end"[^>]*>50 MB<\/text>/.exec(one.source)?.[1]
      expect(Number(labelY) - Number(dotY)).toBe(4.5)
      expect(memY).toBe(String(Number(labelY) - 0.5))
    })

    test('the command is capped at eight lines and ends in …', () => {
      const huge = '$ ' + Array.from({ length: 60 }, (_, i) => `--option-${i}=value`).join(' ')
      const one = groupsCard({ ...CARD, groups: [group(huge.slice(0, 300))], width: 277 })
      const lines = commandLines(one.source)
      expect(lines.length).toBe(8)
      expect(lines.at(-1)?.endsWith('…')).toBe(true)
    })

    test('wrapped lines stay inside the card at every width', () => {
      for (const width of [277, 400, 720]) {
        const one = groupsCard({ ...CARD, groups: [group(LONG, { label: 'Start Expo dev server' }), group(LONG, { id: 'detached-4', kind: 'detached' })], width })
        for (const match of one.source.matchAll(/<text x="([\d.]+)"[^>]*font-size="(\d+)"[^>]*>([^<]*)<\/text>/g)) {
          if (match[0].includes('text-anchor')) continue
          const shown = (match[3] ?? '').replace(/&(lt|gt|amp|quot);/g, '_')
          const em = match[0].includes('class="mono') ? 0.6 : 0.56
          expect(Number(match[1]) + shown.length * Number(match[2]) * em <= width).toBe(true)
        }
      }
    })

    test('a child process row wraps to two lines, and the tree line keeps up', () => {
      const long = 'node ' + 'x'.repeat(90)
      const row = (depth: number, label = long) => ({ pid: 7, depth, label, rss: MB, startedAt: T0 })
      const card = (rows: ReturnType<typeof row>[]) => groupsCard({ ...CARD, groups: [group('$ npm run dev', { rows })], width: 720 })
      const paths = (source: string) =>
        [...source.matchAll(/<path class="tree" stroke-width="1" d="M[\d.]+ ([\d.]+) V([\d.]+) H/g)].map(match => ({ from: Number(match[1]), to: Number(match[2]) }))
      const short = card([row(0, 'node server.js')])
      const wrapped = card([row(0)])
      expect(wrapped.height).toBe(short.height + 16)
      expect(commandLines(wrapped.source).slice(1)).toEqual(['node', 'x'.repeat(90)])
      const child = card([row(0), row(1)])
      const sibling = card([row(0), row(0)])
      expect(child.height).toBe(short.height + 30 + 32)
      const [first, second] = paths(child.source)
      expect(second!.from - first!.to).toBe(4 + 16)
      const [, next] = paths(sibling.source)
      expect(next!.from - paths(sibling.source)[0]!.to).toBe(4)
      const clipped = card([row(0, 'node ' + 'x'.repeat(400))])
      expect(commandLines(clipped.source).slice(1).length).toBe(2)
      expect(commandLines(clipped.source).at(-1)?.endsWith('…')).toBe(true)
      expect(isBalanced(child.source)).toBe(true)
    })
  })

  describe('theme', () => {
    const cards = (theme?: CardTheme) => [
      kpiStrip(snap, [], 720, theme).source,
      groupsCard({ title: 'Started by tools', groups: tools, width: 720, takenAt: T0, emptyTitle: 'x', emptyHint: 'y', theme }).source,
      callout('warning', 'Heads up', 400, theme).source,
    ]

    test('dark draws the dark palette only', () => {
      for (const source of cards('dark')) {
        expect(source).toContain(`.card{fill:${DARK.card}`)
        expect(source).not.toContain(LIGHT.card)
        expect(source).not.toContain('prefers-color-scheme')
        expect(source).toContain('@keyframes pulse')
        expect(source).toContain('prefers-reduced-motion')
        expect(isBalanced(source)).toBe(true)
      }
    })

    test('light draws the light palette only', () => {
      for (const source of cards('light')) {
        expect(source).toContain(`.card{fill:${LIGHT.card}`)
        expect(source).not.toContain(DARK.card)
        expect(source).not.toContain('prefers-color-scheme')
        expect(source).toContain('@keyframes pulse')
        expect(source).toContain('prefers-reduced-motion')
        expect(isBalanced(source)).toBe(true)
      }
    })

    test('no theme keeps the dark palette with the system color scheme on top', () => {
      for (const source of cards()) {
        expect(source).toContain(`.card{fill:${DARK.card}`)
        expect(source).toContain(`@media (prefers-color-scheme: light){.card{fill:${LIGHT.card}`)
      }
    })
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
