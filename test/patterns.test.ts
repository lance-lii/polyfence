import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { CASE_INSENSITIVE, commandLineRegex, commandRegex, isInside, matchList, pathMatches, resolvePath, type Platform, urlRegex } from '../src/patterns.js';

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
  assert.ok(pathMatches('$HOME/.ssh/config', '~/.ssh/**', ctx));
  assert.ok(pathMatches('${HOME}/.ssh/config', '~/.ssh/**', ctx));
  assert.ok(!pathMatches(`${home}/.sshx/a`, '~/.ssh/**', ctx));
  for (const p of ['~', '$HOME', '${HOME}']) assert.equal(resolvePath(p, ctx), path.resolve(home), p);
});

test('path case follows the platform', () => {
  assert.equal(pathMatches('/repo/.ENV', '.env', ctx), CASE_INSENSITIVE);
  assert.equal(pathMatches('/REPO/.Claude/Settings.json', '.claude/settings.json', ctx), CASE_INSENSITIVE);
  assert.equal(pathMatches(`${os.homedir()}/.SSH/id_rsa`, '~/.ssh/**', ctx), CASE_INSENSITIVE);
  assert.equal(isInside('/Repo/src', '/repo'), CASE_INSENSITIVE);
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

test('Windows paths: drive letters, backslashes, Git Bash paths and the home directory', () => {
  const platform: Platform = { path: path.win32, home: 'C:\\Users\\me', caseInsensitive: true };
  const ctx = { cwd: 'C:\\work\\app', root: 'C:\\work\\app', platform };
  const m = (p: string, pattern: string) => pathMatches(p, pattern, ctx);
  assert.equal(resolvePath('src\\a.ts', ctx), 'C:/work/app/src/a.ts');
  assert.equal(resolvePath('/c/Users/me/x', ctx), 'c:/Users/me/x');

  assert.ok(m('.env', '.env'));
  assert.ok(m('config\\.ENV', '.env'));
  assert.ok(m('C:\\work\\app\\config\\production\\db.yml', 'config/production/**'));
  assert.ok(m('config/production/db.yml', 'config/production/**'));
  assert.ok(!m('C:\\work\\other\\config\\production\\db.yml', 'config/production/**'));
  assert.ok(!m('D:\\work\\app\\config\\production\\db.yml', 'config/production/**'));

  assert.ok(m('C:\\Users\\me\\.ssh\\id_ed25519', '~/.ssh/**'));
  assert.ok(m('~/.ssh/config', '~/.ssh/**'));
  assert.ok(m('/c/Users/me/.aws/credentials', '~/.aws/credentials'));
  assert.ok(!m('C:\\Users\\you\\.ssh\\id_ed25519', '~/.ssh/**'));

  assert.ok(m('C:\\etc\\hosts', '/etc/hosts'), 'a pattern without a drive applies on every drive');
  assert.ok(m('D:\\data\\x', 'D:/data/**'));
  assert.ok(!m('C:\\data\\x', 'D:/data/**'));

  assert.ok(isInside('C:/work/app/src/a.ts', 'C:\\Work\\App', platform));
  assert.ok(!isInside('C:/work/application/a.ts', 'C:\\work\\app', platform));
  assert.ok(!isInside('D:/work/app/a.ts', 'C:\\work\\app', platform));
});

test('POSIX paths behave the same on any host', () => {
  const platform: Platform = { path: path.posix, home: '/home/me', caseInsensitive: false };
  const ctx = { cwd: '/work/app', root: '/work/app', platform };
  assert.ok(pathMatches('.env', '.env', ctx));
  assert.ok(!pathMatches('.ENV', '.env', ctx));
  assert.ok(pathMatches('/home/me/.ssh/id_rsa', '~/.ssh/**', ctx));
  assert.ok(pathMatches('/c/Users/me/x', '/c/Users/**', ctx), '/c/ is an ordinary directory here');
  assert.ok(!pathMatches('/work/other/src/a.ts', 'src/**', ctx));
});
