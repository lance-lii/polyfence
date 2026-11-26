import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluate, shellCall } from '../src/engine.js';
import { ownPolicy, policyFor } from '../src/hook.js';
import { isTrusted, loadPolicy, PolicyError, setTrust, userConfigDir } from '../src/policy.js';
import type { Outcome, Policy } from '../src/types.js';

// The user-level policy and trusted.json live under XDG_CONFIG_HOME: keep the real ones out of it.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'polyfence-hook-'));
process.env.XDG_CONFIG_HOME = path.join(sandbox, '.xdg');

function project(policy?: string): string {
  const dir = fs.mkdtempSync(path.join(sandbox, 'project-'));
  if (policy !== undefined) fs.writeFileSync(path.join(dir, 'polyfence.yaml'), policy);
  return dir;
}

const deny = (id: string, command: string) => `  - id: ${id}\n    match: { command: "${command}" }\n    decision: deny\n`;
const run = (policy: Policy, command: string): Outcome =>
  evaluate(policy, shellCall(command, { agent: 'claude', rawTool: 'Bash', cwd: policy.root })).outcome;

test('policyFor reuses its policy until a file it was built from changes', () => {
  const dir = project('extends: [recommended]\n');
  const first = policyFor(dir);
  assert.equal(policyFor(dir), first);
  assert.deepEqual([first.source, first.root, first.default, first.untrusted], [path.join(dir, 'polyfence.yaml'), dir, 'defer', undefined]);
  assert.throws(() => Object.assign(first, { root: sandbox }), TypeError);
  assert.equal(run(first, 'make deploy'), 'defer');

  fs.writeFileSync(path.join(dir, 'polyfence.yaml'), `extends: [recommended]\nrules:\n${deny('no-deploy', 'make deploy *')}`);
  const edited = policyFor(dir);
  assert.equal(run(edited, 'make deploy'), 'deny');
  assert.equal(policyFor(dir), edited);
});

test('policyFor falls back once a policy file is deleted', () => {
  const dir = project(`extends: [recommended]\nrules:\n${deny('no-deploy', 'make deploy *')}`);
  const pkg = path.join(dir, 'pkg');
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, 'polyfence.yaml'), `rules:\n${deny('no-seed', 'make seed *')}`);
  assert.equal(run(policyFor(pkg, dir), 'make seed'), 'deny');

  fs.rmSync(path.join(pkg, 'polyfence.yaml'));
  const projectOnly = policyFor(pkg, dir);
  assert.equal(run(projectOnly, 'make seed'), 'defer');
  assert.equal(run(projectOnly, 'make deploy'), 'deny');

  fs.rmSync(path.join(dir, 'polyfence.yaml'));
  const builtin = policyFor(pkg, dir);
  assert.deepEqual([builtin.source, builtin.root], [undefined, dir]);
  assert.equal(policyFor(pkg).root, pkg);
  assert.equal(run(builtin, 'make deploy'), 'defer');
  assert.equal(run(builtin, 'git push --force'), 'deny');
});

test('policyFor sees a policy created nearer to the working directory', () => {
  const dir = project('extends: [recommended]\n');
  const api = path.join(dir, 'packages', 'api');
  fs.mkdirSync(api, { recursive: true });
  assert.equal(run(policyFor(api, dir), 'make seed'), 'defer');
  assert.equal(run(policyFor(api), 'make seed'), 'defer');

  fs.writeFileSync(path.join(api, 'polyfence.yaml'), `extends: [recommended]\nrules:\n${deny('no-seed', 'make seed *')}`);
  assert.equal(run(policyFor(api, dir), 'make seed'), 'deny');
  assert.equal(run(policyFor(api), 'make seed'), 'deny');
});

test('trusting, revoking and editing trusted.json or the policy take effect on the next call', () => {
  const dir = project('extends: [recommended]\ndefault: allow\nrules:\n  - id: yes-to-curl\n    match: { command: "curl *" }\n    decision: allow\n');
  const file = path.join(dir, 'polyfence.yaml');
  const curl = () => run(policyFor(dir), 'curl https://x.dev');
  assert.equal(curl(), 'defer');
  assert.deepEqual(policyFor(dir).untrusted, [file]);

  setTrust(file);
  assert.ok(isTrusted(file));
  assert.equal(curl(), 'allow');
  assert.equal(policyFor(dir).untrusted, undefined);
  setTrust(file, true);
  assert.ok(!isTrusted(file));
  assert.equal(curl(), 'defer');

  const store = path.join(userConfigDir(), 'trusted.json');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(store, JSON.stringify({ [fs.realpathSync(file)]: hash }));
  assert.equal(curl(), 'allow');
  // The same size again, with a hash that no longer matches.
  fs.writeFileSync(store, JSON.stringify({ [fs.realpathSync(file)]: (hash[0] === '0' ? '1' : '0') + hash.slice(1) }));
  assert.equal(curl(), 'defer');

  setTrust(file);
  assert.equal(curl(), 'allow');
  fs.appendFileSync(file, '# changed\n');
  assert.equal(curl(), 'defer');
});

test('a broken policy fails every time until it is fixed', () => {
  const dir = project('rules: [ {match: {comand: x}} ]\n');
  assert.throws(() => policyFor(dir), PolicyError);
  assert.throws(() => policyFor(dir), PolicyError);
  fs.writeFileSync(path.join(dir, 'polyfence.yaml'), 'extends: [recommended]\n');
  assert.equal(run(policyFor(dir), 'git push --force'), 'deny');
});

test('ownPolicy roots a user-level policy at each cwd without changing the shared one', () => {
  const userFile = path.join(userConfigDir(), 'polyfence.yaml');
  fs.mkdirSync(userConfigDir(), { recursive: true });
  fs.writeFileSync(userFile, 'extends: [strict]\n');
  try {
    const [a, b] = [project(), project()];
    const shared = loadPolicy(userFile);
    assert.equal(ownPolicy(a).root, a);
    assert.equal(ownPolicy(b).root, b);
    assert.equal(ownPolicy(a).root, a);
    assert.equal(shared.root, process.cwd());
    assert.equal(loadPolicy(userFile), shared);
    assert.deepEqual({ ...ownPolicy(b), root: shared.root }, shared);
    assert.equal(policyFor(a).root, a);
    assert.equal(policyFor(b).root, b);
    assert.equal(loadPolicy(userFile).root, process.cwd());
    // Loaded directly, it is rooted at the current directory, even after a chdir.
    const cwd = process.cwd();
    process.chdir(a);
    try {
      assert.equal(loadPolicy(userFile).root, process.cwd());
    } finally {
      process.chdir(cwd);
    }
  } finally {
    fs.rmSync(userFile);
  }
});
