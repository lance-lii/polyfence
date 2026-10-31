import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicy, PolicyError } from '../src/policy.js';
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
