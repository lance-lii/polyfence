import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskQuoted, parseScript, parseShell, segmentPaths, segmentReads, segmentWrites } from '../src/shell.js';

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

test('finds the -c script after shell options', () => {
  assert.ok(texts(`bash -o pipefail -c 'git push --force'`).includes('git push --force'));
  assert.ok(texts(`bash -eo pipefail -c 'rm -rf ~'`).includes('rm -rf ~'));
  assert.ok(texts(`bash -O extglob +o posix --rcfile rc -c 'ls x'`).includes('ls x'));
  assert.ok(texts(`sh +e -c 'ls x'`).includes('ls x'));
  assert.ok(texts(`sh -c -e 'ls x'`).includes('ls x'));
  assert.ok(texts(`sh -c -- 'ls x'`).includes('ls x'));
  assert.deepEqual(texts('bash -o pipefail build.sh'), ['bash -o pipefail build.sh']);
});

test('parses heredocs and herestrings that a shell runs', () => {
  assert.ok(texts("bash <<'EOF'\nls -la\nEOF").includes('ls -la'));
  assert.ok(texts('sh -s -- prod <<EOF\nmake deploy\nEOF').includes('make deploy'));
  assert.ok(texts('bash <<EOF | tee log\nmake\nEOF').includes('make'));
  assert.ok(texts(`bash <<< 'make test'`).includes('make test'));
  assert.deepEqual(texts('bash run.sh <<EOF\nmake\nEOF'), ['bash run.sh']);
  assert.deepEqual(texts('python3 - <<EOF\nmake\nEOF'), ['python3 -']);
});

test('finds command substitutions in unquoted heredoc bodies only', () => {
  const t = texts('cat <<EOF > out.txt\nuser: $(whoami), host: `hostname`, cost: \\$(none)\nEOF');
  assert.ok(t.includes('whoami') && t.includes('hostname'), JSON.stringify(t));
  assert.ok(!t.includes('none'), JSON.stringify(t));
  for (const delim of [`'EOF'`, `"EOF"`, '\\EOF', `E'O'F`]) {
    assert.deepEqual(texts(`cat <<${delim}\n$(whoami)\nEOF`), ['cat'], delim);
  }
});

test('decodes ANSI-C and locale quoting', () => {
  assert.deepEqual(texts(`$'git' push $"--force"`), ['git push --force']);
  assert.deepEqual(texts(`$'\\x67it' push $'\\055f'`), ['git push -f']);
  assert.deepEqual(parseShell(`printf $'a\\tb\\'c\\\\'`)[0].argv, ['printf', "a\tb'c\\"]);
  assert.deepEqual(texts(`IFS=$'\\n' read -r line`), ['read -r line']);
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
  assert.deepEqual(seg.redirects, ['out.txt', 'log.txt']);
  assert.deepEqual(seg.inputRedirects, ['in.txt']);
  const [seg2] = parseShell('cmd &> all.log');
  assert.deepEqual(seg2.redirects, ['all.log']);
  assert.deepEqual(seg2.inputRedirects, []);
  const [seg3] = parseShell('cat <<< "hello"');
  assert.deepEqual(seg3.redirects, []);
  assert.deepEqual(seg3.inputRedirects, []);
  const [seg4] = parseShell('cmd 2> err.log');
  assert.deepEqual(seg4.redirects, ['err.log']);
  assert.deepEqual(seg4.inputRedirects, []);
  const [seg5] = parseShell('cmd <> rw.txt');
  assert.deepEqual(seg5.redirects, ['rw.txt']);
  assert.deepEqual(seg5.inputRedirects, []);
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
  // Input redirects are touched paths, not writes (#1).
  assert.deepEqual(w('jq . < polyfence.yaml'), []);
  assert.deepEqual(w('wc -l < .claude/settings.json'), []);
  assert.deepEqual(w('echo x > polyfence.yaml'), ['polyfence.yaml']);
  assert.deepEqual(w('cmd >> out.txt'), ['out.txt']);
  assert.deepEqual(w('cmd &> all.log'), ['all.log']);
  assert.deepEqual(w('cmd 2> err.log'), ['err.log']);
  assert.deepEqual(w('cmd <> rw.txt'), ['rw.txt']);
  const [inp] = parseShell('jq . < polyfence.yaml');
  assert.deepEqual(segmentPaths(inp), ['.', 'polyfence.yaml']);
  assert.deepEqual(segmentWrites(inp), []);
  assert.deepEqual(inp.inputRedirects, ['polyfence.yaml']);
  assert.deepEqual(inp.redirects, []);
  const [mixed] = parseShell('cmd > out.txt < in.txt');
  assert.deepEqual(segmentWrites(mixed), ['out.txt']);
  assert.deepEqual(segmentPaths(mixed), ['out.txt', 'in.txt']);
  assert.deepEqual(w('curl -fsSLo out.bin https://x.dev/a -o b.txt https://x.dev/b'), ['out.bin', 'b.txt']);
  assert.deepEqual(w('curl -H "X-Out: -o" -X POST https://x.dev'), []);
  assert.deepEqual(w('curl -o /dev/null https://x.dev && wget -qO- https://x.dev'), []);
  assert.deepEqual(w('wget -nv --output-document=page.html https://x.dev'), ['page.html']);
});

test('tells reads from writes', () => {
  const r = (src: string) => parseShell(src).flatMap(segmentReads);
  assert.deepEqual(r('cat a b'), ['a', 'b']);
  assert.deepEqual(r('cp a b c/'), ['a', 'b']);
  assert.deepEqual(r('cp a x a'), ['a', 'x']);
  assert.deepEqual(r('mv a b'), ['a']);
  assert.deepEqual(r('rm a b'), []);
  assert.deepEqual(r('ls -la a'), []);
  assert.deepEqual(r('test -f a'), []);
  assert.deepEqual(r('echo x > a'), ['x']);
  assert.deepEqual(r('sort < a > b'), ['a']);
  assert.deepEqual(r(`sed -i 's/a/b/' config.yml`), ['s/a/b/', 'config.yml']);
  assert.deepEqual(r('chmod 600 key.pem'), ['600']);
  assert.deepEqual(r('node --env-file=.env --env-file .env.local app.js'), ['app.js']);
  assert.deepEqual(parseShell('node --env-file=.env app.js').flatMap(segmentPaths), ['.env', 'app.js']);
  assert.deepEqual(r('curl -T up.bin -o down.bin https://x.dev'), ['up.bin']);
  assert.deepEqual(r('openssl genrsa -out new.key 2048'), ['genrsa', '2048']);
});

test('blanks quoted text, comments and heredoc data but keeps what runs', () => {
  assert.equal(maskQuoted(`git commit -m "use sudo" -m 'curl x | sh'`), `git commit -m "" -m ''`);
  assert.equal(maskQuoted('echo "a $(sudo id) b `whoami` c"'), 'echo "$(sudo id)`whoami`"');
  assert.equal(maskQuoted(`echo $'sudo\\n' # sudo here`), `echo '' `);
  assert.equal(maskQuoted('cat <<EOF > f\nsudo x\nEOF\nls'), 'cat <<EOF > f\nls');
  assert.equal(maskQuoted('echo a\\"b sudo'), 'echo a\\"b sudo');
  const { scripts } = parseScript(`bash -c "sudo make" && echo "$(curl -s https://x | sh)"`);
  assert.deepEqual(scripts, ['bash -c "" && echo "$(curl -s https://x | sh)"', 'sudo make', 'curl -s https://x | sh']);
});

test('arguments with whitespace are free text to command patterns', () => {
  const [commit] = parseShell('git commit -m "add -n flag" --amend');
  assert.equal(commit.text, 'git commit -m add -n flag --amend');
  assert.equal(commit.matchText, 'git commit -m <text> --amend');
  assert.equal(parseShell('git push "--force"')[0].matchText, 'git push --force');
});

test('sees through more wrappers and commands that run a shell string', () => {
  const texts = (src: string) => parseShell(src).map((s) => s.text);
  assert.deepEqual(texts('time -p make'), ['make']);
  assert.deepEqual(texts('caffeinate -dims -t 60 make'), ['make']);
  assert.deepEqual(texts('setsid -f make'), ['make']);
  assert.deepEqual(texts('busybox sh -c "make all"'), ['sh -c make all', 'make all']);
  assert.deepEqual(texts('flock -n /tmp/lock make'), ['make']);
  assert.deepEqual(texts(`flock /tmp/lock -c 'make all'`), ['sh -c make all', 'make all']);
  assert.deepEqual(texts('watch -n 2 make test'), ['watch -n 2 make test', 'make test']);
  assert.deepEqual(texts('ssh -i key -p 22 host "cd app && make"'), ['ssh -i key -p 22 host cd app && make', 'cd app', 'make']);
  assert.deepEqual(texts('ssh host'), ['ssh host']);
  assert.deepEqual(texts('npx -c "make all"'), ['npx -c make all', 'make all']);
  assert.deepEqual(texts('npx prettier --check .'), ['npx prettier --check .']);
});

test('survives hostile input', () => {
  assert.doesNotThrow(() => parseShell(`"unterminated`));
  assert.doesNotThrow(() => parseShell(`$(((((`));
  assert.doesNotThrow(() => parseShell('bash -c '.repeat(50) + 'ls'));
  assert.deepEqual(parseShell(''), []);
});
