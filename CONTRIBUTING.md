# Contributing to polyfence

Thanks for helping make coding agents safer to run.

## Setup

```bash
npm install
npm test          # builds with tsc, then runs node:test
node dist/src/cli.js check --explain -- 'your command here'
```

Node 22+ is needed for development; the published CLI runs on Node 20+. `yaml` is bundled into `bin/polyfence.cjs` with esbuild, so the package has no runtime dependencies. Please keep it that way. After changing `src/`, run `npm run bundle` and commit `bin/polyfence.cjs` (the Claude Code plugin runs that file straight from the repo; CI checks it is current).

## The most useful contributions

1. **A bypass.** A command that should have been blocked but wasn't. Add it to the `SHELL_CASES` table in `test/presets.test.ts`, then fix the parser (`src/shell.ts`) or the preset (`src/presets.ts`).
2. **A false positive.** An everyday command that got blocked. Add it to the same table with `'defer'`.
3. **Agent payload fixes.** If an agent changes its hook payload, update `src/adapters.ts` and add the real payload, with secrets removed, to `test/adapters.test.ts`.
4. **New agents.** An adapter needs three things: `toCall` (payload to neutral call), `reply` (verdict to the agent's output) and an entry in `src/install.ts`.

## Layout

| File | What it does |
|---|---|
| `src/shell.ts` | Shell parser: splits a command string into every command it would run |
| `src/patterns.ts` | Glob and regex compilation for commands, paths and URLs |
| `src/engine.ts` | Rule matching and verdicts; ToolCall builders |
| `src/adapters.ts` | Per-agent hook payload parsing and replies |
| `src/policy.ts` | Loading and validating `polyfence.yaml`, preset merging |
| `src/presets.ts` | Built-in rule sets |
| `src/compile.ts` | Codex `.rules` and Gemini policy TOML generation |
| `src/install.ts` | Merging hook entries into agent configs |
| `src/hook.ts` | The hook entry point that agents call |
| `src/cli.ts` | Commands |

## Ground rules for presets

- `recommended` must stay quiet for normal development. Every new rule needs `defer` test cases for the common commands near it.
- Prefer `ask` to `deny` unless the action is irreversible *and* almost never intended.
- Every rule needs a `reason` that tells the agent what to do instead.
