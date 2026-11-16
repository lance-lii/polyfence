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

Hardening before the first release:

- Policies are layered: the user-level policy keeps applying under a project policy, and a policy nearer to the working directory adds to the project's instead of replacing it.
- A project policy's `allow` rules, `default: allow` and `onError: allow` are ignored until `polyfence trust` records the file's content.
- The policy is looked up from the directory the session started in (`CLAUDE_PROJECT_DIR`, `GEMINI_PROJECT_DIR`), so changing directory can't swap it.
- Unreadable hook input and an unknown agent name fail closed.
- New `script` match key: shell code with quoted text, comments and heredoc data blanked. `ask-sudo`, `no-pipe-to-shell` and `no-husky-bypass` use it, so mentioning `sudo` or `curl | sh` in a commit message no longer matches.
- `command` patterns see an argument that contains whitespace as `<text>`, so `git commit -m "support -json output"` is no longer read as `git commit -n`.
- New `readPath` match key. `protect-secrets` blocks reads only; the new `ask-write-secrets` asks before a secrets file is created, overwritten or deleted. `ls .env`, `cp .env.example .env` and `--env-file .env` are no longer denied.
- New rules: `no-guardrail-tampering`, `ask-agent-bypass`, `ask-hooks-path-config`.
- More wrappers are seen through: `time -p`, `caffeinate`, `setsid`, `flock`, `strace`, `busybox`, `arch`, `watch`, `ssh`, `su -c`, `npx -c`.
- Claude Code: `Grep` globs, the `PowerShell` tool and paths nested inside MCP arguments are checked.
- Audit entries carry the session id, subagent id and type, tool-use id and permission mode. Credentials in commands are redacted, and the log rotates at 5 MB.
- With no user-level policy, an untrusted project policy can't leave out, disable or replace rules of the built-in `recommended` preset: the preset stays on underneath until `polyfence trust`.
- `command` patterns are also tried against commands a segment wraps, so `op run -- git push -f`, `docker exec app rm -rf /` and `find -exec` are caught without listing every wrapper. Quoted text, the arguments of `echo`/`grep`/`man` and the subcommand of tools such as `git` are skipped.
- Windows: path rules handle drive letters, backslashes, Git Bash paths and `~`; `git.exe` is `git`; the `PowerShell` tool is parsed with `\` as a path separator. CI runs Node 20 and, without gating, Windows.
- Hook events that carry no tool call get a neutral reply instead of a verdict.
