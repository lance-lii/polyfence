export type Decision = 'allow' | 'ask' | 'deny';
/** `defer` means "polyfence has no opinion": the agent's normal permission flow runs. */
export type Outcome = Decision | 'defer';

export type AgentName = 'claude' | 'codex' | 'gemini' | 'antigravity';
export const AGENTS: AgentName[] = ['claude', 'codex', 'gemini', 'antigravity'];

/** Agent-neutral tool categories that rules match against. */
export type ToolKind = 'shell' | 'read' | 'write' | 'edit' | 'fetch' | 'mcp' | 'other';
export const TOOL_KINDS: ToolKind[] = ['shell', 'read', 'write', 'edit', 'fetch', 'mcp', 'other'];

export interface Segment {
  /** argv after stripping wrappers (sudo, env, VAR=1, timeout, ...) and git global options. */
  argv: string[];
  /** argv exactly as parsed. */
  rawArgv: string[];
  /** Targets of output redirects (`>`, `>>`, `&>`, `2>`, `<>`, ...). */
  redirects: string[];
  /** Targets of input redirects (`<`). Kept out of writes but still in paths. */
  inputRedirects: string[];
  /** argv joined by single spaces; shown by `check --explain`. */
  text: string;
  /**
   * What `command` patterns match: `text`, with every argument that contains whitespace (a quoted
   * commit message, a SQL string, an inline script) replaced by `<text>`. Flags are never hidden
   * this way: a program receives such an argument as one word, so it cannot be a flag.
   */
  matchText: string;
  /**
   * Commands the segment may be wrapping, in the same form as `matchText`: the words from each
   * later argument on, as in `op run -- git push -f` or `docker exec app rm -rf /`.
   */
  tails: string[];
}

/** A tool call normalized from any agent's hook payload. */
export interface ToolCall {
  agent: AgentName | 'test';
  tool: ToolKind;
  /** The agent's own tool name, e.g. `Bash`, `run_shell_command`, `apply_patch`. */
  rawTool: string;
  /** Full shell command, for shell calls. */
  command?: string;
  segments: Segment[];
  /** Every path the call touches (reads or writes). */
  paths: string[];
  /** Paths whose contents the call can read. */
  reads: string[];
  /** Paths the call modifies. */
  writes: string[];
  /** Shell code the call runs, at every nesting level, with quoted text and heredoc data blanked. */
  scripts: string[];
  urls: string[];
  cwd: string;
}

export interface MatchSpec {
  tool?: ToolKind | 'any' | Array<ToolKind | 'any'>;
  rawTool?: string | string[];
  agent?: AgentName | AgentName[];
  command?: string | string[];
  commandLine?: string | string[];
  script?: string | string[];
  path?: string | string[];
  readPath?: string | string[];
  writePath?: string | string[];
  url?: string | string[];
  outsideWorkspace?: boolean;
}

export interface Rule {
  id: string;
  match: MatchSpec;
  decision: Decision;
  reason?: string;
  /** Name of the preset the rule came from, if any. */
  preset?: string;
  /** Workspace root of the policy file the rule came from, when policies are layered. */
  root?: string;
}

export interface PolicyTest {
  name?: string;
  shell?: string;
  read?: string;
  write?: string;
  edit?: string;
  fetch?: string;
  tool?: string;
  agent?: AgentName;
  expect: Outcome;
  rule?: string;
}

export interface Policy {
  version: 1;
  extends: string[];
  disable: string[];
  default: Outcome;
  /** What to do with `ask` on agents whose hooks can't prompt the user. */
  askFallback: 'deny' | 'defer';
  audit: 'matched' | 'all' | 'off';
  onError: 'deny' | 'allow';
  rules: Rule[];
  tests: PolicyTest[];
  /** Absolute path of the file the policy was loaded from (undefined for built-ins). */
  source?: string;
  /** Directory treated as the workspace root. */
  root: string;
  /** Project policy files whose `allow` settings were ignored because the file is not trusted. */
  untrusted?: string[];
}

export interface Verdict {
  outcome: Outcome;
  rule?: Rule;
  reason?: string;
  matched: Rule[];
}
