import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShell, segmentPaths, segmentWrites } from '../src/shell.js';

const texts = (src: string) => parseShell(src).map((s) => s.text);

test('splits on control operators', () => {
  assert.deepEqual(texts('a && b || c; d | e & f'), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(texts('a\nb'), ['a', 'b']);
  assert.deepEqual(texts('(cd x; make)'), ['cd x', 'make']);
});

test('removes quotes and handles escapes', () => {
  assert.deepEqual(texts(`git commit -m 'hello world'`), ['git commit -m hello world']);
  assert.deepEqual(texts(`echo "a \\"b\\" c"`), ['echo a "b" c']);
  assert.deepEqual(texts('echo a\\ b'), ['echo a b']);
  assert.deepEqual(texts('git push \\\n  --force'), ['git push --force']);
});

test('strips wrappers, env assignments and git global options', () => {
  assert.deepEqual(texts('FOO=1 BAR=2 sudo -u root env -i X=1 nohup timeout 30 git -C repo -c a=b push -f'), ['git push -f']);
  assert.deepEqual(texts('/usr/bin/rm -rf /'), ['rm -rf /']);
  assert.deepEqual(texts('find . -name x | xargs -I{} rm -rf {}'), ['find . -name x', 'rm -rf {}']);
  assert.deepEqual(texts('if true; then rm -rf /; fi'), ['true', 'rm -rf /']);
  assert.deepEqual(texts('for f in a b; do rm $f; done'), ['rm $f']);
});

test('recurses into bash -c, eval, $(...) and backticks', () => {
  assert.ok(texts(`bash -lc "git push --force"`).includes('git push --force'));
  assert.ok(texts(`sh -c 'cd x && rm -rf ~'`).includes('rm -rf ~'));
  assert.ok(texts(`eval "git push -f"`).includes('git push -f'));
  assert.ok(texts('echo $(git push -f)').includes('git push -f'));
  assert.ok(texts('echo "$(git push -f)"').includes('git push -f'));
  assert.ok(texts('echo `git push -f`').includes('git push -f'));
  assert.ok(texts('diff <(cat a) <(cat b)').includes('cat a'));
  assert.ok(!texts('echo $((1 + 2))').some((t) => t.startsWith('1')));
});

test('skips heredoc bodies', () => {
  const src = `git commit -m "$(cat <<'EOF'
rm -rf / is now handled (closes #12)
Don't panic
EOF
)" && git push`;
  const t = texts(src);
  assert.ok(t.some((x) => x.startsWith('git commit -m')));
  assert.ok(t.includes('git push'));
  assert.ok(!t.some((x) => x.startsWith('rm')), `heredoc body leaked: ${JSON.stringify(t)}`);
  assert.deepEqual(texts('cat <<EOF > out.txt\nrm -rf /\nEOF\necho done'), ['cat', 'echo done']);
});

test('ignores comments', () => {
  assert.deepEqual(texts('ls # rm -rf /'), ['ls']);
  assert.deepEqual(texts('echo a#b'), ['echo a#b']);
});

test('collects redirect targets', () => {
  const [seg] = parseShell('echo hi > out.txt 2>&1 >> log.txt < in.txt');
  assert.deepEqual(seg.argv, ['echo', 'hi']);
  assert.deepEqual(seg.redirects, ['out.txt', 'log.txt', 'in.txt']);
  const [seg2] = parseShell('cmd &> all.log');
  assert.deepEqual(seg2.redirects, ['all.log']);
  const [seg3] = parseShell('cat <<< "hello"');
  assert.deepEqual(seg3.redirects, []);
});

test('extracts touched and written paths', () => {
  const [cat] = parseShell('cat --file=.env src/a.ts https://x.dev > /dev/null');
  assert.deepEqual(segmentPaths(cat), ['.env', 'src/a.ts']);
  const w = (src: string) => parseShell(src).flatMap(segmentWrites);
  assert.deepEqual(w('cp a b c/'), ['c/']);
  assert.deepEqual(w('mv a b'), ['a', 'b']);
  assert.deepEqual(w('chmod 600 key.pem'), ['key.pem']);
  assert.deepEqual(w(`sed -i 's/a/b/' config.yml`), ['config.yml']);
  assert.deepEqual(w('echo x | tee -a out.log'), ['out.log']);
  assert.deepEqual(w('dd if=/dev/zero of=disk.img'), ['disk.img']);
  assert.deepEqual(w('cat a > b'), ['b']);
  assert.deepEqual(w('cat a'), []);
});

test('survives hostile input', () => {
  assert.doesNotThrow(() => parseShell(`"unterminated`));
  assert.doesNotThrow(() => parseShell(`$(((((`));
  assert.doesNotThrow(() => parseShell('bash -c '.repeat(50) + 'ls'));
  assert.deepEqual(parseShell(''), []);
});
