# Changelog

## 0.1.0 (unreleased)

First release.

- One `polyfence.yaml` policy enforced through hooks in Claude Code, Codex CLI, Gemini CLI and Antigravity (experimental).
- Shell parser that sees through `&&`, pipes, `$(...)`, backticks, `bash -c`, `eval`, `sudo`, `env`, `VAR=1`, `timeout`, `xargs`, `git -C` and heredocs.
- Path rules that apply to file tools *and* to paths inside shell commands. `writePath` and `outsideWorkspace` cover modifications only.
- `recommended` and `strict` presets.
- Policy tests (`polyfence test`) for CI.
- Native static layers: Codex `prefix_rule` files and Gemini policy-engine TOML.
- Audit log (`polyfence log`), `check --explain`, `doctor`, `install --dry-run`, `uninstall`.
- Claude Code plugin and marketplace manifest.
- Zero runtime dependencies (single bundled file).
