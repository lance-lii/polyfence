#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { auditFile, readAudit } from './audit.js';
import { compileCodex, compileGemini } from './compile.js';
import { describeCall, evaluate, fetchCall, fileCall, shellCall } from './engine.js';
import { policyFor, runHook } from './hook.js';
import { install, isInstalled, uninstall, type Change, type Scope } from './install.js';
import { PolicyError, loadPolicy } from './policy.js';
import { PRESETS } from './presets.js';
import { INIT_TEMPLATE } from './template.js';
import { runTests } from './testing.js';
import { AGENTS, type AgentName, type Outcome, type Policy, type ToolCall } from './types.js';

const VERSION = '0.1.0';

// ---- tiny arg parser ----------------------------------------------------------

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
  rest: string[];
}

const VALUE_FLAGS = new Set(['scope', 'command', 'tool', 'path', 'url', 'agent', 'preset', 'policy', 'out', 'n', 'outcome', 'cwd']);

function parseArgs(argv: string[]): Args {
  const out: Args = { positional: [], flags: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) out.flags[key] = a.slice(eq + 1);
      else if (VALUE_FLAGS.has(key) && i + 1 < argv.length) out.flags[key] = argv[++i];
      else out.flags[key] = true;
    } else if (a.startsWith('-') && a.length > 1) {
      const key = a.slice(1);
      if (VALUE_FLAGS.has(key) && i + 1 < argv.length) out.flags[key] = argv[++i];
      else out.flags[key] = true;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

const flag = (args: Args, name: string): string | undefined => (typeof args.flags[name] === 'string' ? (args.flags[name] as string) : undefined);

// ---- output helpers -----------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { red: paint('31'), green: paint('32'), yellow: paint('33'), blue: paint('34'), dim: paint('2'), bold: paint('1') };

function badge(outcome: Outcome): string {
  switch (outcome) {
    case 'deny':
      return c.red(c.bold('DENY '));
    case 'ask':
      return c.yellow(c.bold('ASK  '));
    case 'allow':
      return c.green(c.bold('ALLOW'));
    default:
      return c.dim('DEFER');
  }
}

function fail(message: string): never {
  process.stderr.write(c.red('error: ') + message + '\n');
  process.exit(1);
}

function parseAgents(list: string[]): AgentName[] {
  if (!list.length || list.includes('all')) return [...AGENTS];
  for (const a of list) if (!AGENTS.includes(a as AgentName)) fail(`unknown agent "${a}" (expected ${AGENTS.join(', ')}, all)`);
  return list as AgentName[];
}

function loadOrFail(cwd: string, explicit?: string): Policy {
  try {
    return explicit ? loadPolicy(explicit) : policyFor(cwd);
  } catch (err) {
    if (err instanceof PolicyError) fail(err.message);
    throw err;
  }
}

// ---- commands -------------------------------------------------------------------

function cmdInit(args: Args): void {
  const file = path.resolve('polyfence.yaml');
  if (fs.existsSync(file) && !args.flags.force) fail('polyfence.yaml already exists (use --force to overwrite)');
  const preset = flag(args, 'preset') ?? 'recommended';
  if (!PRESETS[preset]) fail(`unknown preset "${preset}" (available: ${Object.keys(PRESETS).join(', ')})`);
  fs.writeFileSync(file, INIT_TEMPLATE.replace('extends: [recommended]', `extends: [${preset}]`));
  console.log(`${c.green('created')} polyfence.yaml ${c.dim(`(preset: ${preset}, ${PRESETS[preset].length} rules)`)}`);

  const gitignore = path.resolve('.gitignore');
  const line = '.polyfence/';
  const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  if (!current.split('\n').some((l) => l.trim() === line)) {
    fs.writeFileSync(gitignore, current + (current && !current.endsWith('\n') ? '\n' : '') + line + '\n');
    console.log(`${c.green('updated')} .gitignore ${c.dim('(audit log)')}`);
  }
  console.log(`\nNext: ${c.bold('polyfence install')} to wire it into Claude Code, Codex, Gemini CLI and Antigravity.`);
}

function printChanges(changes: Change[], dryRun: boolean): void {
  for (const ch of changes) {
    const verb = { create: c.green('create'), update: c.blue('update'), remove: c.red('remove'), unchanged: c.dim('ok    ') }[ch.action];
    const rel = path.relative(process.cwd(), ch.file);
    const shown = rel.startsWith('..') ? ch.file : rel;
    console.log(`  ${verb} ${shown}${ch.note ? c.dim(`  (${ch.note})`) : ''}`);
  }
  if (dryRun) console.log(c.dim('\n(dry run: nothing was written)'));
}

function onPath(bin: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function cmdInstall(args: Args, remove: boolean): void {
  const agents = parseAgents(args.positional.slice(1));
  const scope = (flag(args, 'scope') ?? 'project') as Scope;
  if (scope !== 'project' && scope !== 'user') fail('--scope must be project or user');
  const dryRun = Boolean(args.flags['dry-run']);
  const policy = loadOrFail(process.cwd(), flag(args, 'policy'));
  const root = policy.source && scope === 'project' ? path.dirname(policy.source) : process.cwd();
  const command = flag(args, 'command') ?? 'polyfence hook';

  console.log(`${remove ? 'Removing' : 'Installing'} polyfence (${scope} scope) for ${agents.join(', ')}\n`);
  for (const agent of agents) {
    try {
      const changes = remove ? uninstall(agent, { scope, root, dryRun }) : install(agent, { scope, root, command, dryRun, policy });
      console.log(c.bold(agent));
      printChanges(changes, false);
    } catch (err) {
      console.log(`${c.bold(agent)}\n  ${c.red('skipped')} ${(err as Error).message}`);
    }
  }
  if (dryRun) console.log(c.dim('\n(dry run: nothing was written)'));
  if (!remove) {
    if (!policy.source) console.log(c.yellow(`\nNo polyfence.yaml found: hooks will use the built-in "recommended" preset. Run \`polyfence init\` to customize.`));
    if (command.startsWith('polyfence ') && !onPath('polyfence')) {
      console.log(c.yellow('\n`polyfence` is not on your PATH, so agents cannot run the hook yet.'));
      console.log(c.yellow('Install it globally (npm i -g polyfence) or pass --command "npx --no polyfence hook".'));
    }
    if (agents.includes('antigravity')) console.log(c.dim('\nAntigravity support is experimental; its hook format is still settling.'));
  }
}

function syntheticCall(args: Args): ToolCall {
  const cwd = path.resolve(flag(args, 'cwd') ?? process.cwd());
  const agent = (flag(args, 'agent') ?? 'claude') as AgentName;
  if (!AGENTS.includes(agent)) fail(`unknown agent "${agent}"`);
  const tool = flag(args, 'tool');
  const base = { agent, rawTool: tool ?? 'Bash', cwd };
  const target = flag(args, 'path') ?? flag(args, 'url') ?? args.positional.slice(1).join(' ');
  if (!tool || tool === 'shell') {
    const command = args.rest.length ? args.rest.join(' ') : target;
    if (!command) fail('nothing to check. Example: polyfence check -- git push --force');
    return shellCall(command, base);
  }
  if (tool === 'fetch') return fetchCall([target], { ...base, rawTool: 'WebFetch' });
  if (tool === 'read' || tool === 'write' || tool === 'edit') return fileCall(tool, [target || args.rest.join(' ')], { ...base, rawTool: tool });
  return fail(`--tool must be shell, read, write, edit or fetch`);
}

function cmdCheck(args: Args): void {
  const call = syntheticCall(args);
  const policy = loadOrFail(call.cwd, flag(args, 'policy'));
  const verdict = evaluate(policy, call);
  if (args.flags.json) {
    console.log(JSON.stringify({ outcome: verdict.outcome, rule: verdict.rule?.id, reason: verdict.reason, matched: verdict.matched.map((r) => r.id) }, null, 2));
  } else {
    console.log(`${badge(verdict.outcome)} ${describeCall(call)}`);
    if (verdict.rule) console.log(`       ${c.bold(verdict.rule.id)}${verdict.rule.preset ? c.dim(` (${verdict.rule.preset})`) : ''}: ${verdict.reason ?? ''}`);
    const others = verdict.matched.filter((r) => r !== verdict.rule);
    if (others.length) console.log(c.dim(`       also matched: ${others.map((r) => `${r.id} (${r.decision})`).join(', ')}`));
    if (call.tool === 'shell' && (args.flags.explain || args.flags.v)) {
      console.log(c.dim('\n  parsed commands:'));
      for (const s of call.segments) console.log(c.dim(`    • ${s.text}`));
      if (call.writes.length) console.log(c.dim(`  writes: ${call.writes.join(', ')}`));
    }
    console.log(c.dim(`\n  policy: ${policy.source ?? 'built-in recommended preset'}`));
  }
  process.exitCode = verdict.outcome === 'deny' ? 2 : 0;
}

function cmdTest(args: Args): void {
  const policy = loadOrFail(process.cwd(), flag(args, 'policy'));
  if (!policy.tests.length) {
    console.log(c.yellow('No tests in policy. Add a `tests:` list, e.g.\n  tests:\n    - shell: git push --force\n      expect: deny'));
    return;
  }
  const results = runTests(policy);
  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log(`${c.green('✓')} ${r.label} ${c.dim(`→ ${r.actual}${r.ruleId ? ` (${r.ruleId})` : ''}`)}`);
    else {
      failed++;
      console.log(`${c.red('✗')} ${r.label}\n    expected ${c.bold(r.expected)}, got ${c.bold(r.actual)}${r.ruleId ? ` from ${r.ruleId}` : ''}${r.problem ? `\n    ${r.problem}` : ''}`);
    }
  }
  console.log(`\n${failed ? c.red(`${failed} failed`) : c.green('all passed')}, ${results.length} total`);
  process.exitCode = failed ? 1 : 0;
}

function cmdCompile(args: Args): void {
  const target = args.positional[1];
  if (target !== 'codex' && target !== 'gemini') fail('usage: polyfence compile <codex|gemini> [--out file]');
  const policy = loadOrFail(process.cwd(), flag(args, 'policy'));
  const text = target === 'codex' ? compileCodex(policy) : compileGemini(policy);
  const out = flag(args, 'out');
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text);
    console.log(`${c.green('wrote')} ${out}`);
  } else process.stdout.write(text);
}

function cmdLog(args: Args): void {
  const policy = loadOrFail(process.cwd());
  const file = auditFile(policy);
  let entries = readAudit(file);
  const outcome = flag(args, 'outcome') ?? (args.flags.deny ? 'deny' : undefined);
  if (outcome) entries = entries.filter((e) => e.outcome === outcome);
  const n = Number(flag(args, 'n') ?? 20);
  entries = entries.slice(-n);
  if (args.flags.json) {
    for (const e of entries) console.log(JSON.stringify(e));
    return;
  }
  if (!entries.length) {
    console.log(c.dim(`No audit entries in ${file}`));
    return;
  }
  for (const e of entries) {
    const when = e.ts.replace('T', ' ').slice(0, 19);
    console.log(`${c.dim(when)} ${badge(e.outcome)} ${c.blue(e.agent.padEnd(11))} ${e.summary.slice(0, 100)}${e.rule ? c.dim(`  [${e.rule}]`) : ''}`);
  }
}

function cmdDoctor(): void {
  const cwd = process.cwd();
  let policy: Policy | undefined;
  try {
    policy = policyFor(cwd);
    console.log(`${c.green('✓')} policy: ${policy.source ?? 'none found, using built-in recommended preset'} ${c.dim(`(${policy.rules.length} rules)`)}`);
    if (policy.tests.length) {
      const failed = runTests(policy).filter((r) => !r.ok).length;
      console.log(`${failed ? c.red('✗') : c.green('✓')} policy tests: ${failed ? `${failed} failing` : `${policy.tests.length} passing`}`);
    }
  } catch (err) {
    console.log(`${c.red('✗')} policy: ${(err as Error).message}`);
  }
  console.log(`${onPath('polyfence') ? c.green('✓') : c.yellow('!')} polyfence on PATH${onPath('polyfence') ? '' : ' (agents cannot run the hook; npm i -g polyfence)'}`);
  const root = policy?.source ? path.dirname(policy.source) : cwd;
  const bins: Record<AgentName, string> = { claude: 'claude', codex: 'codex', gemini: 'gemini', antigravity: 'agy' };
  console.log('');
  for (const agent of AGENTS) {
    const project = isInstalled(agent, 'project', root);
    const user = isInstalled(agent, 'user', root);
    const wired = project || user;
    const where = [project && 'project', user && 'user'].filter(Boolean).join(' + ');
    const bin = onPath(bins[agent]) ? '' : c.dim(` (${bins[agent]} not found on PATH)`);
    console.log(`${wired ? c.green('✓') : c.dim('·')} ${agent.padEnd(12)} ${wired ? `hook installed (${where})` : c.dim('not installed')}${bin}`);
  }
}

function cmdPresets(args: Args): void {
  const name = args.positional[1];
  const names = name ? [name] : Object.keys(PRESETS);
  for (const n of names) {
    const rules = PRESETS[n];
    if (!rules) fail(`unknown preset "${n}"`);
    console.log(c.bold(`${n}`) + c.dim(` (${rules.length} rules)`));
    for (const r of rules) console.log(`  ${badge(r.decision)} ${r.id.padEnd(24)} ${c.dim(r.reason ?? '')}`);
    console.log('');
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function cmdHook(args: Args): Promise<void> {
  const agent = args.positional[1] as AgentName | undefined;
  if (agent && !AGENTS.includes(agent)) {
    process.stderr.write(`polyfence: unknown agent "${agent}"\n`);
    process.exit(0);
  }
  const reply = runHook(await readStdin(), agent);
  if (reply.stdout) process.stdout.write(reply.stdout + '\n');
  if (reply.stderr) process.stderr.write(reply.stderr);
  process.exitCode = reply.exitCode;
}

const HELP = `${c.bold('polyfence')} ${c.dim(VERSION)} — one guardrail policy for every AI coding agent

${c.bold('Usage')}
  polyfence init [--preset recommended|strict]     create polyfence.yaml
  polyfence install [agents...] [--scope project|user] [--command <cmd>] [--dry-run]
  polyfence uninstall [agents...] [--scope project|user]
  polyfence check [--explain] -- <shell command>   evaluate a command
  polyfence check --tool read|write|edit --path <file>
  polyfence check --tool fetch --url <url>
  polyfence test                                   run the tests in polyfence.yaml
  polyfence compile codex|gemini [--out file]      print native static rules
  polyfence log [-n 20] [--deny] [--json]          show the audit log
  polyfence doctor                                 show what is wired up where
  polyfence presets [name]                         list built-in rules
  polyfence hook [agent]                           (called by agents) read a hook payload on stdin

${c.bold('Agents')}  claude, codex, gemini, antigravity (default: all)
`;

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const cmd = args.positional[0];
  if (args.flags.version || args.flags.V || cmd === 'version') return void console.log(VERSION);
  if (!cmd || args.flags.help || args.flags.h || cmd === 'help') return void console.log(HELP);
  switch (cmd) {
    case 'init':
      return cmdInit(args);
    case 'install':
      return cmdInstall(args, false);
    case 'uninstall':
      return cmdInstall(args, true);
    case 'check':
      return cmdCheck(args);
    case 'test':
      return cmdTest(args);
    case 'compile':
      return cmdCompile(args);
    case 'log':
      return cmdLog(args);
    case 'doctor':
      return cmdDoctor();
    case 'presets':
      return cmdPresets(args);
    case 'hook':
      return cmdHook(args);
    default:
      fail(`unknown command "${cmd}". Run polyfence --help`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  if (process.argv[2] === 'hook') {
    // Never crash an agent's tool call with a stack trace.
    process.stderr.write(`polyfence: ${(err as Error).message}\n`);
    process.exit(0);
  }
  fail((err as Error).stack ?? String(err));
});
