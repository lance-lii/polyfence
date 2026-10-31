import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentFiles, install, isInstalled, uninstall } from '../src/install.js';
import { builtinPolicy } from '../src/policy.js';
import { AGENTS } from '../src/types.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'polyfence-'));
}

const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('install merges into existing Claude settings and is idempotent', () => {
  const root = tmp();
  const settings = path.join(root, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: './lint.sh' }] };
  fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] }, hooks: { PreToolUse: [other] } }));

  const opts = { scope: 'project' as const, root, command: 'polyfence hook', dryRun: false, policy: builtinPolicy(root) };
  install('claude', opts);
  const second = install('claude', opts);
  assert.equal(second[0].action, 'unchanged');

  const data = read(settings);
  assert.deepEqual(data.permissions, { allow: ['Bash(npm test:*)'] });
  assert.equal(data.hooks.PreToolUse.length, 2);
  assert.deepEqual(data.hooks.PreToolUse[0], other);
  assert.equal(data.hooks.PreToolUse[1].hooks[0].command, 'polyfence hook claude');
  assert.ok(isInstalled('claude', 'project', root));

  uninstall('claude', { scope: 'project', root, dryRun: false });
  const after = read(settings);
  assert.deepEqual(after.hooks.PreToolUse, [other]);
  assert.ok(!isInstalled('claude', 'project', root));
});

test('install wires every agent and writes native rules', () => {
  const root = tmp();
  const policy = builtinPolicy(root);
  for (const agent of AGENTS) install(agent, { scope: 'project', root, command: 'npx --no polyfence hook', dryRun: false, policy });

  assert.equal(read(path.join(root, '.codex/hooks.json')).hooks.PreToolUse[0].hooks[0].command, 'npx --no polyfence hook codex');
  assert.equal(read(path.join(root, '.gemini/settings.json')).hooks.BeforeTool[0].hooks[0].command, 'npx --no polyfence hook gemini');
  assert.ok(read(path.join(root, '.agents/hooks.json')).polyfence.PreToolUse.some((e: any) => e.matcher === 'run_command'));
  assert.match(fs.readFileSync(path.join(root, '.codex/rules/polyfence.rules'), 'utf8'), /prefix_rule\(/);
  assert.match(fs.readFileSync(path.join(root, '.gemini/policies/polyfence.toml'), 'utf8'), /\[\[rule\]\]/);
  for (const agent of AGENTS) assert.ok(isInstalled(agent, 'project', root), agent);

  for (const agent of AGENTS) uninstall(agent, { scope: 'project', root, dryRun: false });
  for (const agent of AGENTS) assert.ok(!isInstalled(agent, 'project', root), agent);
  assert.ok(!fs.existsSync(path.join(root, '.codex/rules/polyfence.rules')));
});

test('dry run writes nothing; invalid JSON is never overwritten', () => {
  const root = tmp();
  const policy = builtinPolicy(root);
  const changes = install('codex', { scope: 'project', root, command: 'polyfence hook', dryRun: true, policy });
  assert.ok(changes.every((c) => c.action === 'create'));
  assert.ok(!fs.existsSync(path.join(root, '.codex')));

  const settings = agentFiles('claude', 'project', root).hooks;
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, '{ "oops": ');
  assert.throws(() => install('claude', { scope: 'project', root, command: 'polyfence hook', dryRun: false, policy }), /refusing to overwrite/);
  assert.equal(fs.readFileSync(settings, 'utf8'), '{ "oops": ');
});
