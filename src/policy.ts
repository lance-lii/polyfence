import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PRESETS } from './presets.js';
import { AGENTS, TOOL_KINDS, type MatchSpec, type Policy, type PolicyTest, type Rule } from './types.js';

export const POLICY_FILENAMES = ['polyfence.yaml', '.polyfence.yaml', 'polyfence.yml', '.polyfence.yml'];

export function userConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config'), 'polyfence');
}

export class PolicyError extends Error {
  constructor(message: string, readonly file?: string) {
    super(file ? `${file}: ${message}` : message);
  }
}

/** Walk up from `start` looking for a policy file, then fall back to the user config dir. */
export function findPolicyFile(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    for (const name of POLICY_FILENAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const user = path.join(userConfigDir(), 'polyfence.yaml');
  return fs.existsSync(user) ? user : undefined;
}

export function loadPolicy(file: string): Policy {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new PolicyError(`cannot read policy: ${(err as Error).message}`, file);
  }
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new PolicyError(`invalid YAML: ${(err as Error).message}`, file);
  }
  const abs = path.resolve(file);
  const isUserPolicy = path.dirname(abs) === userConfigDir();
  return buildPolicy(data ?? {}, { source: abs, root: isUserPolicy ? undefined : path.dirname(abs) });
}

/** The policy used when no file exists: the recommended preset, rooted at `cwd`. */
export function builtinPolicy(root: string, preset = 'recommended'): Policy {
  return buildPolicy({ extends: [preset] }, { root });
}

const DECISIONS = ['allow', 'ask', 'deny'];
const OUTCOMES = [...DECISIONS, 'defer'];
const MATCH_KEYS = ['tool', 'rawTool', 'agent', 'command', 'commandLine', 'path', 'writePath', 'url', 'outsideWorkspace'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strList(v: unknown, where: string, file?: string): string[] | undefined {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : [v];
  for (const item of list) {
    if (typeof item !== 'string' || !item) throw new PolicyError(`${where} must be a string or a list of strings`, file);
    const m = /^!?\/(.+)\/([a-z]*)$/s.exec(item);
    if (m) {
      try {
        new RegExp(m[1], m[2]);
      } catch (err) {
        throw new PolicyError(`${where}: bad regex ${item}: ${(err as Error).message}`, file);
      }
    }
  }
  return list as string[];
}

function oneOf<T extends string>(v: unknown, allowed: readonly string[], where: string, fallback: T, file?: string): T {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !allowed.includes(v)) {
    throw new PolicyError(`${where} must be one of: ${allowed.join(', ')} (got ${JSON.stringify(v)})`, file);
  }
  return v as T;
}

function parseMatch(raw: unknown, where: string, file?: string): MatchSpec {
  if (!isObj(raw)) throw new PolicyError(`${where}.match must be a mapping`, file);
  for (const key of Object.keys(raw)) {
    if (!MATCH_KEYS.includes(key)) {
      throw new PolicyError(`${where}.match: unknown key "${key}" (expected one of ${MATCH_KEYS.join(', ')})`, file);
    }
  }
  const match: MatchSpec = {};
  const tools = strList(raw.tool, `${where}.match.tool`, file);
  if (tools) {
    for (const t of tools) {
      if (t !== 'any' && !TOOL_KINDS.includes(t as never)) {
        throw new PolicyError(`${where}.match.tool: unknown tool "${t}" (expected any, ${TOOL_KINDS.join(', ')})`, file);
      }
    }
    match.tool = tools as MatchSpec['tool'];
  }
  const agents = strList(raw.agent, `${where}.match.agent`, file);
  if (agents) {
    for (const a of agents) {
      if (!AGENTS.includes(a as never)) throw new PolicyError(`${where}.match.agent: unknown agent "${a}"`, file);
    }
    match.agent = agents as MatchSpec['agent'];
  }
  for (const key of ['rawTool', 'command', 'commandLine', 'path', 'writePath', 'url'] as const) {
    const list = strList(raw[key], `${where}.match.${key}`, file);
    if (list) match[key] = list;
  }
  if (raw.outsideWorkspace !== undefined) {
    if (typeof raw.outsideWorkspace !== 'boolean') throw new PolicyError(`${where}.match.outsideWorkspace must be true or false`, file);
    match.outsideWorkspace = raw.outsideWorkspace;
  }
  if (!Object.keys(match).length) throw new PolicyError(`${where}.match is empty; it would match every tool call`, file);
  return match;
}

function parseRule(raw: unknown, index: number, file?: string): Rule {
  const where = `rules[${index}]`;
  if (!isObj(raw)) throw new PolicyError(`${where} must be a mapping`, file);
  const id = raw.id === undefined ? `rule-${index + 1}` : raw.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]+$/.test(id)) {
    throw new PolicyError(`${where}.id must be letters, digits, dashes, dots, colons or underscores`, file);
  }
  const decision = oneOf<Rule['decision']>(raw.decision, DECISIONS, `${where}.decision`, 'deny', file);
  if (raw.reason !== undefined && typeof raw.reason !== 'string') throw new PolicyError(`${where}.reason must be a string`, file);
  return { id, decision, reason: raw.reason as string | undefined, match: parseMatch(raw.match, where, file) };
}

const TEST_KINDS = ['shell', 'read', 'write', 'edit', 'fetch'] as const;

function parseTest(raw: unknown, index: number, file?: string): PolicyTest {
  const where = `tests[${index}]`;
  if (!isObj(raw)) throw new PolicyError(`${where} must be a mapping`, file);
  const kinds = TEST_KINDS.filter((k) => raw[k] !== undefined);
  if (kinds.length !== 1) throw new PolicyError(`${where} needs exactly one of: ${TEST_KINDS.join(', ')}`, file);
  if (typeof raw[kinds[0]] !== 'string') throw new PolicyError(`${where}.${kinds[0]} must be a string`, file);
  const test: PolicyTest = {
    [kinds[0]]: raw[kinds[0]],
    expect: oneOf(raw.expect, OUTCOMES, `${where}.expect`, 'defer', file),
  };
  if (raw.expect === undefined) throw new PolicyError(`${where}.expect is required (${OUTCOMES.join(', ')})`, file);
  if (raw.name !== undefined) test.name = String(raw.name);
  if (raw.rule !== undefined) test.rule = String(raw.rule);
  if (raw.agent !== undefined) test.agent = oneOf(raw.agent, AGENTS, `${where}.agent`, 'claude', file);
  return test;
}

export function buildPolicy(data: unknown, opts: { source?: string; root?: string }): Policy {
  const file = opts.source;
  if (!isObj(data)) throw new PolicyError('policy must be a YAML mapping', file);
  if (data.version !== undefined && data.version !== 1) throw new PolicyError('only version: 1 is supported', file);

  const presets = strList(data.extends, 'extends', file) ?? [];
  for (const p of presets) {
    if (!PRESETS[p]) throw new PolicyError(`unknown preset "${p}" (available: ${Object.keys(PRESETS).join(', ')})`, file);
  }
  const disable = strList(data.disable, 'disable', file) ?? [];
  if (data.rules !== undefined && !Array.isArray(data.rules)) throw new PolicyError('rules must be a list', file);
  if (data.tests !== undefined && !Array.isArray(data.tests)) throw new PolicyError('tests must be a list', file);

  const own = ((data.rules as unknown[]) ?? []).map((r, i) => parseRule(r, i, file));
  const seen = new Set<string>();
  for (const r of own) {
    if (seen.has(r.id)) throw new PolicyError(`duplicate rule id "${r.id}"`, file);
    seen.add(r.id);
  }

  // Preset rules first; a user rule with the same id replaces the preset's.
  const merged: Rule[] = [];
  const presetIds = new Set<string>();
  for (const name of presets) {
    for (const rule of PRESETS[name]) {
      if (presetIds.has(rule.id)) continue;
      presetIds.add(rule.id);
      if (disable.includes(rule.id) || seen.has(rule.id)) continue;
      merged.push({ ...rule, preset: name });
    }
  }
  for (const id of disable) {
    if (!presetIds.has(id)) throw new PolicyError(`disable: "${id}" is not a rule in the extended presets`, file);
  }
  merged.push(...own);

  return {
    version: 1,
    extends: presets,
    disable,
    default: oneOf(data.default, OUTCOMES, 'default', 'defer', file),
    askFallback: oneOf(data.askFallback, ['deny', 'defer'], 'askFallback', 'deny', file),
    audit: oneOf(data.audit, ['matched', 'all', 'off'], 'audit', 'matched', file),
    onError: oneOf(data.onError, ['deny', 'allow'], 'onError', 'deny', file),
    rules: merged,
    tests: ((data.tests as unknown[]) ?? []).map((t, i) => parseTest(t, i, file)),
    source: file,
    root: opts.root ?? process.cwd(),
  };
}
