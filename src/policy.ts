import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { regexLiteral } from './patterns.js';
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

/** The user-level policy file, if there is one. */
export function userPolicyFile(): string | undefined {
  const user = path.join(userConfigDir(), 'polyfence.yaml');
  return fs.existsSync(user) ? user : undefined;
}

/** Walk up from `start` looking for a project policy file. */
export function findProjectPolicyFile(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (dir !== userConfigDir()) {
      for (const name of POLICY_FILENAMES) {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The nearest project policy file, or else the user-level one. */
export function findPolicyFile(start: string): string | undefined {
  return findProjectPolicyFile(start) ?? userPolicyFile();
}

// ---- file cache ------------------------------------------------------------------
//
// Policy files and trusted.json are read, hashed and parsed once, and read again only when a
// stat shows a different file, size or time.

interface Snapshot {
  stamp: string;
  settled: boolean;
  bytes: Buffer;
  hash?: string;
  policy?: Policy;
  trust?: Readonly<Record<string, string>>;
}

const snapshots = new Map<string, Snapshot>();

/**
 * File times move in steps of a few ms (ext4, NTFS) up to 2 s (FAT), so an edit of the same size
 * soon after a read can leave every stat field unchanged. Until a file's times are older than
 * this, its bytes are compared on every read.
 */
const SETTLE_MS = 3000;

function snapshot(file: string): Snapshot {
  const key = path.resolve(file);
  const now = Date.now();
  let st: fs.BigIntStats | undefined;
  try {
    st = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
  } catch {
    // The read below reports the error.
  }
  const stamp = st ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}` : '';
  const cached = snapshots.get(key);
  // The stat comes first: a change made after it shows up in the next one.
  if (cached?.settled && stamp && cached.stamp === stamp) return cached;
  const bytes = fs.readFileSync(file);
  const settled = st !== undefined && now - Number(st.mtimeMs) > SETTLE_MS && now - Number(st.ctimeMs) > SETTLE_MS;
  if (cached?.bytes.equals(bytes)) return Object.assign(cached, { stamp, settled });
  if (snapshots.size >= 64) snapshots.clear();
  const fresh: Snapshot = { stamp, settled, bytes };
  snapshots.set(key, fresh);
  return fresh;
}

/** Cached policies are shared by every caller, so they are frozen: change a copy instead. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// ---- trust ---------------------------------------------------------------------
//
// A project policy can come from anywhere: a cloned repository, a pull, a directory the agent
// changed into. It may always tighten what agents can do. What loosens it counts only once the
// user has run `polyfence trust` on that exact file content: `allow` rules, `default: allow`,
// `onError: allow`, and leaving out, disabling or replacing rules of the built-in preset.

const trustFile = () => path.join(userConfigDir(), 'trusted.json');

/** Trust is keyed by the real path, so `/tmp/x` and `/private/tmp/x` are the same file. */
export function trustKey(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function readTrust(): Readonly<Record<string, string>> {
  try {
    const snap = snapshot(trustFile());
    if (!snap.trust) {
      const data = JSON.parse(snap.bytes.toString('utf8'));
      snap.trust = Object.freeze(isObj(data) ? (data as Record<string, string>) : {});
    }
    return snap.trust;
  } catch {
    return {};
  }
}

function fileHash(file: string): string | undefined {
  try {
    const snap = snapshot(file);
    return (snap.hash ??= crypto.createHash('sha256').update(snap.bytes).digest('hex'));
  } catch {
    return undefined;
  }
}

export function isTrusted(file: string): boolean {
  const abs = trustKey(file);
  const hash = fileHash(abs);
  return hash !== undefined && readTrust()[abs] === hash;
}

/** Record (or with `revoke`, forget) the current content of a policy file as trusted. */
export function setTrust(file: string, revoke = false): void {
  const abs = trustKey(file);
  const store = { ...readTrust() };
  if (revoke) delete store[abs];
  else {
    const hash = fileHash(abs);
    if (!hash) throw new PolicyError('cannot read policy', abs);
    store[abs] = hash;
  }
  fs.mkdirSync(userConfigDir(), { recursive: true });
  fs.writeFileSync(trustFile(), JSON.stringify(store, null, 2) + '\n');
}

/** Does the policy contain settings that loosen what agents may do? */
export function loosens(policy: Policy): boolean {
  return policy.default === 'allow' || policy.onError === 'allow' || policy.rules.some((r) => r.decision === 'allow');
}

/**
 * Does the policy leave out, disable or replace a rule of the built-in `recommended` preset?
 * With no user-level policy that preset is what a project would get without a policy file, so an
 * untrusted file can't take it away.
 */
export function dropsBuiltins(policy: Policy): boolean {
  const mine = new Map(policy.rules.map((r) => [r.id, r]));
  return PRESETS.recommended.some((r) => mine.get(r.id)?.preset === undefined);
}

/** The same policy with everything that loosens it removed. */
export function tightenOnly(policy: Policy): Policy {
  return {
    ...policy,
    default: policy.default === 'allow' ? 'defer' : policy.default,
    onError: 'deny',
    rules: policy.rules.filter((r) => r.decision !== 'allow'),
    untrusted: policy.source ? [policy.source] : [],
  };
}

const DEFAULT_RANK = { allow: 0, defer: 1, ask: 2, deny: 3 } as const;
const AUDIT_RANK = { off: 0, matched: 1, all: 2 } as const;

/**
 * Combine policies so that each can only add restrictions to the others. Every rule keeps the
 * workspace root of the file it came from. The last layer is the primary one: its file names
 * the workspace, the audit log and the tests.
 */
export function layerPolicies(layers: Policy[]): Policy {
  const primary = layers[layers.length - 1];
  if (layers.length === 1) return primary;
  const rules: Rule[] = [];
  const seen = new Set<string>();
  for (const layer of layers) {
    for (const rule of layer.rules) {
      const stamped = { ...rule, root: rule.root ?? layer.root };
      const key = JSON.stringify([stamped.id, stamped.decision, stamped.match, stamped.root]);
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push(stamped);
    }
  }
  const most = <T extends string>(rank: Record<T, number>, values: T[]): T => values.reduce((a, b) => (rank[b] > rank[a] ? b : a));
  return {
    ...primary,
    default: most(DEFAULT_RANK, layers.map((l) => l.default)),
    askFallback: layers.some((l) => l.askFallback === 'deny') ? 'deny' : 'defer',
    audit: most(AUDIT_RANK, layers.map((l) => l.audit)),
    onError: layers.some((l) => l.onError === 'deny') ? 'deny' : 'allow',
    rules,
    untrusted: layers.flatMap((l) => l.untrusted ?? []),
  };
}

export function loadPolicy(file: string): Policy {
  let snap: Snapshot;
  try {
    snap = snapshot(file);
  } catch (err) {
    throw new PolicyError(`cannot read policy: ${(err as Error).message}`, file);
  }
  const abs = path.resolve(file);
  const isUserPolicy = path.dirname(abs) === userConfigDir();
  // A user-level policy is rooted at the current directory, which may have changed since.
  if (snap.policy && snap.policy.root === (isUserPolicy ? process.cwd() : path.dirname(abs))) return snap.policy;
  let data: unknown;
  try {
    data = parseYaml(snap.bytes.toString('utf8'));
  } catch (err) {
    throw new PolicyError(`invalid YAML: ${(err as Error).message}`, file);
  }
  snap.policy = deepFreeze(buildPolicy(data ?? {}, { source: abs, root: isUserPolicy ? undefined : path.dirname(abs) }));
  return snap.policy;
}

/** The policy used when no file exists: the recommended preset, rooted at `cwd`. */
export function builtinPolicy(root: string, preset = 'recommended'): Policy {
  return buildPolicy({ extends: [preset] }, { root });
}

const DECISIONS = ['allow', 'ask', 'deny'];
const OUTCOMES = [...DECISIONS, 'defer'];
const MATCH_KEYS = ['tool', 'rawTool', 'agent', 'command', 'commandLine', 'script', 'path', 'readPath', 'writePath', 'url', 'outsideWorkspace'];
const PATH_KEYS = ['path', 'readPath', 'writePath'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strList(v: unknown, where: string, file?: string, paths = false): string[] | undefined {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : [v];
  for (const item of list) {
    if (typeof item !== 'string' || !item) throw new PolicyError(`${where} must be a string or a list of strings`, file);
    try {
      regexLiteral(item.startsWith('!') ? item.slice(1) : item, paths);
    } catch (err) {
      throw new PolicyError(`${where}: bad regex ${item}: ${(err as Error).message}`, file);
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
  for (const key of ['rawTool', 'command', 'commandLine', 'script', 'path', 'readPath', 'writePath', 'url'] as const) {
    const list = strList(raw[key], `${where}.match.${key}`, file, PATH_KEYS.includes(key));
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
