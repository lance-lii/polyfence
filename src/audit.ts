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
}

export function auditFile(policy: Policy): string {
  if (!policy.source || path.dirname(policy.source) === userConfigDir()) return path.join(userConfigDir(), 'audit.jsonl');
  return path.join(path.dirname(policy.source), '.polyfence', 'audit.jsonl');
}

/** Best effort: auditing must never break a tool call. */
export function record(policy: Policy, call: ToolCall, verdict: Verdict, sent: Outcome): void {
  if (policy.audit === 'off' || (policy.audit === 'matched' && verdict.outcome === 'defer')) return;
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    agent: call.agent,
    tool: call.tool,
    rawTool: call.rawTool,
    summary: describeCall(call).slice(0, 500),
    outcome: verdict.outcome,
    sent,
    rule: verdict.rule?.id,
    cwd: call.cwd,
  };
  try {
    const file = auditFile(policy);
    fs.mkdirSync(path.dirname(file), { recursive: true });
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
