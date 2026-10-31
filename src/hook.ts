import path from 'node:path';
import { ADAPTERS, detectAgent, type HookReply } from './adapters.js';
import { record } from './audit.js';
import { evaluate } from './engine.js';
import { builtinPolicy, findPolicyFile, loadPolicy, userConfigDir } from './policy.js';
import type { AgentName, Outcome, Policy, Verdict } from './types.js';

/** Resolve the policy that governs a tool call made in `cwd`. */
export function policyFor(cwd: string): Policy {
  const file = findPolicyFile(cwd);
  if (!file) return builtinPolicy(cwd);
  const policy = loadPolicy(file);
  // A user-level policy has no project of its own: the workspace is wherever the agent runs.
  if (path.dirname(path.resolve(file)) === userConfigDir()) policy.root = cwd;
  return policy;
}

export function runHook(stdin: string, agentArg?: AgentName): HookReply {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(stdin);
    if (typeof input !== 'object' || input === null) throw new Error('not an object');
  } catch {
    return { exitCode: 0, stderr: 'polyfence: hook input was not JSON; ignoring\n' };
  }
  const adapter = ADAPTERS[agentArg ?? detectAgent(input)];
  const call = adapter.toCall(input);

  let policy: Policy;
  try {
    policy = policyFor(call.cwd);
  } catch (err) {
    const verdict: Verdict = { outcome: 'deny', reason: `policy error, failing closed: ${(err as Error).message}`, matched: [] };
    return adapter.reply(verdict, builtinPolicy(call.cwd), call);
  }

  let verdict: Verdict;
  try {
    verdict = evaluate(policy, call);
  } catch (err) {
    if (policy.onError === 'allow') return { exitCode: 0, stderr: `polyfence: ${(err as Error).message}\n` };
    verdict = { outcome: 'deny', reason: `internal error, failing closed: ${(err as Error).message}`, matched: [] };
  }

  let sent: Outcome = verdict.outcome;
  if (sent === 'ask' && !adapter.nativeAsk) sent = policy.askFallback;
  if (sent === 'allow' && adapter.name === 'codex') sent = 'defer';
  record(policy, call, verdict, sent);
  return adapter.reply(verdict, policy, call);
}
