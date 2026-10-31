import { evaluate, fetchCall, fileCall, shellCall } from './engine.js';
import type { Outcome, Policy, PolicyTest, ToolCall } from './types.js';

export interface TestResult {
  label: string;
  ok: boolean;
  expected: Outcome;
  actual: Outcome;
  ruleId?: string;
  problem?: string;
}

export function testCall(test: PolicyTest, policy: Policy): ToolCall {
  const base = { agent: test.agent ?? ('test' as const), cwd: policy.root };
  if (test.shell !== undefined) return shellCall(test.shell, { ...base, rawTool: 'Bash' });
  if (test.read !== undefined) return fileCall('read', [test.read], { ...base, rawTool: 'Read' });
  if (test.write !== undefined) return fileCall('write', [test.write], { ...base, rawTool: 'Write' });
  if (test.edit !== undefined) return fileCall('edit', [test.edit], { ...base, rawTool: 'Edit' });
  return fetchCall([test.fetch ?? ''], { ...base, rawTool: 'WebFetch' });
}

function label(test: PolicyTest): string {
  if (test.name) return test.name;
  for (const k of ['shell', 'read', 'write', 'edit', 'fetch'] as const) if (test[k] !== undefined) return `${k}: ${test[k]}`;
  return 'test';
}

export function runTests(policy: Policy): TestResult[] {
  return policy.tests.map((test) => {
    const verdict = evaluate(policy, testCall(test, policy));
    const result: TestResult = {
      label: label(test),
      ok: verdict.outcome === test.expect,
      expected: test.expect,
      actual: verdict.outcome,
      ruleId: verdict.rule?.id,
    };
    if (result.ok && test.rule && verdict.rule?.id !== test.rule) {
      result.ok = false;
      result.problem = `expected rule ${test.rule}, but ${verdict.rule?.id ?? 'no rule'} decided`;
    }
    return result;
  });
}
