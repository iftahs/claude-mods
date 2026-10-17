# claude-mods

Mods for [Claude Code](https://claude.com/claude-code): small plugins that add live panes, status lines and hooks to Claude Code's own interface.

Every mod here runs locally, makes no network calls and sends nothing to the model unless its README says otherwise.

## Mods

| Mod | What it does |
| --- | --- |
| [session-procs](mods/session-procs) | A live pane listing every process the current session started: dev servers launched from Bash, tool shells, MCP servers. Shows memory, age and sparklines, and flags processes left behind after their shell exited. |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-procs --marketplace iftahs/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session, desktop sessions included).

Mods use Claude Code's function-hooks API, which is in early access and changes between releases. They are tested on the version noted in each mod's README.

## Try a mod from a clone

```bash
git clone https://github.com/iftahs/claude-mods.git
claude --plugin-dir claude-mods/mods/session-procs
```

To load it in every session without installing, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Every change goes through a pull request and is reviewed before it is merged.

## Security

Found a security problem? Please report it privately, as described in [SECURITY.md](SECURITY.md), not in a public issue.

## License

[MIT](LICENSE)
