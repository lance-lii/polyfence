import fs from 'node:fs';
import path from 'node:path';
import { describeCall } from './engine.js';
import { userConfigDir } from './policy.js';
import type { Outcome, Policy, ToolCall, Verdict } from './types.js';

export interface AuditEntry {
  ts: string;
  agent: string;
  tool: string;
  rawTool: string;
  summary: string;
  outcome: Outcome;
  sent: Outcome;
  rule?: string;
  cwd: string;
  /** Session or conversation id, when the agent sends one. */
  session?: string;
  /** Set when the call was made inside a subagent. */
  agentId?: string;
  agentType?: string;
  toolUseId?: string;
  /** The agent's permission mode, e.g. `bypassPermissions`. */
  mode?: string;
}

export type AuditContext = Pick<AuditEntry, 'session' | 'agentId' | 'agentType' | 'toolUseId' | 'mode'>;

const MAX_BYTES = 5 * 1024 * 1024;

const REDACTIONS: Array<[RegExp, string]> = [
  [/(authorization:\s*(?:bearer|basic|token)\s+)[^\s'"]+/gi, '$1[redacted]'],
  [/((?:api[_-]?key|access[_-]?key|token|secret|password|passwd|pwd)["']?\s*[=:]\s*["']?)[^\s'"&]+/gi, '$1[redacted]'],
  [/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g, '[redacted]'],
];

/** Commands often carry credentials (`curl -H "Authorization: ..."`); keep them out of the log. */
export function redact(text: string): string {
  return REDACTIONS.reduce((t, [re, to]) => t.replace(re, to), text);
}

export function auditFile(policy: Policy): string {
  if (!policy.source || path.dirname(policy.source) === userConfigDir()) return path.join(userConfigDir(), 'audit.jsonl');
  return path.join(path.dirname(policy.source), '.polyfence', 'audit.jsonl');
}

/** Best effort: auditing must never break a tool call. */
export function record(policy: Policy, call: ToolCall, verdict: Verdict, sent: Outcome, context: AuditContext = {}): void {
  if (policy.audit === 'off' || (policy.audit === 'matched' && verdict.outcome === 'defer')) return;
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    agent: call.agent,
    tool: call.tool,
    rawTool: call.rawTool,
    summary: redact(describeCall(call)).slice(0, 500),
    outcome: verdict.outcome,
    sent,
    rule: verdict.rule?.id,
    cwd: call.cwd,
    ...context,
  };
  try {
    const file = auditFile(policy);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Keep one previous file, so the log can't grow without bound.
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {
    // ignore
  }
}

export function readAudit(file: string): AuditEntry[] {
  if (!fs.existsSync(file)) return [];
  const out: AuditEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip corrupt lines
    }
  }
  return out;
}
