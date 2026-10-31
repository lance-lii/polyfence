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

function cli(args: string[], cwd: string, input?: string) {
  const env = { ...process.env, NO_COLOR: '1', XDG_CONFIG_HOME: path.join(cwd, '.xdg') };
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

test('hook: broken policy fails closed, junk input is ignored', () => {
  const dir = project('rules: [ {match: {comand: x}} ]\n');
  const r = cli(['hook', 'claude'], dir, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: dir }));
  const out = JSON.parse(r.out).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /policy error/);

  const junk = cli(['hook', 'claude'], dir, 'not json');
  assert.equal(junk.code, 0);
  assert.equal(junk.out, '');
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
