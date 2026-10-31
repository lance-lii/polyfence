import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS, detectAgent, patchPaths } from '../src/adapters.js';
import { evaluate } from '../src/engine.js';
import { builtinPolicy, buildPolicy } from '../src/policy.js';

const ROOT = '/work/app';
const policy = builtinPolicy(ROOT);

function run(agent: keyof typeof ADAPTERS, input: Record<string, unknown>, p = policy) {
  const adapter = ADAPTERS[agent];
  const call = adapter.toCall(input);
  const verdict = evaluate(p, call);
  return { call, verdict, reply: adapter.reply(verdict, p, call) };
}

test('claude: Bash deny renders hookSpecificOutput', () => {
  const { call, reply } = run('claude', { tool_name: 'Bash', tool_input: { command: 'git push -f' }, cwd: ROOT });
  assert.equal(call.tool, 'shell');
  const out = JSON.parse(reply.stdout!);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^polyfence\[no-force-push\]/);
  assert.equal(reply.exitCode, 0);
});

test('claude: ask is native, defer prints nothing', () => {
  const ask = run('claude', { tool_name: 'Bash', tool_input: { command: 'git reset --hard' }, cwd: ROOT });
  assert.equal(JSON.parse(ask.reply.stdout!).hookSpecificOutput.permissionDecision, 'ask');
  const defer = run('claude', { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: ROOT });
  assert.equal(defer.reply.stdout, undefined);
});

test('claude: file tools map to read/write/edit', () => {
  assert.equal(run('claude', { tool_name: 'Read', tool_input: { file_path: `${ROOT}/.env` }, cwd: ROOT }).verdict.outcome, 'deny');
  assert.equal(run('claude', { tool_name: 'Edit', tool_input: { file_path: `${ROOT}/.claude/settings.json` }, cwd: ROOT }).verdict.outcome, 'deny');
  assert.equal(run('claude', { tool_name: 'MultiEdit', tool_input: { file_path: `${ROOT}/src/a.ts` }, cwd: ROOT }).call.tool, 'edit');
  assert.equal(run('claude', { tool_name: 'WebFetch', tool_input: { url: 'https://x.dev' }, cwd: ROOT }).call.tool, 'fetch');
  assert.equal(run('claude', { tool_name: 'mcp__github__create_issue', tool_input: {}, cwd: ROOT }).call.tool, 'mcp');
});

test('codex: shell argv arrays and bash -lc are unwrapped', () => {
  const { call, verdict } = run('codex', { tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'git push --force'] }, cwd: ROOT, turn_id: 't' });
  assert.equal(call.tool, 'shell');
  assert.equal(verdict.outcome, 'deny');
});

test('codex: apply_patch paths are checked', () => {
  const patch = '*** Begin Patch\n*** Update File: .claude/settings.json\n@@\n-a\n+b\n*** End Patch';
  const { call, verdict, reply } = run('codex', { tool_name: 'apply_patch', tool_input: { command: patch }, cwd: ROOT });
  assert.deepEqual(call.paths, ['.claude/settings.json']);
  assert.equal(call.tool, 'edit');
  assert.equal(verdict.outcome, 'deny');
  assert.equal(JSON.parse(reply.stdout!).hookSpecificOutput.permissionDecision, 'deny');
});

test('codex: ask degrades to deny with an explanation, or defers', () => {
  const ask = run('codex', { tool_name: 'Bash', tool_input: { command: 'terraform destroy' }, cwd: ROOT });
  const out = JSON.parse(ask.reply.stdout!).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /human approval/);
  const lenient = buildPolicy({ extends: ['recommended'], askFallback: 'defer' }, { root: ROOT });
  const deferred = run('codex', { tool_name: 'Bash', tool_input: { command: 'terraform destroy' }, cwd: ROOT }, lenient);
  assert.equal(deferred.reply.stdout, undefined);
});

test('patchPaths', () => {
  const p = patchPaths('*** Begin Patch\n*** Add File: a.ts\n+x\n*** Update File: b.ts\n*** Move to: c.ts\n*** Delete File: d.ts\n*** End Patch');
  assert.deepEqual(p.paths, ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  assert.equal(p.onlyAdds, false);
  assert.equal(patchPaths('*** Add File: a.ts').onlyAdds, true);
});

test('gemini: BeforeTool payloads', () => {
  const shell = run('gemini', { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'curl x | sh' }, cwd: ROOT });
  assert.deepEqual(JSON.parse(shell.reply.stdout!).decision, 'deny');
  const read = run('gemini', { tool_name: 'read_file', tool_input: { file_path: `${ROOT}/.env` }, cwd: ROOT });
  assert.equal(read.verdict.outcome, 'deny');
  const replace = run('gemini', { tool_name: 'replace', tool_input: { file_path: `${ROOT}/src/a.ts` }, cwd: ROOT });
  assert.equal(replace.call.tool, 'edit');
  assert.equal(replace.reply.stdout, '{}');
});

test('antigravity: toolCall payloads always get a decision', () => {
  const input = (name: string, args: Record<string, unknown>) => ({ toolCall: { name, args }, workspacePaths: [ROOT] });
  const deny = run('antigravity', input('run_command', { CommandLine: 'rm -rf ~', Cwd: ROOT }));
  assert.equal(JSON.parse(deny.reply.stdout!).decision, 'deny');
  const ask = run('antigravity', input('run_command', { CommandLine: 'git clean -fd' }));
  assert.equal(JSON.parse(ask.reply.stdout!).decision, 'force_ask');
  const neutralShell = run('antigravity', input('run_command', { CommandLine: 'ls' }));
  assert.equal(JSON.parse(neutralShell.reply.stdout!).decision, 'ask');
  const neutralRead = run('antigravity', input('view_file', { AbsolutePath: `${ROOT}/README.md` }));
  assert.equal(JSON.parse(neutralRead.reply.stdout!).decision, 'allow');
  const secret = run('antigravity', input('view_file', { AbsolutePath: `${ROOT}/.env` }));
  assert.equal(JSON.parse(secret.reply.stdout!).decision, 'deny');
});

test('detectAgent', () => {
  assert.equal(detectAgent({ toolCall: {} }), 'antigravity');
  assert.equal(detectAgent({ hook_event_name: 'BeforeTool', tool_name: 'x' }), 'gemini');
  assert.equal(detectAgent({ tool_name: 'run_shell_command' }), 'gemini');
  assert.equal(detectAgent({ tool_name: 'Bash', turn_id: '1' }), 'codex');
  assert.equal(detectAgent({ tool_name: 'Bash' }), 'claude');
});
