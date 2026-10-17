# session-procs

A live pane that lists every process the current Claude Code session started, so a dev server you asked Claude to run never gets lost.

- **Started by tools**: each Bash or PowerShell command Claude ran, titled with the command itself (`$ npm run dev`), and the processes under it (`node …/bin/next dev`) with PID, memory and age.
- **Detached**: processes that kept running after the shell that started them exited.
- **MCP servers & helpers**: the session's MCP servers and other helpers, behind a toggle.
- **Stat tiles** for running processes, helpers, total memory and session uptime, with sparklines.
- **Status line**: `procs: N running from tools` under the prompt while something is running.

On the desktop app the pane docks beside the session sidebar and draws cards that follow your light or dark theme. In a terminal it draws a themed text view.

## Use

The pane opens when a session starts. Close it any time; type `/procs` to bring it back. Press `r` to refresh and `h` to show or hide helpers while the pane has focus.

## How it works

The mod asks the operating system for the process list, finds its own Claude Code process, and shows everything below it.

- **Windows**: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command`, started in `%SystemRoot%\System32`, running a fixed, readable `Get-CimInstance Win32_Process` query.
- **macOS and Linux**: `/bin/sh -c 'echo $$; PATH=$(command -p getconf PATH 2>/dev/null || echo /usr/bin:/bin); export PATH; exec ps -A -o pid= -o ppid= -o rss= -o etime= -o args='`.

It refreshes every 5 seconds while the pane is visible, every 30 seconds otherwise, and shortly after each Bash or PowerShell tool call. On Windows each refresh takes about a second of PowerShell start-up.

## Privacy and safety

- Runs entirely on your machine. No network calls, no telemetry.
- The process list is never sent to the model or over the network, and it is never added to the conversation. It does live in a few places you should know about: the session's plugin state holds the latest snapshot (other plugins installed in the same session can read it), the session's process ancestry (process names and PIDs, no command lines) and any error messages, redacted, are written to Claude Code's debug log, and on remote surfaces such as mobile, Claude Code carries the drawn pane to that device.
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

- A process started with `cmd &` inside a shell that exits before the next refresh can't be traced back to the session, so it won't show.
- The macOS and Linux probe is covered by tests but has had less real-world use than the Windows one.
- Tested on Claude Code 2.1.295. The function-hooks API is in early access.

## Develop

```bash
claude plugin validate mods/session-procs
claude plugin test mods/session-procs
```
