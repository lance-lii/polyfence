import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPolicy, loadPolicy, PolicyError } from '../src/policy.js';
import { PRESETS } from '../src/presets.js';
import { runTests } from '../src/testing.js';
import { INIT_TEMPLATE } from '../src/template.js';
import { parse as parseYaml } from 'yaml';

const build = (data: unknown) => buildPolicy(data, { root: '/r' });

test('extends, disable and override', () => {
  const p = build({
    extends: ['recommended'],
    disable: ['ask-sudo'],
    rules: [{ id: 'no-force-push', match: { command: 'git push -f *' }, decision: 'ask' }],
  });
  assert.ok(!p.rules.some((r) => r.id === 'ask-sudo'));
  const override = p.rules.filter((r) => r.id === 'no-force-push');
  assert.equal(override.length, 1);
  assert.equal(override[0].decision, 'ask');
  assert.equal(override[0].preset, undefined);
  assert.equal(p.rules.length, PRESETS.recommended.length - 1);
});

test('defaults', () => {
  const p = build({});
  assert.equal(p.default, 'defer');
  assert.equal(p.askFallback, 'deny');
  assert.equal(p.audit, 'matched');
  assert.equal(p.onError, 'deny');
  assert.deepEqual(p.rules, []);
});

const bad: Array<[string, unknown, RegExp]> = [
  ['unknown preset', { extends: ['nope'] }, /unknown preset "nope"/],
  ['unknown match key', { rules: [{ match: { comand: 'x' } }] }, /unknown key "comand"/],
  ['empty match', { rules: [{ match: {} }] }, /match is empty/],
  ['bad decision', { rules: [{ match: { command: 'x' }, decision: 'block' }] }, /decision must be one of/],
  ['bad regex', { rules: [{ match: { command: '/(/' } }] }, /bad regex/],
  ['bad path regex', { rules: [{ match: { path: '/(/' } }] }, /bad regex/],
  ['bad tool', { rules: [{ match: { tool: 'bash' } }] }, /unknown tool "bash"/],
  ['duplicate ids', { rules: [{ id: 'a', match: { command: 'x' } }, { id: 'a', match: { command: 'y' } }] }, /duplicate rule id/],
  ['disable unknown', { extends: ['recommended'], disable: ['nope'] }, /disable: "nope"/],
  ['test without kind', { tests: [{ expect: 'deny' }] }, /exactly one of/],
  ['test without expect', { tests: [{ shell: 'ls' }] }, /expect is required/],
  ['version', { version: 2 }, /version: 1/],
];

for (const [name, data, message] of bad) {
  test(`rejects: ${name}`, () => {
    assert.throws(() => build(data), (err: unknown) => err instanceof PolicyError && message.test(err.message));
  });
}

test('absolute path globs are not read as regexes', () => {
  const p = build({
    rules: [
      { id: 'hosts', match: { writePath: '/etc/hosts' }, decision: 'deny' },
      { id: 'etc', match: { path: ['/etc/'] }, decision: 'ask' },
      { id: 'env-re', match: { path: '/\\.env$/' }, decision: 'deny' },
    ],
    tests: [
      { write: '/etc/hosts', expect: 'deny', rule: 'hosts' },
      { read: '/etc/passwd', expect: 'ask', rule: 'etc' },
      { read: 'src/fetch.ts', expect: 'defer' },
      { read: '.env', expect: 'deny', rule: 'env-re' },
    ],
  });
  for (const r of runTests(p)) assert.ok(r.ok, `${r.label}: expected ${r.expected}, got ${r.actual} (${r.ruleId ?? 'no rule'})`);
});

test('rule ids default to their position', () => {
  const p = build({ rules: [{ match: { command: 'x' } }] });
  assert.equal(p.rules[0].id, 'rule-1');
  assert.equal(p.rules[0].decision, 'deny');
});

test('policy tests report rule mismatches', () => {
  const p = build({
    extends: ['recommended'],
    tests: [
      { shell: 'git push -f', expect: 'deny', rule: 'no-force-push' },
      { shell: 'git push -f', expect: 'deny', rule: 'something-else' },
      { read: '.env', expect: 'defer' },
    ],
  });
  const [ok, wrongRule, wrongOutcome] = runTests(p);
  assert.ok(ok.ok);
  assert.ok(!wrongRule.ok);
  assert.match(wrongRule.problem!, /expected rule something-else/);
  assert.ok(!wrongOutcome.ok);
  assert.equal(wrongOutcome.actual, 'deny');
});

test('the init template is a valid policy whose tests pass', () => {
  const p = build(parseYaml(INIT_TEMPLATE));
  const results = runTests(p);
  assert.ok(results.length >= 5);
  for (const r of results) assert.ok(r.ok, `${r.label}: expected ${r.expected}, got ${r.actual}`);
});

function policyFile(text: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'polyfence-policy-')), 'polyfence.yaml');
  fs.writeFileSync(file, text);
  return file;
}

test('loading an unchanged file again returns the same policy, frozen', () => {
  const file = policyFile('extends: [recommended]\naudit: all\nrules:\n  - id: no-deploy\n    match: { command: "make deploy *" }\n');
  const first = loadPolicy(file);
  assert.equal(loadPolicy(file), first);
  assert.deepEqual(loadPolicy(file), buildPolicy(parseYaml(fs.readFileSync(file, 'utf8')), { source: file, root: path.dirname(file) }));
  assert.throws(() => first.rules.push(first.rules[0]), TypeError);
  assert.throws(() => Object.assign(first.rules[0].match, { command: 'x' }), TypeError);
});

test('loadPolicy sees every rewrite, including one of the same size made right away', () => {
  const file = policyFile('default: defer\n');
  assert.equal(loadPolicy(file).default, 'defer');
  // Same size and, on most filesystems, the same timestamps as the first write.
  fs.writeFileSync(file, 'default: allow\n');
  assert.equal(loadPolicy(file).default, 'allow');
  fs.writeFileSync(file, 'rules:\n  - id: no-deploy\n    match: { command: "make deploy *" }\n');
  assert.deepEqual(loadPolicy(file).rules.map((r) => r.id), ['no-deploy']);
  fs.rmSync(file);
  assert.throws(() => loadPolicy(file), (err: unknown) => err instanceof PolicyError && /cannot read policy: ENOENT/.test(err.message));
});

test('a file whose timestamps have settled is only read again once its stat changes', (t) => {
  const file = policyFile('default: defer\n');
  const first = loadPolicy(file);
  const later = Date.now() + 60_000;
  t.mock.method(Date, 'now', () => later);
  const reads = t.mock.method(fs, 'readFileSync');
  // Written just now, so its bytes are compared once more; after that the stat is enough.
  assert.equal(loadPolicy(file), first);
  assert.equal(loadPolicy(file), first);
  assert.equal(reads.mock.callCount(), 1);

  const replacement = file + '.new';
  fs.writeFileSync(replacement, 'default: allow\n');
  fs.renameSync(replacement, file);
  assert.equal(loadPolicy(file).default, 'allow', 'same size, another inode');
  fs.writeFileSync(file, 'default: defer\n');
  fs.utimesSync(file, new Date(2001, 0, 1), new Date(2001, 0, 1));
  assert.equal(loadPolicy(file).default, 'defer', 'same size and inode, another mtime');
  fs.writeFileSync(file, 'default: deny\n');
  assert.equal(loadPolicy(file).default, 'deny', 'another size');
});
