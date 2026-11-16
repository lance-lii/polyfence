import path from 'node:path';
import { ADAPTERS, detectAgent, type HookReply } from './adapters.js';
import { record, type AuditContext } from './audit.js';
import { evaluate } from './engine.js';
import { builtinPolicy, findPolicyFile, findProjectPolicyFile, isTrusted, layerPolicies, loadPolicy, loosens, tightenOnly, trustKey, userConfigDir, userPolicyFile } from './policy.js';
import type { AgentName, Outcome, Policy, ToolCall, Verdict } from './types.js';

/**
 * The policy file that owns `polyfence test` for `cwd`, exactly as written: the nearest project
 * policy, else the user-level one, else the built-in preset.
 */
export function ownPolicy(cwd: string): Policy {
  const file = findPolicyFile(cwd);
  if (!file) return builtinPolicy(cwd);
  const policy = loadPolicy(file);
  // A user-level policy has no project of its own: the workspace is wherever the agent runs.
  if (path.dirname(path.resolve(file)) === userConfigDir()) policy.root = cwd;
  return policy;
}

/**
 * The policy enforced for a tool call made in `cwd`, in a session that started in `projectDir`.
 *
 * Layers, each of which can only add restrictions: the user-level policy, the policy of the
 * session's project, and the policy nearest to `cwd` when that is a different file (a worktree,
 * a package with its own policy, or a directory the agent changed into). Without a project
 * policy the base is the user-level policy, or else the built-in preset.
 */
export function policyFor(cwd: string, projectDir = cwd): Policy {
  const project = (file: string): Policy => {
    const policy = loadPolicy(file);
    return loosens(policy) && !isTrusted(file) ? tightenOnly(policy) : policy;
  };
  const userFile = userPolicyFile();
  const projectFile = findProjectPolicyFile(projectDir);
  const nearFile = findProjectPolicyFile(cwd);

  const layers: Policy[] = [];
  if (userFile) layers.push({ ...loadPolicy(userFile), root: projectDir });
  if (projectFile) layers.push(project(projectFile));
  if (!layers.length) layers.push(builtinPolicy(projectDir));
  if (nearFile && (!projectFile || trustKey(nearFile) !== trustKey(projectFile))) layers.push(project(nearFile));
  // The session's project stays the primary layer; a policy found near `cwd` only adds rules.
  const primary = projectFile ? layers.findIndex((l) => l.source === path.resolve(projectFile)) : 0;
  return layerPolicies([...layers.filter((_, i) => i !== primary), layers[primary]]);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);

/** Who made the call, for the audit log. Field names differ per agent; absent ones are left out. */
function auditContext(input: Record<string, unknown>): AuditContext {
  return {
    session: str(input.session_id) ?? str(input.conversationId),
    agentId: str(input.agent_id),
    agentType: str(input.agent_type),
    toolUseId: str(input.tool_use_id),
    mode: str(input.permission_mode),
  };
}

export function runHook(stdin: string, agentArg?: AgentName): HookReply {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(stdin);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('not an object');
  } catch {
    // A payload we can't read is a tool call we can't check: block it rather than wave it through.
    const reason = 'hook input was not JSON, failing closed';
    if (!agentArg) return { exitCode: 2, stderr: `polyfence: ${reason}\n` };
    return ADAPTERS[agentArg].reply({ outcome: 'deny', reason, matched: [] }, builtinPolicy(process.cwd()));
  }
  const adapter = ADAPTERS[agentArg ?? detectAgent(input)];
  const workspace = adapter.workspace(input);

  let policy: Policy;
  try {
    policy = policyFor(workspace, adapter.project?.(input) ?? workspace);
  } catch (err) {
    const verdict: Verdict = { outcome: 'deny', reason: `policy error, failing closed: ${(err as Error).message}`, matched: [] };
    return adapter.reply(verdict, builtinPolicy(workspace));
  }

  let call: ToolCall | undefined;
  let verdict: Verdict;
  try {
    call = adapter.toCall(input);
    verdict = evaluate(policy, call);
  } catch (err) {
    if (policy.onError === 'allow') return { exitCode: 0, stderr: `polyfence: ${(err as Error).message}\n` };
    verdict = { outcome: 'deny', reason: `internal error, failing closed: ${(err as Error).message}`, matched: [] };
  }

  let sent: Outcome = verdict.outcome;
  if (sent === 'ask' && !adapter.nativeAsk) sent = policy.askFallback;
  if (sent === 'allow' && adapter.name === 'codex') sent = 'defer';
  if (call) record(policy, call, verdict, sent, auditContext(input));
  return adapter.reply(verdict, policy, call);
}
