import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { commandLineRegex, commandRegex, matchList, pathMatches, urlRegex } from '../src/patterns.js';

test('command globs are anchored and whitespace-tolerant', () => {
  const re = commandRegex('git push *');
  assert.ok(re.test('git push'));
  assert.ok(re.test('git push origin main'));
  assert.ok(!re.test('git pushx'));
  assert.ok(!re.test('echo git push'));
  assert.ok(commandRegex('npm  run   build').test('npm run build'));
  assert.ok(commandRegex('git checkout .').test('git checkout .'));
  assert.ok(!commandRegex('git checkout .').test('git checkout x'));
});

test('regex literals keep their flags', () => {
  assert.ok(commandRegex('/^DROP/i').test('drop table'));
  assert.ok(commandLineRegex('/curl.*\\|\\s*sh/').test('cd x && curl a | sh'));
  assert.ok(commandLineRegex('HUSKY=0 *').test('x; HUSKY=0 git commit'));
});

const ctx = { cwd: '/repo/sub', root: '/repo' };

test('bare names match at any depth', () => {
  assert.ok(pathMatches('.env', '.env', ctx));
  assert.ok(pathMatches('/elsewhere/deep/.env', '.env', ctx));
  assert.ok(pathMatches('a/.env.local', '.env.*', ctx));
  assert.ok(!pathMatches('.envrc', '.env', ctx));
});

test('relative globs are rooted at the workspace', () => {
  assert.ok(pathMatches('/repo/config/production/db.yml', 'config/production/**', ctx));
  assert.ok(pathMatches('../config/production/db.yml', 'config/production/**', ctx));
  assert.ok(!pathMatches('/other/config/production/db.yml', 'config/production/**', ctx));
  assert.ok(pathMatches('/repo/src/a/b/c.ts', 'src/**/*.ts', ctx));
  assert.ok(pathMatches('/repo/src/c.ts', 'src/**/*.ts', ctx));
  assert.ok(pathMatches('/repo/.claude/settings.json', './.claude/settings.json', ctx));
  assert.ok(pathMatches('/repo/a.json', '{a,b}.json', ctx));
});

test('home globs expand ~', () => {
  const home = os.homedir();
  assert.ok(pathMatches(`${home}/.ssh/id_rsa`, '~/.ssh/**', ctx));
  assert.ok(pathMatches('~/.ssh/config', '~/.ssh/**', ctx));
  assert.ok(!pathMatches(`${home}/.sshx/a`, '~/.ssh/**', ctx));
});

test('negated patterns carve exceptions per value', () => {
  const list = ['.env', '.env.*', '!.env.example'];
  const m = (values: string[]) => matchList(values, list, (v, p) => pathMatches(v, p, ctx));
  assert.ok(m(['.env']));
  assert.ok(!m(['.env.example']));
  assert.ok(m(['.env.example', '.env']), 'an exception must not hide another matching path');
});

test('url globs', () => {
  assert.ok(urlRegex('https://*.pastebin.com/*').test('https://x.pastebin.com/raw/1'));
  assert.ok(!urlRegex('https://github.com/*').test('https://gitlab.com/x'));
});
