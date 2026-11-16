import os from 'node:os';
import path from 'node:path';
import { CASE_INSENSITIVE, HOST, commandLineRegex, commandRegex, isInside, matchList, pathMatches, resolvePath, urlRegex, type PathContext } from './patterns.js';
import { parseScript, segmentPaths, segmentReads, segmentUrls, segmentWrites } from './shell.js';
import type { AgentName, MatchSpec, Policy, Rule, ToolCall, ToolKind, Verdict } from './types.js';

const RANK = { allow: 1, ask: 2, deny: 3 } as const;

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const TEMP_ROOTS = [...new Set([os.tmpdir(), '/tmp', '/private/tmp', '/var/tmp'].map((p) => path.resolve(p)))];

function inferTools(m: MatchSpec): Array<ToolKind | 'any'> {
  if (m.command || m.commandLine || m.script) return ['shell'];
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
    // Arguments that contain whitespace are free text here, so a flag pattern can't match a commit message.
    const patterns = arr(m.command);
    const positive = patterns.filter((p) => !p.startsWith('!'));
    const negative = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
    const excluded = (text: string) => negative.some((p) => commandRegex(p).test(text));
    // A positive pattern may also match a command the segment wraps (`op run -- git push -f`).
    // A negated pattern excludes the segment whether it matches the whole of it or that command.
    const hit = call.segments.some(
      (s) => !excluded(s.matchText) && [s.matchText, ...s.tails].some((text) => positive.some((p) => commandRegex(p).test(text)) && !excluded(text)),
    );
    if (!hit) return false;
  }
  if (m.commandLine) {
    // Where file names ignore case, `SUDO` and `CURL ... | SH` run sudo and sh: check the line in lower case too.
    const lines = call.command && CASE_INSENSITIVE ? [call.command, call.command.toLowerCase()] : [call.command ?? ''];
    if (!call.command || !matchList(lines, arr(m.commandLine), (v, p) => commandLineRegex(p).test(v))) return false;
  }
  if (m.script) {
    const scripts = CASE_INSENSITIVE ? [...call.scripts, ...call.scripts.map((s) => s.toLowerCase())] : call.scripts;
    if (!matchList(scripts, arr(m.script), (v, p) => commandLineRegex(p).test(v))) return false;
  }
  if (m.readPath && !matchList(call.reads, arr(m.readPath), (v, p) => pathMatches(v, p, ctx))) return false;
  if (m.path && !matchList(call.paths, arr(m.path), (v, p) => pathMatches(v, p, ctx))) return false;
  if (m.writePath && !matchList(call.writes, arr(m.writePath), (v, p) => pathMatches(v, p, ctx))) return false;
  if (m.url && !matchList(call.urls, arr(m.url), (v, p) => urlRegex(p).test(v))) return false;
  if (m.outsideWorkspace !== undefined) {
    const pf = ctx.platform ?? HOST;
    const root = pf.path.resolve(ctx.root);
    const outside = call.writes.some((p) => {
      const abs = resolvePath(p, ctx);
      return !isInside(abs, root, pf) && !TEMP_ROOTS.some((t) => isInside(abs, t, pf));
    });
    if (outside !== m.outsideWorkspace) return false;
  }
  return true;
}

export function evaluate(policy: Policy, call: ToolCall): Verdict {
  // With layered policies, each rule keeps the workspace root of the file it came from.
  const matched = policy.rules.filter((r) => ruleMatches(r, call, { cwd: call.cwd, root: r.root ?? policy.root }));
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

export function shellCall(command: string, base: Base, opts: { powershell?: boolean } = {}): ToolCall {
  const { segments, scripts } = parseScript(command, opts);
  // PowerShell accepts `\` in paths on every platform; path rules compare with `/`.
  const paths = (of: (s: (typeof segments)[number]) => string[]) => {
    const found = segments.flatMap(of);
    return opts.powershell ? found.map((p) => p.replace(/\\/g, '/')) : found;
  };
  return {
    ...base,
    tool: 'shell',
    command,
    segments,
    scripts,
    paths: paths(segmentPaths),
    reads: paths(segmentReads),
    writes: paths(segmentWrites),
    urls: segments.flatMap(segmentUrls),
  };
}

export function fileCall(tool: ToolKind, paths: string[], base: Base): ToolCall {
  const clean = paths.filter((p) => typeof p === 'string' && p.length > 0);
  return {
    ...base,
    tool,
    segments: [],
    scripts: [],
    paths: clean,
    // An edit has to match the text that is already there, so it reveals the file as a read does.
    reads: tool === 'read' || tool === 'edit' ? clean : [],
    writes: tool === 'write' || tool === 'edit' ? clean : [],
    urls: [],
  };
}

export function fetchCall(urls: string[], base: Base): ToolCall {
  return { ...base, tool: 'fetch', segments: [], scripts: [], paths: [], reads: [], writes: [], urls: urls.filter(Boolean) };
}

export function otherCall(tool: ToolKind, paths: string[], base: Base): ToolCall {
  // What an MCP or unknown tool does with a path isn't known: count it as a read.
  return { ...base, tool, segments: [], scripts: [], paths, reads: paths, writes: [], urls: [] };
}

/** A short human-readable summary of a call, for logs and CLI output. */
export function describeCall(call: ToolCall): string {
  if (call.tool === 'shell') return call.command ?? '';
  if (call.tool === 'fetch') return call.urls.join(' ');
  if (call.paths.length) return call.paths.join(' ');
  return call.rawTool;
}
