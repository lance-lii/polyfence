/**
 * Wire the polyfence hook into each agent's config, and write compiled native
 * rules next to it. Existing settings are merged, never replaced.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileCodex, compileGemini } from './compile.js';
import type { AgentName, Policy } from './types.js';

export type Scope = 'project' | 'user';

export interface Change {
  agent: AgentName;
  file: string;
  action: 'create' | 'update' | 'remove' | 'unchanged';
  note?: string;
}

type Json = Record<string, any>;

/** Matches `polyfence hook claude`, `npx --no polyfence hook codex`, `node /x/polyfence/dist/src/cli.js hook gemini`... */
const MARKER = /polyfence\S*(?:\s.*)?\shook(?:\s|$)|polyfence hook/;
const AGY_TOOLS = ['run_command', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'view_file', 'read_url_content'];

function base(scope: Scope, root: string): string {
  return scope === 'user' ? os.homedir() : root;
}

export function agentFiles(agent: AgentName, scope: Scope, root: string): { hooks: string; rules?: string } {
  const b = base(scope, root);
  switch (agent) {
    case 'claude':
      return { hooks: path.join(b, '.claude', 'settings.json') };
    case 'codex':
      return { hooks: path.join(b, '.codex', 'hooks.json'), rules: path.join(b, '.codex', 'rules', 'polyfence.rules') };
    case 'gemini':
      return { hooks: path.join(b, '.gemini', 'settings.json'), rules: path.join(b, '.gemini', 'policies', 'polyfence.toml') };
    case 'antigravity':
      return { hooks: scope === 'user' ? path.join(b, '.gemini', 'config', 'hooks.json') : path.join(b, '.agents', 'hooks.json') };
  }
}

function readJson(file: string): Json {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    const data = JSON.parse(text);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('not a JSON object');
    return data;
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}); refusing to overwrite it`);
  }
}

const isOurs = (entry: Json) => Array.isArray(entry?.hooks) && entry.hooks.some((h: Json) => MARKER.test(String(h?.command ?? '')));

function hookEntries(agent: AgentName, command: string): { event: string; entries: Json[] } {
  const cmd = `${command} ${agent}`;
  switch (agent) {
    case 'claude':
      return { event: 'PreToolUse', entries: [{ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 10 }] }] };
    case 'codex':
      return { event: 'PreToolUse', entries: [{ matcher: '.*', hooks: [{ type: 'command', command: cmd, timeout: 10 }] }] };
    case 'gemini':
      return {
        event: 'BeforeTool',
        entries: [{ matcher: '.*', hooks: [{ type: 'command', name: 'polyfence', command: cmd, timeout: 10000, description: 'polyfence guardrails' }] }],
      };
    case 'antigravity':
      return { event: 'PreToolUse', entries: AGY_TOOLS.map((t) => ({ matcher: t, hooks: [{ type: 'command', command: cmd }] })) };
  }
}

function writeFile(file: string, content: string, dryRun: boolean): Change['action'] {
  const exists = fs.existsSync(file);
  if (exists && fs.readFileSync(file, 'utf8') === content) return 'unchanged';
  if (!dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return exists ? 'update' : 'create';
}

const stringify = (data: Json) => JSON.stringify(data, null, 2) + '\n';

export interface InstallOptions {
  scope: Scope;
  root: string;
  /** Command prefix that runs polyfence, e.g. `polyfence hook` or `npx --no polyfence hook`. */
  command: string;
  dryRun: boolean;
  policy: Policy;
}

export function install(agent: AgentName, opts: InstallOptions): Change[] {
  const files = agentFiles(agent, opts.scope, opts.root);
  const changes: Change[] = [];
  const data = readJson(files.hooks);
  const { event, entries } = hookEntries(agent, opts.command);

  if (agent === 'antigravity') {
    data.polyfence = { [event]: entries };
  } else {
    data.hooks ??= {};
    const existing: Json[] = Array.isArray(data.hooks[event]) ? data.hooks[event] : [];
    data.hooks[event] = [...existing.filter((e) => !isOurs(e)), ...entries];
  }
  changes.push({ agent, file: files.hooks, action: writeFile(files.hooks, stringify(data), opts.dryRun) });

  if (files.rules) {
    const compiled = agent === 'codex' ? compileCodex(opts.policy) : compileGemini(opts.policy);
    const note =
      agent === 'gemini' && opts.scope === 'project'
        ? 'Gemini ignores workspace policies today; use --scope user to activate the static layer'
        : agent === 'codex' && opts.scope === 'project'
          ? 'Codex loads project rules and hooks only for trusted projects'
          : undefined;
    changes.push({ agent, file: files.rules, action: writeFile(files.rules, compiled, opts.dryRun), note });
  }
  return changes;
}

export function uninstall(agent: AgentName, opts: Omit<InstallOptions, 'command' | 'policy'>): Change[] {
  const files = agentFiles(agent, opts.scope, opts.root);
  const changes: Change[] = [];
  if (fs.existsSync(files.hooks)) {
    const data = readJson(files.hooks);
    let touched = false;
    if (agent === 'antigravity') {
      touched = 'polyfence' in data;
      delete data.polyfence;
    } else if (data.hooks && typeof data.hooks === 'object') {
      for (const [event, list] of Object.entries<Json[]>(data.hooks)) {
        if (!Array.isArray(list)) continue;
        const kept = list.filter((e) => !isOurs(e));
        if (kept.length !== list.length) touched = true;
        if (kept.length) data.hooks[event] = kept;
        else delete data.hooks[event];
      }
      if (!Object.keys(data.hooks).length) delete data.hooks;
    }
    if (touched) {
      if (!opts.dryRun) fs.writeFileSync(files.hooks, stringify(data));
      changes.push({ agent, file: files.hooks, action: 'update' });
    } else {
      changes.push({ agent, file: files.hooks, action: 'unchanged' });
    }
  }
  if (files.rules && fs.existsSync(files.rules)) {
    if (!opts.dryRun) fs.rmSync(files.rules);
    changes.push({ agent, file: files.rules, action: 'remove' });
  }
  return changes;
}

/** Is the polyfence hook wired into this agent at this scope? */
export function isInstalled(agent: AgentName, scope: Scope, root: string): boolean {
  const { hooks } = agentFiles(agent, scope, root);
  try {
    const data = readJson(hooks);
    if (agent === 'antigravity') return 'polyfence' in data;
    return Object.values<Json[]>(data.hooks ?? {}).some((list) => Array.isArray(list) && list.some(isOurs));
  } catch {
    return false;
  }
}
