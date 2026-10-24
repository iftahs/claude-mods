import { describe, expect, mock, test } from 'claude-code/testing'

import type { On, RenderElement } from 'claude-code'
import type { Engine, Plugin } from 'claude-code/testing'

import {
  POSIX_PROBE_ARGV,
  buildSnapshot,
  cleanText,
  commandLabel,
  findRootIndex,
  helperTitle,
  parseElapsed,
  parsePosixProbe,
  parseWindowsProbe,
  redactSecrets,
  safeSystemRoot,
  toolProcessCount,
  toolShellTitle,
  windowsProbeArgv,
} from './tree'
import type { Probe, RawProc } from './tree'

const T0 = 1_792_000_000_000
const HOST = 'C:\\Program Files\\WindowsApps\\Claude_2.37337.1.0_x64__abcdefghijklm\\app\\claude.exe'
const CLI = 'C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code\\2.1.295\\0123456789ab\\claude.exe'
const SNAP = "source '/c/Users/me/.claude/shell-snapshots/snapshot-bash-1-x.sh' 2>/dev/null || true && shopt -u extglob 2>/dev/null || true"
const LAUNCHER = '-NoProfile -NonInteractive -Command "$__claudeCodeScript = $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT; Invoke-Expression"'

function proc(pid: number, ppid: number, name: string, cmd: string, startOffset = 0): RawProc {
  return { pid, ppid, name, cmd, rss: 10 * 1024 * 1024, startedAt: T0 + startOffset * 1000 }
}

function windowsSession(extra: RawProc[] = []): Probe {
  return {
    self: 900,
    procs: [
      proc(4, 0, 'System', ''),
      proc(8716, 4, 'sihost.exe', 'sihost.exe'),
      proc(85452, 8716, 'claude.exe', `"${HOST}" `),
      proc(80348, 85452, 'claude.exe', `"${HOST}" --type=gpu-process`),
      proc(97264, 85452, 'claude.exe', `"${CLI}" --output-format stream-json`, 1),
      proc(83236, 97264, 'conhost.exe', '\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4', 2),
      proc(53736, 97264, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "C:\\Users\\Jane^ Doe\\AppData\\Roaming\\npm\\chrome-devtools-mcp.cmd"', 3),
      proc(94440, 53736, 'conhost.exe', '\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4', 3),
      proc(97644, 53736, 'node.exe', '"node" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\chrome-devtools-mcp\\build\\src\\bin\\chrome-devtools-mcp.js"', 4),
      proc(45992, 97644, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\x\\watchdog\\main.js" --parent-pid=97644', 5),
      proc(91424, 97264, 'Acme.Mcp.exe', '"C:\\Users\\me\\AppData\\Local\\Programs\\Acme\\Acme.Mcp.exe"', 6),
      proc(31600, 97264, 'bash.exe', `"C:\\Program Files\\Git\\bin\\bash.exe" -c "${SNAP} && eval 'npm run dev -- --port '\\''3000'\\''' < /dev/null && pwd -P"`, 10),
      proc(65772, 31600, 'bash.exe', `"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "${SNAP} && eval 'npm run dev' < /dev/null"`, 10),
      proc(105836, 65772, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\proj\\node_modules\\next\\dist\\bin\\next" dev', 11),
      proc(74956, 97264, 'cmd.exe', `C:\\WINDOWS\\System32\\cmd.exe /d /s /c ""C:\\WINDOWS\\System32\\chcp.com" 65001 >nul & powershell.exe ${LAUNCHER}"`, 20),
      proc(44872, 74956, 'powershell.exe', `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" ${LAUNCHER}`, 20),
      proc(900, 97264, 'powershell.exe', 'powershell.exe -NoProfile -NonInteractive -EncodedCommand AAAA', 30),
      proc(901, 900, 'conhost.exe', '\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4', 30),
      ...extra,
    ],
  }
}

type PaneRun = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
type RunRecord = { argv: readonly string[]; init?: { cwd?: string } }

function probeStdout(procs: RawProc[]): string {
  return JSON.stringify({
    self: 900,
    procs: procs.map(one => ({ i: one.pid, p: one.ppid, n: one.name, c: one.cmd, m: one.rss, t: one.startedAt })),
  })
}

function okRun(stdout: string): PaneRun {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

async function mountTerminalPane($: Engine, on: On, ran: PaneRun, env: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: T0 + 60_000 })
  mock.env(on, { OS: 'Windows_NT', ...env })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.surfaces', () => ({ value: ['terminal' as const] }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  const logs: string[] = []
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  const runs: RunRecord[] = []
  on('process.run', (_$, e) => {
    runs.push(e)
    return { value: ran }
  })
  await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'session-procs',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-procs',
    props: {
      title: 'Session processes',
      isFocused: false,
      bodyColumns: 100,
      placement: 'dock' as const,
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })
  return { ui, runs, logs }
}

describe('root discovery', () => {
  test('lands on the CLI claude.exe, not the desktop host above it', () => {
    const { snapshot } = buildSnapshot(windowsSession(), T0 + 60_000)
    expect(snapshot.rootPid).toBe(97264)
    expect(snapshot.warning).toBe(null)
  })

  test('climbs from a hooks worker to the session CLI', () => {
    const chain = [
      proc(900, 500, 'powershell.exe', 'powershell.exe'),
      proc(500, 97264, 'claude.exe', `"${CLI}" --hooks-worker`),
      proc(97264, 85452, 'claude.exe', `"${CLI}" --output-format stream-json`),
      proc(85452, 8716, 'claude.exe', `"${HOST}" `),
    ]
    expect(findRootIndex(chain)).toBe(2)
  })

  test('stops at a terminal shell above a native claude', () => {
    const chain = [
      proc(10, 9, 'ps', 'ps -A'),
      proc(9, 8, 'claude', 'claude --resume'),
      proc(8, 1, 'zsh', '-zsh'),
    ]
    expect(findRootIndex(chain)).toBe(1)
  })
})

describe('grouping', () => {
  test('tool shells become groups titled by their command, wrappers hidden', () => {
    const { snapshot } = buildSnapshot(windowsSession(), T0 + 60_000)
    const tools = snapshot.groups.filter(group => group.kind === 'tool')
    expect(tools.map(group => group.title)).toEqual(["$ npm run dev -- --port '3000'", 'PowerShell tool command'])
    expect(tools[0]?.rows.map(row => [row.pid, row.depth])).toEqual([[105836, 0]])
    expect(tools[0]?.rows[0]?.label).toBe('node …/bin/next dev')
    expect(tools[1]?.rows).toEqual([])
  })

  test('MCP launchers collapse to the server they start', () => {
    const { snapshot } = buildSnapshot(windowsSession(), T0 + 60_000)
    const helpers = snapshot.groups.filter(group => group.kind === 'helper')
    expect(helpers.map(group => group.title)).toEqual(['chrome-devtools-mcp', 'Acme.Mcp'])
    expect(helpers[0]?.rows.map(row => [row.pid, row.depth])).toEqual([[97644, 0], [45992, 1]])
  })

  test('the probe itself, conhost and the desktop host never show', () => {
    const { snapshot } = buildSnapshot(windowsSession(), T0 + 60_000)
    const pids = snapshot.groups.flatMap(group => [group.pid, ...group.rows.map(row => row.pid)])
    for (const hidden of [900, 901, 83236, 94440, 85452, 80348]) expect(pids).not.toContain(hidden)
    expect(toolProcessCount(snapshot)).toBe(2)
  })

  test('a process whose tool shell exited stays listed as detached', () => {
    const first = buildSnapshot(windowsSession(), T0 + 60_000)
    const orphaned = windowsSession().procs.filter(one => one.pid !== 65772 && one.pid !== 31600)
    const { snapshot } = buildSnapshot({ self: 900, procs: orphaned }, T0 + 65_000, first.known)
    const detached = snapshot.groups.filter(group => group.kind === 'detached')
    expect(detached.map(group => group.pid)).toEqual([105836])
  })

  test('an unrelated process with a dead parent is not adopted', () => {
    const stranger = proc(7000, 6999, 'node.exe', 'node other.js', 40)
    const first = buildSnapshot(windowsSession([stranger]), T0 + 60_000)
    const { snapshot } = buildSnapshot(windowsSession([stranger]), T0 + 65_000, first.known)
    expect(snapshot.groups.some(group => group.pid === 7000)).toBe(false)
  })
})

describe('pane', () => {
  const stdout = JSON.stringify({
    self: 900,
    procs: windowsSession().procs.map(one => ({ i: one.pid, p: one.ppid, n: one.name, c: one.cmd, m: one.rss, t: one.startedAt })),
  })

  test('lists tool processes, helpers behind a toggle, on terminal and desktop', async ($, on) => {
    const clock = mock.clock(on, { now: T0 + 60_000 })
    mock.env(on, { OS: 'Windows_NT' })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    const opens: unknown[] = []
    on('session.surfaces', () => ({ value: ['desktop' as const] }))
    on('ui.open', (_$, e) => {
      opens.push(e)
      return { value: { isPlaced: true as const } }
    })
    on('ui.status', () => ({ value: undefined }))
    on('ui.log', () => ({ value: undefined }))
    on('process.run', () => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
    await clock.settle()

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'session-procs',
        surface,
        component: 'Pane',
        requestId: 'session-procs',
        props: {
          title: 'Session processes',
          isFocused: false,
          bodyColumns: 100,
          placement: 'dock',
          scroll: { offset: 0, bodyRows: 40 },
          view: {},
        },
      })
      expect(await ui.find({ type: 'Text', text: /Could not list|no implementation|stale/ })).toBeUndefined()
      if (surface === 'terminal') {
        expect(await ui.find({ type: 'Text', text: /claude #97264/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /npm run dev/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /next dev/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /chrome-devtools-mcp/ })).toBeUndefined()
        await ui.press({ key: 'helpers' })
        expect(await ui.find({ type: 'Text', text: /chrome-devtools-mcp/ })).toBeDefined()
      } else {
        const cards = await ui.findAll({ type: 'Svg' })
        expect(cards.map(card => String(card.props.alt))).toEqual([
          'Running: 2, Helpers: 3, Memory: 100 MB, Session: 59s',
          "Started by tools: $ npm run dev -- --port '3000' (node …/bin/next dev); PowerShell tool command",
        ])
        await ui.press({ key: 'helpers' })
        const withHelpers = await ui.findAll({ type: 'Svg' })
        expect(withHelpers.length).toBe(3)
        expect(String(withHelpers[2]?.props.alt)).toContain('chrome-devtools-mcp')
      }
      await ui.press({ key: 'helpers' })
      await ui.unmount()
    }

    expect(opens).toEqual([])
    const sidebar = await $.ui.mount({
      plugin: 'session-procs',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'session-procs',
      props: {
        title: 'Session processes',
        isFocused: false,
        bodyColumns: 38,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
    })
    expect((await sidebar.find({ type: 'Button', key: 'helpers' }))?.props.label).toBe('Helpers (3)')
    const narrow = await sidebar.findAll({ type: 'Svg' })
    expect(narrow.map(card => /width="(\d+)"/.exec(String(card.props.source))?.[1])).toEqual(['277', '277'])
    await sidebar.unmount()
  })

  test('a failed probe shows a short redacted message and never leaks stderr to the pane or the log', async ($, on) => {
    const stderr = 'boom --token=supersecret\u001b[31m\nmore'
    const { ui, logs } = await mountTerminalPane($, on, { exitCode: 3, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false })
    expect(await ui.find({ type: 'Text', text: /^Could not list processes \(exit 3\)\. boom --token=\*\*\* more$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /supersecret/ })).toBeUndefined()
    expect(logs.join('\n')).not.toContain('supersecret')
    await ui.unmount()
  })

  test('a failed probe with empty stderr ends at the exit code', async ($, on) => {
    const { ui } = await mountTerminalPane($, on, { exitCode: 2, stdout: '', stderr: '  ', isStdoutTruncated: false, isStderrTruncated: false })
    expect(await ui.find({ type: 'Text', text: /^Could not list processes \(exit 2\)\.$/ })).toBeDefined()
    await ui.unmount()
  })

  test('an oversized process list is refused instead of parsed', async ($, on) => {
    const { ui } = await mountTerminalPane($, on, { ...okRun(probeStdout(windowsSession().procs)), isStdoutTruncated: true })
    expect(await ui.find({ type: 'Text', text: /^The process list was too large to read\.$/ })).toBeDefined()
    await ui.unmount()
  })

  test('unparseable output gives a fixed message and is never echoed', async ($, on) => {
    const { ui, logs } = await mountTerminalPane($, on, okRun('{"self": --token=leakedvalue'))
    expect(await ui.find({ type: 'Text', text: /^Could not read the process list\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /leakedvalue/ })).toBeUndefined()
    expect(logs.join('\n')).not.toContain('leakedvalue')
    await ui.unmount()
  })

  test('powershell runs by absolute path from SystemRoot, with System32 as its working directory', async ($, on) => {
    const { ui, runs } = await mountTerminalPane($, on, okRun(probeStdout(windowsSession().procs)), { SystemRoot: 'D:\\Win' })
    expect(runs[0]?.argv[0]).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(runs[0]?.init?.cwd).toBe('D:\\Win\\System32')
    await ui.unmount()
  })

  test('a SystemRoot that is not a drive path falls back to C:\\Windows', async ($, on) => {
    const { ui, runs } = await mountTerminalPane($, on, okRun(probeStdout(windowsSession().procs)), { SystemRoot: '..\\evil" & calc' })
    expect(runs[0]?.argv[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(runs[0]?.init?.cwd).toBe('C:\\Windows\\System32')
    await ui.unmount()
  })

  test('the terminal list stops at 120 rows and says how many it left out', async ($, on) => {
    const workers = Array.from({ length: 150 }, (_, i) => proc(200_000 + i, 105836, 'node.exe', `node worker-${i}.js`, 12))
    const { ui } = await mountTerminalPane($, on, okRun(probeStdout(windowsSession(workers).procs)))
    expect(await ui.find({ type: 'Text', text: /worker-0\.js/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /worker-149\.js/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^\+33 more not shown$/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('secret redaction', () => {
  test('masks secrets in flags, assignments, headers, URLs and known token shapes', () => {
    const cases: [string, string][] = [
      ['node server.js --token=abc123 --port 3000', 'node server.js --token=*** --port 3000'],
      ['deploy --api-key "s3cr3t value" --verbose', 'deploy --api-key *** --verbose'],
      ['cli --password hunter2 run', 'cli --password *** run'],
      ['GITHUB_TOKEN=ghp_x npm publish', 'GITHUB_TOKEN=*** npm publish'],
      ['curl -H "Authorization: Bearer abcdefgh12345678"', 'curl -H "Authorization: ***"'],
      ['psql postgres://admin:pa55@db.local:5432/app', 'psql postgres://***@db.local:5432/app'],
      ['tool ghp_0123456789abcdefghijABCDEFGHIJ', 'tool ***'],
      ['tool sk-ant-api03-abcdefghijklmnop', 'tool ***'],
      ['tool AKIAABCDEFGHIJKLMNOP', 'tool ***'],
    ]
    for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected)
  })

  test('leaves ordinary command lines alone', () => {
    const inputs = [
      'npm run dev -- --port 3000',
      'node …/bin/next dev',
      'node --no-auth server.js',
      'node …/watchdog/main.js --parent-pid=97644',
      'git commit --author "Jane Doe"',
      'python train.py --tokenizer bert',
      'docker login --password-stdin -u me',
      'echo basic authentication works',
      'cli --token-file /etc/app/token --verbose',
      'cli --password-prompt',
      'curl --user-agent probe https://example.com',
      'mysql -u root -p mydb',
      'docker run -p 8080:80 nginx',
      'aws configure set region us-east-1',
      'sshpass -f /run/secrets/pw ssh host',
      'node --max-old-space-size=4096 server.js',
      'cli --passwordFile /run/pw --verbose',
      'cli --tokenPath ./t',
      'python train.py --Tokenizer bert',
      'pwd -P',
    ]
    for (const input of inputs) expect(redactSecrets(input)).toBe(input)
  })

  test('masks camelCase secret flags and unterminated quoted flag values', () => {
    const cases: [string, string][] = [
      ['cli --secretKey abc123 run', 'cli --secretKey *** run'],
      ['cli --authKey abc123', 'cli --authKey ***'],
      ['cli --tokenValue=abc123', 'cli --tokenValue=***'],
      ['cli --apiKeyValue abc123', 'cli --apiKeyValue ***'],
      ['cli --password "hunter two', 'cli --password ***'],
    ]
    for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected)
  })

  test('masks assignments, connection strings and URL query secrets', () => {
    const cases: [string, string][] = [
      ['TOKEN=abc123 npm run x', 'TOKEN=*** npm run x'],
      ['PASSWORD=hunter2 ./run.sh', 'PASSWORD=*** ./run.sh'],
      ['secret=x', 'secret=***'],
      ['apikey=x', 'apikey=***'],
      ['curl https://api.x.com/v1?token=abc123', 'curl https://api.x.com/v1?token=***'],
      ['curl "https://api.x.com/v1?token=abc123&user=bob"', 'curl "https://api.x.com/v1?token=***&user=bob"'],
      ['"Server=db;User Id=sa;Password=S3cret;"', '"Server=db;User Id=sa;Password=***;"'],
      ['/p:Password=S3cret', '/p:Password=***'],
      ['AccountKey=abc', 'AccountKey=***'],
      ['AUTH_TOKEN_V2="two words" run', 'AUTH_TOKEN_V2=*** run'],
      ['password="unterminated value', 'password=***'],
      ['PASSWORD="hunter two', 'PASSWORD=***'],
      ['secretKey=abc123 run', 'secretKey=*** run'],
      ['clientSecret=abc run', 'clientSecret=*** run'],
      ['redis-cli -u redis://:pw@host:6379', 'redis-cli -u redis://***@host:6379'],
    ]
    for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected)
  })

  test('masks authorization-like headers before bearer values', () => {
    const cases: [string, string][] = [
      ['curl -H "Authorization: Bearer abcdefgh12345678"', 'curl -H "Authorization: ***"'],
      ['curl -H "authorization:Basic dXNlcjpwYXNzd29yZA=="', 'curl -H "authorization:***"'],
      ['curl -H "Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA=="', 'curl -H "Proxy-Authorization: ***"'],
      ['curl -H "X-API-Key: k123"', 'curl -H "X-API-Key: ***"'],
      ['curl -H "X-Amz-Security-Token: abcdef" https://x', 'curl -H "X-Amz-Security-Token: ***" https://x'],
      ['curl -H "Cookie: a=b; c=d"', 'curl -H "Cookie: ***"'],
      ['Cookie: a=b', 'Cookie: ***'],
      ['node client.js Bearer abcdefgh12345678', 'node client.js Bearer ***'],
      ['curl -H "X-Request-Id: abc123"', 'curl -H "X-Request-Id: abc123"'],
    ]
    for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected)
  })

  test('skips flags that name where a secret lives and never takes another flag as the value', () => {
    expect(redactSecrets('app --token-file ./t.txt --api-key-path k.pem --secret-env MY_SECRET --password-prompt')).toBe(
      'app --token-file ./t.txt --api-key-path k.pem --secret-env MY_SECRET --password-prompt',
    )
    expect(redactSecrets('app --password --verbose')).toBe('app --password --verbose')
    expect(redactSecrets('app --db-password hunter2 --verbose')).toBe('app --db-password *** --verbose')
    expect(redactSecrets('app --client-secret=abc -auth xyz')).toBe('app --client-secret=*** -auth ***')
  })

  test('masks URL credentials, webhook URLs and bot tokens', () => {
    const cases: [string, string][] = [
      ['git clone https://me:ghpw@github.com/a/b.git', 'git clone https://***@github.com/a/b.git'],
      ['curl -X POST https://hooks.slack.com/services/T000/B000/XXXXXXXX', 'curl -X POST https://hooks.slack.com/services/***'],
      ['curl https://discord.com/api/webhooks/123456/abcdef-ghij', 'curl https://discord.com/api/webhooks/***'],
      ['curl https://discordapp.com/api/webhooks/123456/abcdef-ghij', 'curl https://discordapp.com/api/webhooks/***'],
      ['curl https://api.telegram.org/bot123456:ABC-def/sendMessage', 'curl https://api.telegram.org/bot***/sendMessage'],
    ]
    for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected)
  })

  test('masks the listed token formats', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbg'
    const tokens = [
      'ghp_0123456789abcdefghijABCDEFGHIJ',
      'github_pat_0123456789abcdefghijABCD',
      'sk-ant-api03-abcdefghijklmnop',
      'sk-proj-abcdefghijklmnopqrstuvwxyz',
      'sk-svcacct-abcdefghijklmnopqrstuvwxyz',
      'sk-admin-abcdefghijklmnopqrstuvwxyz',
      'sk-abcdefghijklmnopqrstuvwxyz',
      'sk_live_abcdefghijklmnop',
      'rk_test_abcdefghijklmnop',
      'xoxb-1234567890-abcdef',
      'npm_abcdefghijklmnopqrstuvwxyz0123456789',
      'glpat-abcdefghijklmnopqrstuvwxyz',
      'hf_abcdefghijklmnopqrstuvwxyz0123456789',
      'AKIAABCDEFGHIJKLMNOP',
      'ASIAABCDEFGHIJKLMNOP',
      `AIza${'a'.repeat(35)}`,
      jwt,
    ]
    for (const token of tokens) {
      expect(redactSecrets(`tool ${token}`)).toBe('tool ***')
      expect(redactSecrets(`tool --opt=${token} run`)).not.toContain(token)
    }
    expect(redactSecrets(`curl -b session=${jwt}`)).toBe('curl -b session=***')
  })

  test('masks the listed tool-specific password flags', () => {
    const cases: [string, string][] = [
      ['mysql -u root -phunter2 db', 'mysql -u root -p*** db'],
      ['mysqldump -h db -p"my pass" app', 'mysqldump -h db -p*** app'],
      ['mariadb -uroot -phunter2', 'mariadb -uroot -p***'],
      ['C:\\mysql\\bin\\mysqladmin.exe -u root -phunter2 status', 'C:\\mysql\\bin\\mysqladmin.exe -u root -p*** status'],
      ['redis-cli -h cache -a hunter2 ping', 'redis-cli -h cache -a *** ping'],
      ['curl -u admin:hunter2 https://x.test', 'curl -u admin:*** https://x.test'],
      ['curl --user admin:hunter2 https://x.test', 'curl --user admin:*** https://x.test'],
      ['curl --user=admin:hunter2 https://x.test', 'curl --user=admin:*** https://x.test'],
      ['curl -s -uadmin:hunter2 https://x.test', 'curl -s -uadmin:*** https://x.test'],
      ['sqlcmd -S srv -U sa -P hunter2 -Q "select 1"', 'sqlcmd -S srv -U sa -P *** -Q "select 1"'],
      ['sqlcmd -S srv -U sa -p -Q "select 1"', 'sqlcmd -S srv -U sa -p -Q "select 1"'],
      ['sshpass -p hunter2 ssh me@host', 'sshpass -p *** ssh me@host'],
      ['docker login -u me -p hunter2 registry.test', 'docker login -u me -p *** registry.test'],
      ['openssl enc -aes-256-cbc -pass pass:hunter2 -in a -out b', 'openssl enc -aes-256-cbc -pass pass:*** -in a -out b'],
      ['openssl enc -pass env:PW -in a', 'openssl enc -pass env:PW -in a'],
      ['aws configure set aws_secret_access_key abc/def+ghi', 'aws configure set aws_secret_access_key ***'],
      ['aws configure set aws_session_token abcdef', 'aws configure set aws_session_token ***'],
      ['aws configure set --profile dev aws_access_key_id AKIAxyz', 'aws configure set --profile dev aws_access_key_id ***'],
    ]
    for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected)
  })

  test('is idempotent', () => {
    const inputs = [
      'node server.js --token=abc123 --port 3000',
      'cli --password hunter2 run',
      'TOKEN=abc123 npm run x',
      '"Server=db;User Id=sa;Password=S3cret;"',
      'curl -H "Authorization: Bearer abcdefgh12345678" -H "X-API-Key: k123" -H "Cookie: a=b"',
      'curl -u admin:hunter2 https://hooks.slack.com/services/T0/B0/XX',
      'psql postgres://admin:pa55@db.local:5432/app',
      'mysql -u root -phunter2 db && sshpass -p hunter2 ssh h && sqlcmd -P hunter2',
      'redis-cli -a hunter2 && docker login -p hunter2 && openssl enc -pass pass:hunter2',
      'aws configure set aws_secret_access_key abcdef',
      'tool sk-ant-api03-abcdefghijklmnop ghp_0123456789abcdefghijABCDEFGHIJ',
      'echo basic authentication works',
    ]
    for (const input of inputs) {
      const once = redactSecrets(input)
      expect(redactSecrets(once)).toBe(once)
    }
    expect(redactSecrets('--token=***')).toBe('--token=***')
  })

  test('snapshots never carry a secret into titles or labels', () => {
    const leaky = proc(7100, 97264, 'node.exe', '"C:\\node.exe" server.js --token=supersecret', 40)
    const { snapshot } = buildSnapshot(windowsSession([leaky]), T0 + 60_000)
    const text = JSON.stringify(snapshot)
    expect(text).not.toContain('supersecret')
    expect(text).toContain('--token=***')
  })

  test('secrets are masked before long paths are shortened', () => {
    const cmd = '"C:\\node.exe" server.js --token=/srv/keys/deep/prod.key --out C:\\build\\a\\b\\c.log'
    expect(commandLabel(proc(1, 0, 'node.exe', cmd))).toBe('node server.js --token=*** --out …/b/c.log')
    expect(helperTitle(proc(2, 0, 'cmd.exe', 'cmd.exe /d /s /c "C:\\x\\tool.cmd" --password=hunter2 /srv/a/b/c/d'))).toBe('tool --password=*** …/c/d')
  })

  test('a title or label is masked and capped at 300 code points', () => {
    const straddling = proc(7202, 97264, 'node.exe', `"C:\\node.exe" ${'y'.repeat(280)} ghp_0123456789abcdefghijABCDEFGHIJ`, 43)
    const long = proc(7200, 97264, 'node.exe', `"C:\\node.exe" ${'x'.repeat(5000)} --token=supersecret`, 40)
    const emoji = proc(7201, 97264, 'node.exe', `"C:\\node.exe" ${'\u{1F600}'.repeat(1000)}`, 41)
    const { snapshot } = buildSnapshot(windowsSession([long, emoji, straddling]), T0 + 60_000)
    expect(JSON.stringify(snapshot.groups.find(group => group.pid === 7202))).not.toContain('ghp_')
    const texts = snapshot.groups.flatMap(group => [group.title, ...group.rows.map(row => row.label)])
    for (const text of texts) expect(Array.from(text).length).toBeLessThanOrEqual(300)
    const capped = snapshot.groups.find(group => group.pid === 7200)?.rows[0]?.label ?? ''
    expect(Array.from(capped).length).toBe(300)
    expect(capped.endsWith('…')).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('supersecret')
    expect(Array.from(snapshot.groups.find(group => group.pid === 7201)?.rows[0]?.label ?? '').length).toBe(300)
  })

  test('newlines in a command never reach a title as line breaks', () => {
    const { snapshot } = buildSnapshot(windowsSession([proc(7300, 97264, 'node.exe', '"C:\\node.exe" a\nb\tc\r\nd', 42)]), T0 + 60_000)
    const row = snapshot.groups.find(group => group.pid === 7300)?.rows[0]?.label
    expect(row).toBe('node a b c d')
  })
})

describe('text safety', () => {
  test('cleanText turns control, bidi and invalid characters into U+FFFD and carriage returns into spaces', () => {
    const R = '\ufffd'
    expect(cleanText('a\u001bb\u0007c\rd\u202ee\u200bf\u2066g\u0085h\ufffei\uffffj')).toBe(`a${R}b${R}c d${R}e${R}f${R}g${R}h${R}i${R}j`)
    expect(cleanText('lone\ud800high and lone\udc00low')).toBe(`lone${R}high and lone${R}low`)
    expect(redactSecrets(cleanText('--token=abc\u0001def'))).toBe('--token=***')
    expect(cleanText('keeps \u{1F600} pairs and tab\tnewline\n')).toBe('keeps \u{1F600} pairs and tab\tnewline\n')
  })

  test('cleanText caps by code point, never splitting a pair', () => {
    expect(cleanText('x'.repeat(5000))).toBe('x'.repeat(2000))
    const emoji = cleanText('\u{1F600}'.repeat(5000))
    expect(Array.from(emoji).length).toBe(2000)
    expect(emoji).toBe('\u{1F600}'.repeat(2000))
    expect(cleanText('short')).toBe('short')
  })

  test('both probe parsers clean and cap names and command lines', () => {
    const windows = parseWindowsProbe(JSON.stringify({ self: 1, procs: [{ i: 2, p: 1, n: 'a\u001b[31m.exe', c: `x\u202e${'y'.repeat(5000)}`, m: 1, t: null }] }))
    expect(windows.procs[0]?.name).toBe('a\ufffd[31m.exe')
    expect(windows.procs[0]?.cmd.length).toBe(2000)
    expect(windows.procs[0]?.cmd.startsWith('x\ufffdy')).toBe(true)
    const posix = parsePosixProbe(`1\n 2 1 100 00:01 /bin/tool\u001b[2J ${'z'.repeat(5000)}\n`, T0)
    expect(posix.procs[0]?.cmd.length).toBe(2000)
    expect(posix.procs[0]?.cmd.includes('\u001b')).toBe(false)
    expect(posix.procs[0]?.name).toBe('tool\ufffd[2J')
  })
})

describe('hostile input', () => {
  function elapsed(run: () => unknown): number {
    const start = Date.now()
    run()
    return Date.now() - start
  }

  test('redactSecrets stays fast on 128 KiB of "a."', () => {
    expect(elapsed(() => redactSecrets('a.'.repeat(65536)))).toBeLessThan(250)
  })

  test('redactSecrets stays fast on a dash followed by 128 KiB of a', () => {
    expect(elapsed(() => redactSecrets(`-${'a'.repeat(131072)}`))).toBeLessThan(250)
  })

  test('redactSecrets stays fast on a long almost-JWT', () => {
    expect(elapsed(() => redactSecrets(`eyJ${'a.'.repeat(60000)}`))).toBeLessThan(250)
  })

  test('redactSecrets stays fast on repeated starts of every rule', () => {
    const inputs = [
      '-eyJ'.repeat(32768),
      '.eyJ'.repeat(32768),
      'eyJaaaaaaaa.'.repeat(10000),
      '-sk-ant-'.repeat(16384),
      'X-'.repeat(65536),
      'curl -u '.repeat(16384),
      'mysql '.repeat(21845),
      `mysql ${' -x'.repeat(65536)}`,
      'aws configure set '.repeat(7000),
      'password="'.repeat(13107),
      '--token '.repeat(16384),
      `--token${' '.repeat(120000)}-`,
      'Bearer '.repeat(18724),
      `Cookie${' '.repeat(120000)}`,
      'a://'.repeat(32768),
      'token_'.repeat(21845),
      '\u{1F600}'.repeat(30000),
      '\ud800'.repeat(60000),
    ]
    for (const input of inputs) expect(elapsed(() => redactSecrets(input))).toBeLessThan(250)
  })

  test('labels, titles and parsers stay fast on hostile command lines', () => {
    const inputs = ['/'.repeat(32768), '"/'.repeat(16384), '"/a '.repeat(8192), 'C:\\'.repeat(10922), '/a'.repeat(16384), "eval '".repeat(5461), ` /c ${'a'.repeat(32768)}`, '\\"'.repeat(16384)]
    for (const input of inputs) {
      expect(elapsed(() => commandLabel(proc(1, 0, 'node.exe', input)))).toBeLessThan(250)
      expect(elapsed(() => toolShellTitle(proc(1, 0, 'bash.exe', input)))).toBeLessThan(250)
      expect(elapsed(() => helperTitle(proc(1, 0, 'cmd.exe', `cmd.exe /c ${input}`)))).toBeLessThan(250)
      expect(elapsed(() => cleanText(input))).toBeLessThan(250)
    }
    expect(elapsed(() => parsePosixProbe(`1\n${'1'.repeat(131072)}\n${'1 '.repeat(65536)}\n${' '.repeat(131072)}\n`, T0))).toBeLessThan(250)
  })
})

describe('parsing', () => {
  test('windows probe JSON, BOM and a single object included', () => {
    const probe = parseWindowsProbe('\uFEFF{"self":5,"procs":{"i":5,"p":1,"n":"powershell.exe","c":null,"m":42,"t":null}}')
    expect(probe).toEqual({ self: 5, procs: [{ pid: 5, ppid: 1, name: 'powershell.exe', cmd: 'powershell.exe', rss: 42, startedAt: null }] })
  })

  test('posix ps output', () => {
    const probe = parsePosixProbe('42\n    1     0  1200 3-04:05:06 /sbin/launchd\n   42     9   800      00:03 ps -A\n   77    42   100    01:02:03 /usr/local/bin/node server.js --port 3000\n', T0)
    expect(probe.self).toBe(42)
    expect(probe.procs[2]).toEqual({ pid: 77, ppid: 42, name: 'node', cmd: '/usr/local/bin/node server.js --port 3000', rss: 102400, startedAt: T0 - 3_723_000 })
  })

  test('bash tool titles undo the real quoting of single quotes', () => {
    const cmd = `"C:\\Program Files\\Git\\bin\\bash.exe" -c "${SNAP} && eval 'node -e \\"x=require('\\"'\\"'fs'\\"'\\"')\\"' < /dev/null && pwd -P"`
    expect(toolShellTitle(proc(1, 0, 'bash.exe', cmd))).toBe(`$ node -e "x=require('fs')"`)
  })

  test('etime forms', () => {
    expect(parseElapsed('00:07')).toBe(7000)
    expect(parseElapsed('01:00:00')).toBe(3_600_000)
    expect(parseElapsed('2-00:00:01')).toBe(172_801_000)
  })

  test('windows probe is a plain readable -Command run by absolute path, nothing antivirus heuristics flag', () => {
    const argv = windowsProbeArgv('C:\\Windows')
    expect(argv.slice(0, 4)).toEqual(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-NonInteractive', '-Command'])
    expect(argv.join(' ')).not.toMatch(/EncodedCommand|ExecutionPolicy|Bypass|-enc\b|-w(indowstyle)?\s+hidden/i)
    expect(argv[4]).not.toMatch(/["\r\n]/)
  })

  test('the system root is accepted only as a plain drive path', () => {
    expect(safeSystemRoot('D:\\Win')).toBe('D:\\Win')
    expect(safeSystemRoot('C:\\Windows\\')).toBe('C:\\Windows')
    for (const bad of [undefined, '', 'Windows', '\\\\server\\share', 'C:', 'C:\\', 'C:\\a"b', 'C:\\a|b', 'C:\\a<b', 'C:\\a\nb', `C:\\${'a'.repeat(201)}`]) {
      expect(safeSystemRoot(bad)).toBe('C:\\Windows')
    }
  })

  test('the posix probe keeps $$ as the ps pid and resolves ps through the system PATH', () => {
    const [shell, flag, script] = POSIX_PROBE_ARGV
    expect(shell).toBe('/bin/sh')
    expect(flag).toBe('-c')
    expect(script).toBe(
      'echo $$; PATH=$(command -p getconf PATH 2>/dev/null || echo /usr/bin:/bin); export PATH; exec ps -A -o pid= -o ppid= -o rss= -o etime= -o args=',
    )
  })
})

describe('band', () => {
  const stdout = probeStdout(windowsSession().procs)
  const closer: Plugin = {
    name: 'closer',
    register(on) {
      on('command.run', { command: 'close-procs' }, async $ => {
        await $.ui.close({ id: 'session-procs' })

        return { text: 'closed' }
      })
    },
  }
  const bandProps = {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  }

  async function startSession($: Engine, on: On, panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[] = []) {
    const clock = mock.clock(on, { now: T0 + 60_000 })
    mock.env(on, { OS: 'Windows_NT' })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('session.surfaces', () => ({ value: ['desktop' as const] }))
    const opens: unknown[] = []
    on('ui.open', (_$, e) => {
      opens.push(e)
      return { value: { isPlaced: true as const } }
    })
    on('ui.close', () => ({ value: undefined }))
    on('ui.panes', () => ({ value: panes }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.log', () => ({ value: undefined }))
    on('process.run', () => ({ value: okRun(stdout) }))
    on('ui.render', ($, e) => h($.ui.resolve(e).Text, null, 'engine') as RenderElement)
    await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
    await clock.settle()
    return { opens }
  }

  function mountBand($: Engine, surface: 'terminal' | 'desktop', props: Partial<typeof bandProps> = {}) {
    return $.ui.mount({
      plugin: 'session-procs',
      surface,
      component: 'AbovePrompt',
      requestId: 'above-prompt',
      props: { ...bandProps, ...props },
    })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`shows how many processes run and a button to open the pane, on ${surface}`, async ($, on) => {
      const { opens } = await startSession($, on)
      const ui = await mountBand($, surface)
      expect(await ui.find({ type: 'Text', text: /^2 running from tools$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^· 100 MB$/ })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: 'open-procs' }))?.props.label).toBe('Show processes')
      expect(opens).toEqual([])
      await ui.unmount()
    })

    test(`pressing the button opens the pane once and hides the band until the pane closes, on ${surface}`, { plugins: [closer] }, async ($, on) => {
      const { opens } = await startSession($, on)
      const ui = await mountBand($, surface)
      await ui.press({ key: 'open-procs' })
      expect(opens).toEqual([{ id: 'session-procs', title: 'Session processes', columns: 38 }])
      expect(await ui.find({ type: 'Button', key: 'open-procs' })).toBeUndefined()

      await $.command.run({ command: 'close-procs', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
      expect(await ui.find({ type: 'Button', key: 'open-procs' })).toBeDefined()
      await ui.unmount()
    })

    test(`a survey holds the band, so it shows no button, on ${surface}`, async ($, on) => {
      await startSession($, on)
      const ui = await mountBand($, surface, { hasSurvey: true })
      expect(await ui.find({ type: 'Button', key: 'open-procs' })).toBeUndefined()
      await ui.unmount()
    })
  }

  test('a pane already open at session start keeps the band away', async ($, on) => {
    await startSession($, on, [{ id: 'session-procs', title: 'Session processes', isShown: true, isFocused: false, isPlaced: true }])
    const ui = await mountBand($, 'desktop')
    expect(await ui.find({ type: 'Button', key: 'open-procs' })).toBeUndefined()
    await ui.unmount()
  })
})
