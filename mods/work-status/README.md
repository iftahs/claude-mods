# work-status: a Claude Code mod

A side pane, "Work status", that shows:

- **What Claude is doing or waiting on**: working, running a command, waiting for subagents, waiting for your answer or input, stopped, plus outside waits Claude reports (e2e tests, a code review, a deploy) and background tasks.
- **The plan**: every task with its status (waiting, in progress, done, failed), animated icons, a progress bar with the percentage done, and how long each task took (live for the one in progress).
- **The current step**: under the task in progress, what Claude is doing right now (for example "Running: npm test").
- **The turn**: how long it has been working and how full the context window is ("Working 3m 12s · context 34%").
- **Subagents**: each running subagent with its description, type and elapsed time.
- **Files touched**: the files Claude, or a subagent, edited or wrote in this plan (first 15, then "+n more").
- **Errors**: tool calls that failed, in red.
- **Timeline**: the last ten tool calls with how long ago they ran.

It works in the Claude Code desktop app (animated SVG icons) and the terminal (text spinner and block bar).

## Requirements

- Claude Code with mods (function hooks) support. The mod was built against Claude Code 2.1.308; check yours with `claude --version` and update if it's older.
- An account whose organization doesn't block hooks modules (`allowManagedHooksOnly`). A personal account normally has no such policy.

## Install

1. Unzip so you have a folder named `work-status` that contains `.claude-plugin/plugin.json`. Put it somewhere permanent, for example `~/mods/work-status`.
2. Check it:

   ```bash
   claude plugin validate ~/mods/work-status
   ```

3. Load it in one of these ways.

### Every session (terminal and desktop app)

Add the folder to the `env` block of `~/.claude/settings.json` (create the file if it doesn't exist):

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/mods/work-status"
  }
}
```

To load several mods, separate the paths with `:` on macOS/Linux or `;` on Windows. Restart Claude Code (or start a new session in the desktop app) afterwards.

### One terminal session only

```bash
claude --plugin-dir ~/mods/work-status
```

## Use

- A one-row band above the prompt shows what Claude is doing, the plan's progress and how many things are pending, with a "Status" button (hotkey w) that opens the pane. The band hides while the pane is open.
- The pane also opens by itself when Claude starts a plan.
- `/work-status` reopens the pane.
- The band also shows the elapsed turn time while Claude works, and a red "n errors" when tool calls failed.
- A desktop notification and toast ("Work status") fire when every task of the plan is done, or when a turn ends on an error. Waiting for your input does not notify.
- A new plan (a fresh task list) clears the files and errors lists.
- `/work-status clear` resets the waiting list, the plan, files, errors and the timeline.
- Claude reports outside waits and failed tasks itself: the mod adds a short instruction to its system prompt and two tools (`set_waiting`, `mark_task`).

## Troubleshooting

- **Nothing shows:** run `claude --debug --plugin-dir ~/mods/work-status` and look for lines starting with `work-status:`.
- **"hooks modules are turned off":** your account's organization policy blocks mods; ask its admin.
- **Mod files:** `hooks/register.tsx` is the wiring, `hooks/plan.ts` the plan logic and formatters, `hooks/icons.ts` the SVG icons, `types/index.d.ts` the state types, `tests/` the tests (`claude plugin test ~/mods/work-status`).
