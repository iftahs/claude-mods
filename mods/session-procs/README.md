# session-procs

A live pane that lists every process the current Claude Code session started, so a dev server you asked Claude to run never gets lost.

<p>
  <img alt="session-procs docked in the sidebar, dark theme" src="../../docs/screenshots/sidebar-dark.png" width="300">
  &nbsp;
  <img alt="session-procs docked in the sidebar, light theme" src="../../docs/screenshots/sidebar-light.png" width="300">
</p>

The screenshots use demo data. The wider layout, with PID and memory-meter columns, appears when you widen the pane:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../docs/screenshots/wide-dark.png">
  <img alt="session-procs in a wide pane, with PID, memory meter and age columns" src="../../docs/screenshots/wide-light.png" width="720">
</picture>

## What it shows

- **Started by tools**: each Bash or PowerShell command Claude ran, with a plain-words label (`Start Expo dev server · My App/app`) above the full command (`$ cd "…/app" && npx expo start`), wrapped over up to eight lines instead of cut short, and the processes under it (`node …/bin/next dev`) with PID, memory and age. The label is the description Claude gave the tool call. When there is none, the mod names well-known dev tools from the command (Expo, Next.js, Vite, `npm run <script>`, Vitest, Docker Compose and more) and shows no label for anything else.
- **Detached**: processes that kept running after the shell that started them exited, labelled the same way when the command is a known dev tool.
- **MCP servers & helpers**: the session's MCP servers and other helpers, behind a toggle.
- **Stat tiles** for running processes, helpers, total memory and session uptime, with sparklines.
- **Band above the prompt**: a row of its own with the number of processes running from tools and their total memory on the left and the **Processes** button at the right end. Anything other mods draw in the band sits on rows beneath it. It steps aside while the pane is open.
- **Status line**: `procs: N running from tools` under the prompt while something is running.

On the desktop app the pane docks beside the session sidebar and draws cards that follow the theme setting of the Claude desktop app (dark or light), read from the app's `config.json`; when the app is set to match the system, and in VS Code and on mobile, the cards follow the system color scheme. In a terminal it draws a themed text view.

## Use

A band above the prompt shows how many processes run from tools and how much memory they use, with a **Processes** button at its right end. Press the button (or `p` while the band has focus, or type `/procs`) to open the pane. Close the pane any time; the band comes back. Collapse the band with its `[-]`. Press `r` to refresh and `h` to show or hide helpers while the pane has focus.

## How it works

The mod asks the operating system for the process list, finds its own Claude Code process, and shows everything below it.

- **Windows**: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command`, started in `%SystemRoot%\System32`, running a fixed, readable `Get-CimInstance Win32_Process` query.
- **macOS and Linux**: `/bin/sh -c 'echo $$; PATH=$(command -p getconf PATH 2>/dev/null || echo /usr/bin:/bin); export PATH; exec ps -A -o pid= -o ppid= -o rss= -o etime= -o args='`.

To say what each process is, the mod notes the description and command of every Bash and PowerShell tool call just before it runs, and matches a process group to its note by command (exactly, or by prefix when the title was cut at 300 characters). A PowerShell tool shell doesn't show its command in the process list, so it takes the newest PowerShell note from the five seconds before the process started, and the title becomes `PS> <command>`.

It refreshes every 5 seconds while the pane is visible, every 30 seconds otherwise, and shortly after each Bash or PowerShell tool call. On Windows each refresh takes about a second of PowerShell start-up. The app's theme setting is read when the session starts and again at most every 30 seconds, so a theme switch shows in the open pane within about half a minute.

## Privacy and safety

- Runs entirely on your machine. No network calls, no telemetry.
- To pick the card colors, it reads one value, `userThemeMode`, from the Claude desktop app's `config.json` (`%APPDATA%\Claude\config.json` on Windows, `~/Library/Application Support/Claude/config.json` on macOS, `$XDG_CONFIG_HOME/Claude/config.json` or `~/.config/Claude/config.json` on Linux). It keeps `dark` or `light` and nothing else from that file: the rest is never stored, logged or drawn. A missing or unreadable file, or any other value, leaves the cards on the system color scheme.
- The process list is never sent to the model or over the network, and it is never added to the conversation. It does live in a few places you should know about: the session's plugin state holds the latest snapshot (other plugins installed in the same session can read it), the session's process ancestry (process names and PIDs, no command lines) and any error messages, redacted, are written to Claude Code's debug log, and on remote surfaces such as mobile, Claude Code carries the drawn pane to that device.
- To label processes, the mod keeps the description and the command of the last 50 Bash and PowerShell tool calls (the main agent's and subagents') in the session's plugin state, so other plugins in the same session can read them. Both go through the masking below before they are stored; the command is collapsed to one line and capped at 300 characters and the description at 80. They are not sent anywhere or added to the conversation.
- Command lines often carry secrets. Before a snapshot is stored or drawn, the mod masks the following. Masking is best effort; treat the pane like any terminal that shows command lines.
  - Values of flags and variables named like tokens, secrets, passwords, API or access keys, account keys, credentials and `auth` in any case style (`--token=...`, `--api-key ...`, `--secretKey ...`, `PASSWORD=...`, `AccountKey=...`), including values left in an unclosed quote. Flags that name where a secret lives (ending in `stdin`, `file`, `path`, `prompt` or `env`, such as `--password-file` or `--tokenPath`) are left alone.
  - Connection-string and query-string parameters (`Password=...;`, `?token=...&`).
  - Credential headers: `Authorization`, `Proxy-Authorization`, `Cookie` and `X-...-Key`, `-Token`, `-Secret` or `-Auth` headers, plus `Bearer`, `Basic` and `Token` values.
  - Passwords in URLs (`scheme://user:password@host`), Slack and Discord webhook URLs, and Telegram bot tokens.
  - Token formats: GitHub, Anthropic, OpenAI, Stripe, Slack, npm, GitLab, Hugging Face, AWS access key IDs, Google API keys and JWTs.
  - Password options of `mysql`, `mysqldump`, `mysqladmin` and `mariadb` (`-p...`), `redis-cli` (`-a`), `curl` (`-u`, `--user`, `--proxy-user`), `sqlcmd` (`-P`), `sshpass` (`-p`), `docker login` (`-p`), `openssl` (`-pass pass:...`) and `aws configure set`.
- Command lines are cleaned of control and direction-override characters and capped (2,000 characters read per process, 300 shown per row), and a card is capped in size.
- It only reads processes. It never stops or changes one.
- Executables are run by absolute path: PowerShell from `%SystemRoot%\System32\WindowsPowerShell\v1.0` (the system root is used only when it is a plain drive path, otherwise `C:\Windows`), and `/bin/sh`, which looks up `ps` in the system `PATH` reported by `getconf`, not in your own.
- Both probe commands are fixed strings with nothing from the session interpolated into them, and the Windows probe avoids encoded commands and execution-policy bypasses.

## Limits

- Labels are best effort: two identical commands started within a couple of seconds can swap labels, and a PowerShell call that waited more than five seconds for approval is shown without one.
- A process started with `cmd &` inside a shell that exits before the next refresh can't be traced back to the session, so it won't show.
- The macOS and Linux probe is covered by tests but has had less real-world use than the Windows one.
- Tested on Claude Code 2.1.295. The function-hooks API is in early access.

## Develop

```bash
claude plugin validate mods/session-procs
claude plugin test mods/session-procs
```

## Author

Made by **Iftah Saar**. More at **[iftah.dev](https://iftah.dev)**.
