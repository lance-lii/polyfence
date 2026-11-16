<div align="center">

# 🛡️ polyfence

**One guardrail policy for every AI coding agent.**

Write your rules once in `polyfence.yaml`. Polyfence enforces them in **Claude Code**, **Codex CLI**, **Gemini CLI** and **Antigravity**, using each agent's own hook system and its own static rules.

[![CI](https://github.com/lance-lii/polyfence/actions/workflows/ci.yml/badge.svg)](https://github.com/lance-lii/polyfence/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/polyfence.svg)](https://www.npmjs.com/package/polyfence)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

</div>

```console
$ polyfence check --explain -- 'cd app && FOO=1 sudo bash -c "git -C . push -f origin main"'
DENY  cd app && FOO=1 sudo bash -c "git -C . push -f origin main"
       no-force-push (recommended): Force-pushing rewrites shared history. Push a new commit, or ask the human to force-push.
       also matched: ask-sudo (ask)

  parsed commands:
    • cd app
    • bash -c git -C . push -f origin main
    • git push -f origin main
```

---

## The problem

If your team uses more than one coding agent, you are maintaining the same guardrails in four formats that don't talk to each other:

| Agent | Where its guardrails live | Format |
|---|---|---|
| Claude Code | `.claude/settings.json` → `permissions`, `PreToolUse` hooks | JSON + scripts |
| Codex CLI | `~/.codex/rules/*.rules`, `.codex/hooks.json` | Starlark `prefix_rule()` + scripts |
| Gemini CLI | `~/.gemini/policies/*.toml`, `settings.json` → `BeforeTool` | TOML + scripts |
| Antigravity | `.agents/hooks.json` → `PreToolUse` | JSON + scripts |

Most teams end up with "don't force-push" in one place, "don't read `.env`" in another, and nothing at all in the third. The built-in prefix rules are also easy to walk around: a rule for `git push --force` misses `cd x && git -C . push -f`, and none of them notice `cat .env`.

## The fix

```bash
npm i -g polyfence
cd your-repo
polyfence init      # writes polyfence.yaml with sensible defaults + tests
polyfence install   # wires the hook into all four agents
```

Only use Claude Code? Install it as a plugin instead. No npm needed:

```
/plugin marketplace add lance-lii/polyfence
/plugin install polyfence@polyfence
```

Either way, every shell command, file read, write, edit and fetch from those agents now goes through one policy:

```yaml
# polyfence.yaml
version: 1
extends: [recommended]     # 21 built-in rules (see below)

rules:
  - id: protect-prod-config
    match:
      writePath: ["config/production/**", "infra/prod/**"]
    decision: deny
    reason: Production config changes go through a human-reviewed PR.

  - id: use-pnpm
    match:
      command: ["npm install *", "yarn add *"]
    decision: deny
    reason: This repo uses pnpm. Run `pnpm add <pkg>` instead.

tests:                      # yes, your guardrails get unit tests
  - shell: cd app && FOO=1 sudo bash -c "git -C . push -f"
    expect: deny
  - read: .env.example
    expect: defer
```

The `reason` goes back to the agent, so it changes course instead of retrying the same command.

## Why polyfence

- **🧠 It reads shell like a shell does.** Commands are parsed, not prefix-matched: `&&`, `;`, pipes, `$(...)`, backticks, `bash -c`, `eval`, `sudo`, `env`, `VAR=1`, `timeout`, `xargs`, `git -C`, and heredoc bodies. Quoted text is not code: a commit message that *mentions* `rm -rf /`, `sudo` or `curl | sh` doesn't trip anything.
- **🔑 It sees paths inside commands.** `cat .env`, `cp key.pem /tmp`, `echo x > ../other/file` and `sed -i ... polyfence.yaml` are checked against your path rules, not just the agents' file tools. It also tells reading from writing: `cat .env` is blocked, `ls .env` and `node --env-file=.env app.js` are not.
- **🔒 Agents can't quietly turn it off.** The default policy blocks agents from editing `polyfence.yaml`, `.claude/settings.json`, `.codex/*`, `.gemini/*` and `.agents/hooks.json`, through file tools *or* the shell, and from running `polyfence install`, `uninstall`, `trust` or `init`. Starting another agent with its approvals or hooks switched off (`--dangerously-skip-permissions`, `--yolo`, `--bare`...) needs your approval.
- **🧷 A repository can't loosen your rules.** Your user-level policy keeps applying under every project policy, and a project policy's `allow` settings do nothing until you run `polyfence trust` on that file.
- **🧪 Policies have tests.** `polyfence test` runs the `tests:` in your policy. Put it in CI and guardrail changes get reviewed like code.
- **🧱 Two layers.** The hook is the main enforcement point. `install` also compiles what it can into Codex `prefix_rule`s and Gemini policy-engine TOML, so a missing or broken hook still leaves the native layer in place.
- **📜 Audit log.** Every decision lands in `.polyfence/audit.jsonl`. `polyfence log --deny` shows you what your agents tried.
- **⚡ Fast and small.** ~30 ms per hook call. Zero runtime dependencies: it ships as one bundled file. No daemon, no network, no telemetry.
- **🧯 Fails closed.** A broken policy file, a hook payload it can't read or an internal error denies tool calls with a clear message instead of silently letting everything through. If the hook can't run at all, only Claude Code can be told to block; see [Agent support](#agent-support).

## What `recommended` covers

Run `polyfence presets` for the full list.

| Rule | Decision | Catches |
|---|---|---|
| `no-rm-rf-root` | deny | `rm -rf /`, `~`, `$HOME`, `.`, `*` |
| `no-disk-wipe` | deny | `mkfs`, `dd of=/dev/...`, `diskutil erase*` |
| `no-force-push` | deny | `git push --force`, `-f`, `+refspec` |
| `ask-force-with-lease` | ask | `git push --force-with-lease` |
| `no-hook-bypass` | deny | `git commit --no-verify` (also abbreviated, e.g. `--no-veri`), `-n` |
| `no-husky-bypass` | deny | `HUSKY=0 git ...` |
| `no-hooks-path-override` | deny | `git -c core.hooksPath=...`, `GIT_CONFIG_KEY_0=core.hooksPath` |
| `ask-hooks-path-config` | ask | `git config core.hooksPath <dir>` (reading it and `--unset` are fine) |
| `ask-destructive-git` | ask | `reset --hard`, `clean -f`, `checkout -- .`, `branch -D`, remote branch deletes |
| `no-pipe-to-shell` | deny | `curl ... \| sh` (also `\| /bin/sh`, `\| sudo -E bash`), `bash <(curl ...)`, `sh -c "$(wget ...)"`, `source <(curl ...)`, `eval "$(curl ...)"` |
| `protect-secrets` | deny | reading `.env*` (not `.env.example`), `*.pem`, `*.key`, SSH keys, cloud credentials |
| `ask-write-secrets` | ask | creating, overwriting or deleting those files: `cp .env.example .env`, `rm .env.local` |
| `protect-guardrails` | deny | writes to polyfence and agent config files |
| `no-guardrail-tampering` | deny | `polyfence install`, `uninstall`, `trust`, `init`, also through `npx` or `node` |
| `ask-agent-bypass` | ask | `claude --dangerously-skip-permissions`, `--bare`, `--settings`; `codex --yolo`, `--ignore-rules`; `gemini --yolo`; `agy --dangerously-skip-permissions` |
| `ask-outside-workspace` | ask | writes outside the project (temp dirs are fine) |
| `ask-sudo` | ask | `sudo`, `doas` |
| `ask-world-writable` | ask | `chmod 777`, `a+rwx` |
| `ask-publish` | ask | `npm publish`, `cargo publish`, `twine upload`, `docker push`, `gh release create`... |
| `ask-infra-changes` | ask | `terraform apply/destroy`, `kubectl apply/delete`, `pulumi up`, cloud `delete-*`... |
| `ask-db-destroy` | ask | `DROP TABLE`, `TRUNCATE`, `prisma migrate reset`, `FLUSHALL`... (not in `grep`, `git` or `echo` commands, which only search for or record the text) |

`strict` adds approval for new dependencies, every `git push`, and every network fetch.

Ordinary work (`npm test`, `git status`, `rm -rf node_modules`, `git push origin feature`) stays out of the way: no matching rule means `defer`, and the agent's normal permission flow runs.

## How it works

```
 Claude Code ─┐  PreToolUse                    ┌─ {"hookSpecificOutput": {"permissionDecision": "deny", ...}}
 Codex CLI ───┤  PreToolUse    ┌───────────┐   ├─ {"hookSpecificOutput": {"permissionDecision": "deny", ...}}
 Gemini CLI ──┼─ BeforeTool ──▶│ polyfence │──▶├─ {"decision": "deny", "reason": ...}
 Antigravity ─┘  PreToolUse    │   hook    │   └─ {"decision": "force_ask", ...}
                               └─────┬─────┘
                  normalize → parse shell → match rules → most restrictive wins → audit
```

1. Each adapter turns the agent's payload (`Bash`, `apply_patch`, `run_shell_command`, `run_command`, `Read`, `write_file`...) into one neutral call: `shell`, `read`, `write`, `edit`, `fetch`, `mcp` or `other`.
2. Shell commands are split into every command they would actually run, with wrappers removed.
3. Every matching rule is collected. **The most restrictive one wins** (`deny` > `ask` > `allow`), the same as Codex. Carve exceptions with `!negated` patterns.
4. The verdict is translated back into what that agent expects.

## Agent support

| | Claude Code | Codex CLI | Gemini CLI | Antigravity |
|---|---|---|---|---|
| Hook enforcement | ✅ | ✅ | ✅ | 🧪 experimental |
| `deny` | ✅ | ✅ | ✅ | ✅ |
| `ask` | ✅ native | ↪ `askFallback` | ↪ `askFallback` | ✅ `force_ask` |
| `allow` (auto-approve) | ✅ | ↪ defer | ✅ | ✅ `auto_approve` |
| Static native rules | — (hook only) | ✅ `prefix_rule` | ✅ policy TOML | — |
| Shell, file and fetch tools | ✅ | ✅ incl. `apply_patch` | ✅ | ✅ |
| Blocks when the hook can't run | ✅ `onFailure: block` | ❌ | ❌ | ❓ undocumented |

Errors inside polyfence follow `onError` (default `deny`), and if polyfence fails before it has read the policy it exits with code 2, which blocks the call in Claude Code, Codex and Gemini CLI. A hook that can't run at all is up to the agent: polyfence or `node` missing from `PATH`, the process killed, or a timeout. `install` sets [`"onFailure": "block"`](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails) for Claude Code (v2.1.295 or later), so those calls are blocked. Codex and Gemini CLI have no such setting and run the tool call when a hook fails or times out, and Antigravity doesn't document what it does. On those, check `polyfence doctor` after installing.

Codex and Gemini hooks can't open an approval prompt. For those, `ask` follows `askFallback`: `deny` (default) blocks with a message telling the agent to ask you, and `defer` hands the call to the agent's own approval flow. With `askFallback: defer`, Codex still prompts you for shell commands, because `install` compiles your `ask` rules into native `prompt` rules.

Notes:
- **Codex** [runs a hook only after you trust it](https://learn.chatgpt.com/docs/hooks): open `/hooks` in Codex after `polyfence install` and approve the polyfence hook, or it does nothing. Trust is tied to the hook's definition, so approve it again if it changes. Codex also loads project-level `.codex/` hooks and rules only for trusted projects. Use `--scope user` to install globally.
- **Gemini CLI** currently ignores workspace-level policy files. Use `--scope user` if you want the static TOML layer active. The hook works at either scope.
- **Antigravity** replaced Gemini CLI for most users in June 2026, and its hook format is still settling. Its hooks must always return a [decision](https://antigravity.google/docs/hooks): polyfence sends `deny`, `force_ask` for `ask`, `auto_approve` for `allow`, and `allow` when no rule matches, which leaves the call to Antigravity's own settings. Please [open an issue](../../issues) if something looks off.

## CLI

```
polyfence init [--preset recommended|strict]     create polyfence.yaml
polyfence install [agents...] [--scope project|user] [--command <cmd>] [--dry-run]
polyfence uninstall [agents...] [--scope project|user]
polyfence check [--explain] -- <shell command>   evaluate a command (exit 2 on deny)
polyfence check --tool read|write|edit --path <file>
polyfence check --tool fetch --url <url>
polyfence test                                   run the tests in polyfence.yaml
polyfence trust [--revoke]                       let this project's policy use `allow`
polyfence compile codex|gemini [--out file]      print native static rules
polyfence log [-n 20] [--deny] [--json]          show the audit log
polyfence doctor                                 show what is wired up where
polyfence presets [name]                         list built-in rules
polyfence hook [agent]                           (called by agents) read a hook payload on stdin
```

`agents` is any of `claude`, `codex`, `gemini`, `antigravity`. The default is all four.

If you don't want a global install, run the hook through your project's `node_modules`:

```bash
npm i -D polyfence
npx polyfence install --command "npx --no polyfence hook"
```

## Policy reference

```yaml
version: 1
extends: [recommended]      # presets: recommended, strict
disable: [ask-sudo]         # turn off preset rules by id
default: defer              # when nothing matches: defer | allow | ask | deny
askFallback: deny           # Codex/Gemini can't prompt from hooks: deny | defer
audit: matched              # matched | all | off
onError: deny               # internal errors: deny | allow

rules:
  - id: my-rule             # optional; reusing a preset id replaces that rule
    decision: deny          # deny | ask | allow
    reason: Shown to the agent and to you.
    match:                  # every key given must match (AND); list items are OR
      tool: [shell, read, write, edit, fetch, mcp, other, any]
      agent: [claude, codex, gemini, antigravity]
      rawTool: "mcp__github__*"        # the agent's own tool name
      command: ["git push *", "/^npm\\s+publish/"]
      commandLine: ["/DROP\\s+TABLE/i"]
      script: ["/curl.*\\|\\s*sh/"]
      path: [".env", "secrets/**", "!secrets/README.md"]
      readPath: ["secrets/**"]
      writePath: ["config/production/**"]
      url: ["https://*.pastebin.com/*"]
      outsideWorkspace: true

tests:
  - shell: git push --force
    expect: deny            # deny | ask | allow | defer
    rule: no-force-push     # optional: assert which rule decided
  - read: .env
    expect: deny
  - write: ../elsewhere.txt
    expect: ask
  - fetch: https://example.com
    expect: defer
```

### Pattern syntax

| Field | Matches against | Glob behaviour |
|---|---|---|
| `command` | each parsed command, wrappers removed (`git push -f origin`). An argument that contains whitespace, such as a quoted commit message, appears as `<text>`, so a flag pattern can't match inside it. | anchored. `*` matches anything. A trailing ` *` also matches nothing, so `git push *` matches `git push`. |
| `commandLine` | the whole raw command string, quoted text included. Use it for content, such as SQL. | unanchored search |
| `script` | the shell code that runs: the command, every `bash -c` script and every `$(...)`, with quoted text, comments and heredoc data blanked. Use it for things `command` can't see, such as pipes, `sudo` and `VAR=1` prefixes. | unanchored search |
| `path` | every path a call touches: file-tool paths plus path-like shell arguments and redirect targets | gitignore-style. A bare name (`.env`) matches at any depth, `dir/**` is rooted at the project, `~/` is your home, `**`, `*`, `?`, `{a,b}` |
| `readPath` | only paths whose contents the call can read: read and edit tools, and shell arguments that aren't just written, listed or passed along (`cp a b` reads `a`; `rm x`, `ls x`, `> x` and `--env-file x` read nothing) | same as `path` |
| `writePath` | only paths the call modifies: write/edit tools, redirects, `rm`/`mv`/`cp`/`tee`/`sed -i`/`chmod`/`curl -o`/`wget -O`... | same as `path` |
| `url` | `WebFetch`-style URLs, plus URLs in shell arguments | anchored, case-insensitive |

Any pattern can be a regex instead: `/^git\s+push\b/i`. Start a pattern with `!` to exclude matches. In `path` and `writePath`, `/.../` counts as a regex only if it uses regex syntax (`\`, `^`, `$`, `|`, `(` or `[`), so `/etc/hosts` and `/etc/` are absolute paths.

On macOS and Windows, where file names ignore case, path globs match in any case (`.env` also catches `cat .ENV`), and command names are compared in lower case (`GIT push -f` is `git push -f`). `commandLine` patterns are also tried against the command in lower case. Regex path patterns keep the flags you give them, and the native Codex and Gemini rules stay case-sensitive.

When a call matches more than one rule, the most restrictive one wins. To make an exception, narrow the rule with a `!pattern` rather than adding an `allow` rule.

### Where the policy comes from

The hook looks for `polyfence.yaml` (or `.polyfence.yaml`, `polyfence.yml`, `.polyfence.yml`) from the directory the session started in, upward. Claude Code and Gemini CLI report that directory separately from the current one, so an agent that changes directory keeps its project's policy. For Codex it is the session's working directory, and for Antigravity the first workspace folder. A directory named inside the tool call, such as Gemini's `dir_path` or Antigravity's `Cwd`, is never used to find the policy, because the agent chooses it.

Policies are layered, and a layer can only add restrictions to the others:

1. `~/.config/polyfence/polyfence.yaml`, your user-level policy, if you have one.
2. The project's policy. Without one, and without a user-level policy, the built-in `recommended` preset.
3. The policy nearest to the current directory, if that is a different file: a package with its own policy, or a git worktree.

Every matching rule from every layer counts and the most restrictive wins, so a project's `disable:` or a replaced rule id never switches off a rule from your user-level policy. Relative path patterns are rooted at the directory of the file they come from.

### Trusting a project policy

A project policy arrives with the repository, so anyone who can change the repository can change it. It can always tighten. What loosens (`allow` rules, `default: allow` and `onError: allow`) is ignored until you trust the file:

```bash
polyfence trust            # trust the current content of this project's policy
polyfence trust --revoke
```

Trust is recorded in `~/.config/polyfence/trusted.json` against the file's content, so any edit withdraws it. `polyfence doctor` and `polyfence check` tell you when a policy is waiting for it. Your user-level policy is always trusted. `polyfence test` checks the project file exactly as written, without your user-level layer, so it gives the same result in CI.

## Guardrails in CI

```yaml
# .github/workflows/guardrails.yml
name: guardrails
on: [pull_request]
jobs:
  polyfence:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx -y polyfence test
```

## FAQ

**Is this a sandbox?** No. Polyfence decides which tool calls an agent may make. It doesn't isolate processes. A determined program can always find a way past pattern rules (writing a script and then running it, for example). Use polyfence to keep well-meaning agents away from foot-guns, and run untrusted work in a container or VM as well.

**What can't the rules see?** Anything that is only decided when the command runs. These still get through today:
- Commands built at run time: variables (`x=git; $x push -f`), brace expansion (`{git,push} --force`), git aliases (`git -c alias.p='push -f' p`), and globs the shell expands into protected files (`cat .env*`).
- Code run by another interpreter: `python -c`, `node -e`, or a script the agent writes and then runs.
- Shell input that isn't a download or a heredoc the shell reads, such as `echo 'git push -f' | bash` or `cat <<EOF | sh`.
- `cd` inside one command (`cd ~/.aws && cat credentials`), wrapper options polyfence doesn't parse (`find -exec`, `env -S`, `sudo -iu user`, which is still asked about as `sudo`), and wrappers it doesn't know (`docker exec`, `parallel`, `chrt`, `taskset`). The ones it does know include `sudo`, `env`, `timeout`, `nice`, `xargs`, `time`, `nohup`, `setsid`, `caffeinate`, `flock`, `strace`, `watch`, `ssh`, `su -c` and `npx -c`.
- Reads that don't name the file: a search over a directory that contains `.env` (`grep -r KEY .`, or a search tool pointed at `.`), and a program that prints what it was given (`node --env-file=.env -p process.env`).
- Writes it doesn't model: `curl -O` and plain `wget URL` (named after the URL), `curl --output-dir`, `git checkout <ref> -- <file>`, unpacked archives, and persistent settings such as `git config core.hooksPath`.

**Does it phone home?** No. It reads your policy, makes a decision locally and appends one line to a local log.

**Will it slow my agent down?** A hook call takes about 30 ms. Agents run hooks before each tool call, and the model's own latency is far larger.

**Can I use it with just one agent?** Yes: `polyfence install claude`. You still get shell parsing, path checks, policy tests and the audit log.

## Roadmap

- [ ] `polyfence learn`: suggest rules from your audit log and agent transcripts
- [ ] More agents: Cursor CLI, OpenCode, Copilot CLI, Goose, Aider
- [ ] Shareable rule packs (`extends: [github:org/rules]`)
- [ ] Hook layer for MCP server allow/deny lists
- [ ] Single-file binary builds

## Contributing

Bug reports with a concrete command that slipped through, or got blocked when it shouldn't have, are the most useful contributions. They become test cases. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
