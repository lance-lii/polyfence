import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

function project(policy?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyfence-cli-'));
  if (policy !== undefined) fs.writeFileSync(path.join(dir, 'polyfence.yaml'), policy);
  return dir;
}

function cli(args: string[], cwd: string, input?: string, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', XDG_CONFIG_HOME: path.join(cwd, '.xdg'), ...extraEnv };
  // These tests may themselves run inside an agent session.
  for (const name of ['CLAUDE_PROJECT_DIR', 'GEMINI_PROJECT_DIR']) if (!(name in extraEnv)) delete env[name];
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, input, encoding: 'utf8', env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('hook: Claude payload end to end, with audit log', () => {
  const dir = project('extends: [recommended]\n');
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force' }, cwd: dir, hook_event_name: 'PreToolUse' });
  const r = cli(['hook', 'claude'], dir, payload);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, 'deny');
  const log = fs.readFileSync(path.join(dir, '.polyfence', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].rule, 'no-force-push');
  assert.equal(log[0].agent, 'claude');
});

test('hook: auto-detects the agent', () => {
  const dir = project('extends: [recommended]\n');
  const gemini = cli(['hook'], dir, JSON.stringify({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'rm -rf ~' }, cwd: dir }));
  assert.equal(JSON.parse(gemini.out).decision, 'deny');
});

test('hook: a broken policy and unreadable input both fail closed', () => {
  const dir = project('rules: [ {match: {comand: x}} ]\n');
  const r = cli(['hook', 'claude'], dir, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: dir }));
  const out = JSON.parse(r.out).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /policy error/);

  for (const input of ['not json', '', '{"tool_name":"Bash","tool_input":{"command":"git push -f"', '[]']) {
    const junk = cli(['hook', 'claude'], dir, input);
    assert.equal(JSON.parse(junk.out).hookSpecificOutput.permissionDecision, 'deny', input);
    assert.equal(JSON.parse(cli(['hook', 'antigravity'], dir, input).out).decision, 'deny', input);
    // Without an agent name there is no reply format to use: exit code 2 blocks the call.
    assert.equal(cli(['hook'], dir, input).code, 2, input);
  }
  assert.equal(cli(['hook', 'cursor'], dir, '{}').code, 2);
});

test('hook: the policy comes from the session directory, not a directory named in the tool call', () => {
  const dir = project('extends: [recommended]\n');
  const planted = project('default: allow\n');
  const gemini = cli(['hook', 'gemini'], dir, JSON.stringify({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'git push --force', dir_path: planted }, cwd: dir }));
  assert.equal(JSON.parse(gemini.out).decision, 'deny');
  const agy = cli(['hook', 'antigravity'], dir, JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git push --force', Cwd: planted } }, workspacePaths: [dir] }));
  assert.equal(JSON.parse(agy.out).decision, 'deny');
});

test('hook: an internal error denies the call unless the policy says onError: allow', () => {
  // Deep enough to overflow the stack while reading the payload.
  const nested = '['.repeat(100000) + ']'.repeat(100000);
  const payload = (dir: string) => `{"tool_name":"mcp__fs__write","turn_id":"t","cwd":${JSON.stringify(dir)},"tool_input":{"path":".env","x":${nested}}}`;
  const strictDir = project('extends: [recommended]\n');
  const r = cli(['hook', 'codex'], strictDir, payload(strictDir));
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /internal error, failing closed/);

  // `onError: allow` loosens the policy, so a project file has to be trusted before it counts.
  const lenientDir = project('extends: [recommended]\nonError: allow\n');
  const untrusted = cli(['hook', 'codex'], lenientDir, payload(lenientDir));
  assert.equal(JSON.parse(untrusted.out).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(cli(['trust'], lenientDir).code, 0);
  const lenient = cli(['hook', 'codex'], lenientDir, payload(lenientDir));
  assert.equal(lenient.code, 0);
  assert.equal(lenient.out, '');
  assert.match(lenient.err, /polyfence: /);
});

const bash = (command: string, cwd: string, more: Record<string, unknown> = {}) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd, ...more });
const decision = (r: { out: string }) => (r.out ? JSON.parse(r.out).hookSpecificOutput.permissionDecision : 'defer');

test('hook: a project policy cannot auto-approve until it is trusted, and edits withdraw trust', () => {
  const dir = project('default: allow\nrules:\n  - id: yes-to-curl\n    match: { command: "curl *" }\n    decision: allow\n');
  const ls = () => decision(cli(['hook', 'claude'], dir, bash('ls', dir)));
  const curl = () => decision(cli(['hook', 'claude'], dir, bash('curl https://x.dev', dir)));
  assert.equal(ls(), 'defer');
  assert.equal(curl(), 'defer');
  assert.match(cli(['check', '--', 'ls'], dir).out, /not trusted/);
  assert.match(cli(['doctor'], dir).out, /not trusted/);
  // `polyfence test` checks the file as written, so CI doesn't depend on local trust.
  assert.equal(JSON.parse(cli(['check', '--json', '--policy', 'polyfence.yaml', '--', 'ls'], dir).out).outcome, 'allow');

  assert.equal(cli(['trust'], dir).code, 0);
  assert.equal(ls(), 'allow');
  assert.equal(curl(), 'allow');

  fs.appendFileSync(path.join(dir, 'polyfence.yaml'), '# changed\n');
  assert.equal(ls(), 'defer');
  assert.equal(cli(['trust'], dir).code, 0);
  assert.equal(cli(['trust', '--revoke'], dir).code, 0);
  assert.equal(ls(), 'defer');
});

test('hook: the user-level policy still applies under a project policy', () => {
  const dir = project('version: 1\nrules: []\n');
  const user = path.join(dir, '.xdg', 'polyfence');
  fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(path.join(user, 'polyfence.yaml'), 'extends: [strict]\n');
  assert.equal(decision(cli(['hook', 'claude'], dir, bash('git push --force', dir))), 'deny');
  assert.equal(decision(cli(['hook', 'claude'], dir, bash('git push origin main', dir))), 'ask');
  // The user's own file may loosen things; the project's `disable` can't reach into it.
  fs.writeFileSync(path.join(dir, 'polyfence.yaml'), 'extends: [strict]\ndisable: [ask-git-push]\n');
  assert.equal(decision(cli(['hook', 'claude'], dir, bash('git push origin main', dir))), 'ask');
  // `polyfence test` looks at the project file alone.
  fs.writeFileSync(path.join(dir, 'polyfence.yaml'), 'tests:\n  - shell: git push origin main\n    expect: defer\n');
  assert.equal(cli(['test'], dir).code, 0);
});

test('hook: changing directory cannot swap the project policy for another one', () => {
  const dir = project('extends: [recommended]\nrules:\n  - id: no-deploy\n    match: { command: "make deploy *" }\n    decision: deny\n');
  const planted = project('version: 1\n');
  const env = { CLAUDE_PROJECT_DIR: dir };
  assert.equal(decision(cli(['hook', 'claude'], dir, bash('make deploy', planted), env)), 'deny');
  assert.equal(decision(cli(['hook', 'claude'], dir, bash('git push -f', planted), env)), 'deny');
  // A policy nearer to the working directory adds its rules; it replaces nothing.
  const nested = path.join(dir, 'packages', 'api');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'polyfence.yaml'), 'rules:\n  - id: no-seed\n    match: { command: "make seed *" }\n    decision: deny\n');
  assert.equal(decision(cli(['hook', 'claude'], dir, bash('make seed', nested), env)), 'deny');
  assert.equal(decision(cli(['hook', 'claude'], dir, bash('make deploy', nested), env)), 'deny');
  assert.equal(decision(cli(['hook', 'claude'], dir, bash('make seed', dir), env)), 'defer');
});

test('hook: the audit log says which session and subagent made the call, without credentials', () => {
  const dir = project('extends: [recommended]\naudit: all\n');
  cli(['hook', 'claude'], dir, bash('curl -H "Authorization: Bearer abc123def456" https://x.dev', dir, { session_id: 's1', agent_id: 'a1', agent_type: 'Explore', tool_use_id: 't1', permission_mode: 'acceptEdits' }));
  const [entry] = fs.readFileSync(path.join(dir, '.polyfence', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual([entry.session, entry.agentId, entry.agentType, entry.toolUseId, entry.mode], ['s1', 'a1', 'Explore', 't1', 'acceptEdits']);
  assert.ok(!entry.summary.includes('abc123def456'), entry.summary);
  assert.match(entry.summary, /Bearer \[redacted\]/);
});

test('the version is the same everywhere it is written', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8')).version;
  assert.equal(plugin, pkg);
  assert.equal(cli(['--version'], root).out.trim(), pkg);
});

test('hook: no policy file falls back to the recommended preset', () => {
  const dir = project();
  const r = cli(['hook', 'claude'], dir, JSON.stringify({ tool_name: 'Read', tool_input: { file_path: path.join(dir, '.env') }, cwd: dir }));
  assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, 'deny');
});

test('check: exit code 2 on deny', () => {
  const dir = project('extends: [recommended]\n');
  assert.equal(cli(['check', '--', 'git', 'push', '-f'], dir).code, 2);
  assert.equal(cli(['check', '--', 'git', 'status'], dir).code, 0);
  const json = JSON.parse(cli(['check', '--json', '--tool', 'read', '--path', '.env'], dir).out);
  assert.equal(json.outcome, 'deny');
  assert.equal(json.rule, 'protect-secrets');
});

test('init + test + install + doctor + uninstall', () => {
  const dir = project();
  assert.equal(cli(['init'], dir).code, 0);
  assert.ok(fs.existsSync(path.join(dir, 'polyfence.yaml')));
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /\.polyfence\//);
  assert.equal(cli(['init'], dir).code, 1, 'refuses to overwrite');

  const t = cli(['test'], dir);
  assert.equal(t.code, 0, t.out);
  assert.match(t.out, /all passed/);

  assert.equal(cli(['install', 'claude', 'codex'], dir).code, 0);
  assert.ok(fs.existsSync(path.join(dir, '.claude/settings.json')));
  assert.ok(fs.existsSync(path.join(dir, '.codex/rules/polyfence.rules')));
  assert.ok(!fs.existsSync(path.join(dir, '.gemini')));
  assert.match(cli(['doctor'], dir).out, /claude\s+hook installed \(project\)/);

  assert.equal(cli(['uninstall', 'claude', 'codex'], dir).code, 0);
  assert.ok(!fs.existsSync(path.join(dir, '.codex/rules/polyfence.rules')));
});

test('test: failing expectations exit 1', () => {
  const dir = project('extends: [recommended]\ntests:\n  - shell: git status\n    expect: deny\n');
  const r = cli(['test'], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /expected deny, got defer/);
});

test('compile prints native rules', () => {
  const dir = project('extends: [recommended]\n');
  assert.match(cli(['compile', 'codex'], dir).out, /prefix_rule/);
  assert.match(cli(['compile', 'gemini'], dir).out, /\[\[rule\]\]/);
});
