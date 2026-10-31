/**
 * Agent adapters: turn each agent's pre-tool-use hook payload into a ToolCall,
 * and turn a Verdict back into the reply that agent expects.
 *
 *   Claude Code   PreToolUse  stdin {tool_name, tool_input, cwd}       stdout hookSpecificOutput.permissionDecision
 *   Codex CLI     PreToolUse  stdin {tool_name, tool_input, cwd, turn_id}  same shape as Claude (deny only)
 *   Gemini CLI    BeforeTool  stdin {tool_name, tool_input, cwd}       stdout {decision, reason}
 *   Antigravity   PreToolUse  stdin {toolCall: {name, args}, workspacePaths}  stdout {decision, reason}
 */
import { fetchCall, fileCall, otherCall, shellCall } from './engine.js';
import type { AgentName, Policy, ToolCall, ToolKind, Verdict } from './types.js';

type Json = Record<string, unknown>;

export interface HookReply {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}

export interface Adapter {
  name: AgentName;
  /** Can `ask` be expressed natively from a hook? */
  nativeAsk: boolean;
  toCall(input: Json): ToolCall;
  reply(verdict: Verdict, policy: Policy, call?: ToolCall): HookReply;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});

const PATH_KEYS = /^(file_?path|filePath|path|paths|filename|target_?file|TargetFile|absolute_?path|AbsolutePath|notebook_path|dir_?path|DirectoryPath|directory|SearchPath|FilePath|source|destination)$/i;

/** Pull path-ish string values out of an arbitrary tool input. */
function guessPaths(input: Json): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (!PATH_KEYS.test(k)) continue;
    if (typeof v === 'string' && v) out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x) out.push(x);
  }
  return out;
}

function message(verdict: Verdict): string {
  const id = verdict.rule ? `[${verdict.rule.id}]` : '';
  const reason = verdict.reason ?? (verdict.outcome === 'deny' ? 'blocked by policy' : 'needs approval');
  return `polyfence${id}: ${reason}`;
}

/** Outcome to send to an agent that cannot prompt from a hook. */
function degradeAsk(verdict: Verdict, policy: Policy): Verdict {
  if (verdict.outcome !== 'ask') return verdict;
  if (policy.askFallback === 'defer') return { ...verdict, outcome: 'defer' };
  return {
    ...verdict,
    outcome: 'deny',
    reason: `${verdict.reason ?? 'needs approval'} This needs human approval: stop and ask the user to run or approve it.`,
  };
}

// ---- Claude Code --------------------------------------------------------------

function claudeLikeCall(agent: AgentName, input: Json): ToolCall {
  const tool = str(input.tool_name) ?? 'unknown';
  const ti = obj(input.tool_input);
  const base = { agent, rawTool: tool, cwd: str(input.cwd) ?? process.cwd() };
  switch (tool) {
    case 'Bash':
    case 'BashOutput':
      return shellCall(str(ti.command) ?? '', base);
    case 'Read':
    case 'NotebookRead':
      return fileCall('read', [str(ti.file_path) ?? str(ti.notebook_path) ?? ''], base);
    case 'Write':
      return fileCall('write', [str(ti.file_path) ?? ''], base);
    case 'Edit':
    case 'MultiEdit':
      return fileCall('edit', [str(ti.file_path) ?? ''], base);
    case 'NotebookEdit':
      return fileCall('edit', [str(ti.notebook_path) ?? ''], base);
    case 'Glob':
    case 'Grep':
    case 'LS':
      return fileCall('read', [str(ti.path) ?? '', str(ti.pattern) && tool === 'Glob' ? (ti.pattern as string) : ''], base);
    case 'WebFetch':
      return fetchCall([str(ti.url) ?? ''], base);
    case 'WebSearch':
      return fetchCall([], base);
  }
  if (tool.startsWith('mcp__')) return otherCall('mcp', guessPaths(ti), base);
  return otherCall('other', guessPaths(ti), base);
}

function claudeReply(verdict: Verdict): HookReply {
  if (verdict.outcome === 'defer') return { exitCode: 0 };
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: verdict.outcome,
        permissionDecisionReason: message(verdict),
      },
    }),
  };
}

const claude: Adapter = {
  name: 'claude',
  nativeAsk: true,
  toCall: (input) => claudeLikeCall('claude', input),
  reply: (verdict) => claudeReply(verdict),
};

// ---- Codex CLI ----------------------------------------------------------------

function shellJoin(argv: unknown[]): string {
  return argv
    .map((a) => String(a))
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

/** File paths named in an apply_patch envelope. */
export function patchPaths(patch: string): { paths: string[]; onlyAdds: boolean } {
  const paths: string[] = [];
  let onlyAdds = true;
  for (const m of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    if (m[1] && m[1] !== 'Add') onlyAdds = false;
    paths.push((m[2] ?? m[3]).trim());
  }
  return { paths, onlyAdds };
}

function findPatch(v: unknown): string | undefined {
  if (typeof v === 'string') return v.includes('*** Begin Patch') ? v : undefined;
  if (Array.isArray(v)) {
    for (const x of v) {
      const p = findPatch(x);
      if (p) return p;
    }
    return undefined;
  }
  if (typeof v === 'object' && v !== null) {
    for (const x of Object.values(v)) {
      const p = findPatch(x);
      if (p) return p;
    }
  }
  return undefined;
}

function codexCall(input: Json): ToolCall {
  const tool = str(input.tool_name) ?? 'unknown';
  const ti = obj(input.tool_input);
  const base = { agent: 'codex' as const, rawTool: tool, cwd: str(input.cwd) ?? str(ti.workdir) ?? process.cwd() };
  const patch = findPatch(ti);
  if (tool === 'apply_patch' || patch) {
    const { paths, onlyAdds } = patchPaths(patch ?? '');
    return fileCall(onlyAdds && paths.length ? 'write' : 'edit', paths, base);
  }
  if (['Bash', 'shell', 'local_shell', 'exec_command', 'container.exec', 'unified_exec'].includes(tool) || ti.command !== undefined || ti.cmd !== undefined) {
    const cmd = ti.command ?? ti.cmd ?? ti.argv;
    const command = Array.isArray(cmd) ? shellJoin(cmd) : String(cmd ?? '');
    return shellCall(command, base);
  }
  if (tool.startsWith('mcp__')) return otherCall('mcp', guessPaths(ti), base);
  return claudeLikeCall('codex', input);
}

const codex: Adapter = {
  name: 'codex',
  nativeAsk: false,
  toCall: codexCall,
  reply: (verdict, policy) => {
    const v = degradeAsk(verdict, policy);
    // Codex hooks can deny; allow/ask are left to Codex's own approval flow and rules.
    return v.outcome === 'deny' ? claudeReply(v) : { exitCode: 0 };
  },
};

// ---- Gemini CLI ---------------------------------------------------------------

const GEMINI_TOOLS: Record<string, ToolKind> = {
  run_shell_command: 'shell',
  read_file: 'read',
  read_many_files: 'read',
  list_directory: 'read',
  glob: 'read',
  search_file_content: 'read',
  grep: 'read',
  write_file: 'write',
  replace: 'edit',
  edit: 'edit',
  web_fetch: 'fetch',
  google_web_search: 'fetch',
};

function geminiCall(input: Json): ToolCall {
  const tool = str(input.tool_name) ?? str(input.original_request_name) ?? 'unknown';
  const ti = obj(input.tool_input);
  const base = { agent: 'gemini' as const, rawTool: tool, cwd: str(input.cwd) ?? process.cwd() };
  const kind = GEMINI_TOOLS[tool];
  if (kind === 'shell') {
    const call = shellCall(str(ti.command) ?? '', base);
    const dir = str(ti.directory) ?? str(ti.dir_path);
    return dir ? { ...call, cwd: dir.startsWith('/') ? dir : `${base.cwd}/${dir}` } : call;
  }
  if (kind === 'fetch') {
    const urls = [str(ti.url), ...(str(ti.prompt)?.match(/https?:\/\/\S+/g) ?? [])].filter(Boolean) as string[];
    return fetchCall(urls, base);
  }
  if (kind) return fileCall(kind, guessPaths(ti), base);
  if (tool.startsWith('mcp_')) return otherCall('mcp', guessPaths(ti), base);
  return otherCall('other', guessPaths(ti), base);
}

const gemini: Adapter = {
  name: 'gemini',
  nativeAsk: false,
  toCall: geminiCall,
  reply: (verdict, policy) => {
    const v = degradeAsk(verdict, policy);
    if (v.outcome === 'deny') return { exitCode: 0, stdout: JSON.stringify({ decision: 'deny', reason: message(v) }) };
    if (v.outcome === 'allow') return { exitCode: 0, stdout: JSON.stringify({ decision: 'allow', reason: message(v) }) };
    return { exitCode: 0, stdout: '{}' };
  },
};

// ---- Antigravity CLI (experimental) ------------------------------------------

const AGY_TOOLS: Record<string, ToolKind> = {
  run_command: 'shell',
  view_file: 'read',
  view_file_outline: 'read',
  view_code_item: 'read',
  list_dir: 'read',
  find_by_name: 'read',
  grep_search: 'read',
  write_to_file: 'write',
  replace_file_content: 'edit',
  multi_replace_file_content: 'edit',
  read_url_content: 'fetch',
  search_web: 'fetch',
};

function agyCall(input: Json): ToolCall {
  const tc = obj(input.toolCall);
  const tool = str(tc.name) ?? str(input.tool_name) ?? 'unknown';
  const args = obj(tc.args ?? input.tool_input);
  const workspaces = Array.isArray(input.workspacePaths) ? input.workspacePaths : [];
  const cwd = str(args.Cwd) ?? str(workspaces[0]) ?? str(input.cwd) ?? process.cwd();
  const base = { agent: 'antigravity' as const, rawTool: tool, cwd };
  const kind = AGY_TOOLS[tool];
  if (kind === 'shell') return shellCall(str(args.CommandLine) ?? str(args.command) ?? '', base);
  if (kind === 'fetch') return fetchCall([str(args.Url) ?? str(args.url) ?? ''], base);
  if (kind) return fileCall(kind, guessPaths(args), base);
  if (tool.startsWith('mcp')) return otherCall('mcp', guessPaths(args), base);
  return otherCall('other', guessPaths(args), base);
}

const antigravity: Adapter = {
  name: 'antigravity',
  nativeAsk: true,
  toCall: agyCall,
  reply: (verdict, _policy, call) => {
    // Antigravity fails closed on a missing decision, so always answer. For `defer`
    // we mirror its defaults: review shell commands and writes, let reads through.
    // `force_ask` bypasses the "always allow" cache.
    const neutral = call && (call.tool === 'read' || call.tool === 'fetch') ? 'allow' : 'ask';
    const decision = { deny: 'deny', ask: 'force_ask', allow: 'allow', defer: neutral }[verdict.outcome];
    const reply: Json = { decision };
    if (verdict.outcome !== 'defer') reply.reason = message(verdict);
    return { exitCode: 0, stdout: JSON.stringify(reply) };
  },
};

export const ADAPTERS: Record<AgentName, Adapter> = { claude, codex, gemini, antigravity };

/** Best-effort guess at which agent produced a hook payload. */
export function detectAgent(input: Json): AgentName {
  if (input.toolCall !== undefined || input.workspacePaths !== undefined) return 'antigravity';
  if (input.hook_event_name === 'BeforeTool' || (typeof input.tool_name === 'string' && GEMINI_TOOLS[input.tool_name])) return 'gemini';
  if (input.turn_id !== undefined || input.tool_name === 'apply_patch') return 'codex';
  return 'claude';
}
