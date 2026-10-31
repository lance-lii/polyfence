import os from 'node:os';
import path from 'node:path';
import { commandLineRegex, commandRegex, isInside, matchList, pathMatches, resolvePath, urlRegex, type PathContext } from './patterns.js';
import { parseShell, segmentPaths, segmentUrls, segmentWrites } from './shell.js';
import type { AgentName, MatchSpec, Policy, Rule, ToolCall, ToolKind, Verdict } from './types.js';

const RANK = { allow: 1, ask: 2, deny: 3 } as const;

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const TEMP_ROOTS = [...new Set([os.tmpdir(), '/tmp', '/private/tmp', '/var/tmp'].map((p) => path.resolve(p)))];

function inferTools(m: MatchSpec): Array<ToolKind | 'any'> {
  if (m.command || m.commandLine) return ['shell'];
  if (m.url) return ['fetch', 'shell'];
  return ['any'];
}

export function ruleMatches(rule: Rule, call: ToolCall, ctx: PathContext): boolean {
  const m = rule.match;
  if (m.agent && !arr(m.agent).includes(call.agent as AgentName)) return false;
  const tools = m.tool ? arr(m.tool) : inferTools(m);
  if (!tools.includes('any') && !tools.includes(call.tool)) return false;
  if (m.rawTool && !matchList([call.rawTool], arr(m.rawTool), (v, p) => urlRegex(p).test(v))) return false;
  if (m.command) {
    const texts = call.segments.map((s) => s.text);
    if (!matchList(texts, arr(m.command), (v, p) => commandRegex(p).test(v))) return false;
  }
  if (m.commandLine) {
    if (!call.command || !matchList([call.command], arr(m.commandLine), (v, p) => commandLineRegex(p).test(v))) return false;
  }
  if (m.path && !matchList(call.paths, arr(m.path), (v, p) => pathMatches(v, p, ctx))) return false;
  if (m.writePath && !matchList(call.writes, arr(m.writePath), (v, p) => pathMatches(v, p, ctx))) return false;
  if (m.url && !matchList(call.urls, arr(m.url), (v, p) => urlRegex(p).test(v))) return false;
  if (m.outsideWorkspace !== undefined) {
    const root = path.resolve(ctx.root);
    const outside = call.writes.some((p) => {
      const abs = resolvePath(p, ctx);
      return !isInside(abs, root) && !TEMP_ROOTS.some((t) => isInside(abs, t));
    });
    if (outside !== m.outsideWorkspace) return false;
  }
  return true;
}

export function evaluate(policy: Policy, call: ToolCall): Verdict {
  const ctx: PathContext = { cwd: call.cwd, root: policy.root };
  const matched = policy.rules.filter((r) => ruleMatches(r, call, ctx));
  let winner: Rule | undefined;
  for (const r of matched) if (!winner || RANK[r.decision] > RANK[winner.decision]) winner = r;
  if (!winner) return { outcome: policy.default, matched };
  return { outcome: winner.decision, rule: winner, reason: winner.reason, matched };
}

// ---- ToolCall builders -------------------------------------------------------

interface Base {
  agent: ToolCall['agent'];
  rawTool: string;
  cwd: string;
}

export function shellCall(command: string, base: Base): ToolCall {
  const segments = parseShell(command);
  return {
    ...base,
    tool: 'shell',
    command,
    segments,
    paths: segments.flatMap(segmentPaths),
    writes: segments.flatMap(segmentWrites),
    urls: segments.flatMap(segmentUrls),
  };
}

export function fileCall(tool: ToolKind, paths: string[], base: Base): ToolCall {
  const clean = paths.filter((p) => typeof p === 'string' && p.length > 0);
  return {
    ...base,
    tool,
    segments: [],
    paths: clean,
    writes: tool === 'write' || tool === 'edit' ? clean : [],
    urls: [],
  };
}

export function fetchCall(urls: string[], base: Base): ToolCall {
  return { ...base, tool: 'fetch', segments: [], paths: [], writes: [], urls: urls.filter(Boolean) };
}

export function otherCall(tool: ToolKind, paths: string[], base: Base): ToolCall {
  return { ...base, tool, segments: [], paths, writes: [], urls: [] };
}

/** A short human-readable summary of a call, for logs and CLI output. */
export function describeCall(call: ToolCall): string {
  if (call.tool === 'shell') return call.command ?? '';
  if (call.tool === 'fetch') return call.urls.join(' ');
  if (call.paths.length) return call.paths.join(' ');
  return call.rawTool;
}
