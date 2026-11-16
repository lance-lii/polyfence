import path from 'node:path';
import { ADAPTERS, detectAgent, type HookReply } from './adapters.js';
import { record, type AuditContext } from './audit.js';
import { evaluate } from './engine.js';
import { builtinPolicy, dropsBuiltins, findPolicyFile, findProjectPolicyFile, isTrusted, layerPolicies, loadPolicy, loosens, tightenOnly, trustKey, userConfigDir, userPolicyFile } from './policy.js';
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
 * Layers, each of which can only add restrictions:
 *   1. the base: the user-level policy, or without one the built-in preset. The preset steps
 *      aside for a project policy that is trusted or that keeps all of its rules;
 *   2. the policy of the session's project;
 *   3. the policy nearest to `cwd` when that is a different file (a worktree, a package with
 *      its own policy, or a directory the agent changed into).
 * A project file that isn't trusted has everything that loosens it ignored.
 */
export function policyFor(cwd: string, projectDir = cwd): Policy {
  const userFile = userPolicyFile();
  const projectFile = findProjectPolicyFile(projectDir);
  const nearFile = findProjectPolicyFile(cwd);
  const isNear = nearFile && (!projectFile || trustKey(nearFile) !== trustKey(projectFile));

  const load = (file: string, standsAlone: boolean): Policy => {
    const policy = loadPolicy(file);
    const loosening = loosens(policy) || (standsAlone && dropsBuiltins(policy));
    return loosening && !isTrusted(file) ? tightenOnly(policy) : policy;
  };
  const project = projectFile ? load(projectFile, !userFile) : undefined;
  const near = isNear ? load(nearFile, false) : undefined;

  let base: Policy | undefined;
  if (userFile) base = { ...loadPolicy(userFile), root: project?.root ?? projectDir };
  else if (!project || project.untrusted?.length) base = builtinPolicy(project?.root ?? projectDir);

  // The session's project is the primary layer: it names the workspace, the audit log and the tests.
  const primary = project ?? base!;
  return layerPolicies([base, near, project].filter((l): l is Policy => l !== undefined && l !== primary).concat(primary));
}

/** Hook events that carry a tool call: Claude Code, Codex and Antigravity `PreToolUse`, Gemini `BeforeTool`. */
const TOOL_EVENTS = new Set(['PreToolUse', 'BeforeTool']);

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
  // Only tool-call events are checked. Any other event an agent sends (session start, stop,
  // subagent start...) carries nothing to judge, so it gets a neutral reply instead of a verdict.
  const event = str(input.hook_event_name);
  if (event && !TOOL_EVENTS.has(event)) return { exitCode: 0 };

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
