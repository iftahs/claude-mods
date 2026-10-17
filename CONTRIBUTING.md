# Contributing

Thanks for helping. Bug fixes, improvements to existing mods and new mods are all welcome.

## How changes land

- Fork the repository and open a pull request against `main`. Nobody pushes to `main` directly.
- The maintainer reviews every pull request before it is merged.
- Keep a pull request to one mod or one topic.

## Adding a mod

1. Put it in `mods/<name>/` with `.claude-plugin/plugin.json`, `hooks/hooks.json`, the hooks module, and a `README.md` that says what it does, what it runs and what it reads.
2. Add tests (`*.test.ts`) for the behaviour it promises.
3. Add it to `.claude-plugin/marketplace.json` and to the table in the root `README.md`.

## Before you open the pull request

```bash
claude plugin validate mods/<name>
claude plugin test mods/<name>
```

Both must pass.

## Ground rules for mods

- No network calls and no telemetry unless the mod's purpose needs them and its README says so plainly.
- Never send local data (files, processes, environment, credentials) to the model or anywhere else without the user asking for it.
- Commands a mod runs are fixed strings or argument vectors. Never build a shell command from session data.
- No secrets, tokens, personal paths or machine-specific values in code, tests or fixtures.
- Don't commit the generated `.claude-plugin/types/` folder.

## Reporting security problems

Please don't open a public issue. Follow [SECURITY.md](SECURITY.md).
