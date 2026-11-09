import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, fileCall, shellCall } from '../src/engine.js';
import { buildPolicy } from '../src/policy.js';

const ROOT = '/work/app';
const base = { agent: 'claude' as const, rawTool: 'Bash', cwd: ROOT };

test('the most restrictive matching rule wins, whatever the rule order', () => {
  const rules = [
    { id: 'allow-git', match: { command: 'git *' }, decision: 'allow' },
    { id: 'ask-push', match: { command: 'git push *' }, decision: 'ask' },
    { id: 'deny-force', match: { command: 'git push --force *' }, decision: 'deny' },
  ];
  for (const order of [rules, [...rules].reverse()]) {
    const p = buildPolicy({ rules: order }, { root: ROOT });
    const v = (command: string) => evaluate(p, shellCall(command, base));
    assert.equal(v('git push --force origin').rule?.id, 'deny-force');
    assert.equal(v('git push --force origin').matched.length, 3);
    assert.equal(v('git status && git push --force').outcome, 'deny', 'one segment is enough');
    assert.equal(v('git push origin').outcome, 'ask');
    assert.equal(v('git status').outcome, 'allow');
    assert.equal(v('ls').outcome, 'defer');
  }
});

test('default applies only when no rule matches', () => {
  const p = buildPolicy({ default: 'ask', rules: [{ id: 'tests', match: { command: 'npm test *' }, decision: 'allow' }] }, { root: ROOT });
  assert.equal(evaluate(p, shellCall('npm test -- --watch', base)).outcome, 'allow');
  const other = evaluate(p, shellCall('make', base));
  assert.equal(other.outcome, 'ask');
  assert.equal(other.rule, undefined);
});

test('match keys are ANDed: agent and tool narrow a path rule', () => {
  const p = buildPolicy({ rules: [{ id: 'codex-src', match: { agent: 'codex', tool: ['write', 'edit'], path: 'src/**' }, decision: 'ask' }] }, { root: ROOT });
  const call = (tool: 'read' | 'write', agent: 'claude' | 'codex', file = `${ROOT}/src/a.ts`) =>
    evaluate(p, fileCall(tool, [file], { ...base, agent, rawTool: tool })).outcome;
  assert.equal(call('write', 'codex'), 'ask');
  assert.equal(call('write', 'claude'), 'defer');
  assert.equal(call('read', 'codex'), 'defer');
  assert.equal(call('write', 'codex', `${ROOT}/docs/a.md`), 'defer');
});
