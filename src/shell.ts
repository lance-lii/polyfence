/**
 * A small, dependency-free shell parser. It does not try to be bash; it tries to
 * see every command a shell string would run, so a rule for `git push --force`
 * still fires on `cd app && FOO=1 sudo bash -c "git -C . push -f"`.
 *
 * Handles: quoting and escapes, `&& || ; | &` and newlines, redirects, heredocs,
 * `$(...)`, backticks, process substitution, `bash -c`/`sh -c`/`eval`, and
 * wrappers such as `sudo`, `env`, `VAR=1`, `timeout`, `nohup` and `xargs`.
 */
import { CASE_INSENSITIVE } from './patterns.js';
import type { Segment } from './types.js';

const MAX_DEPTH = 6;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const PREFIX_KEYWORDS = new Set(['then', 'else', 'elif', 'do', 'if', 'while', 'until', '!', '{', 'time']);
const DROP_SEGMENT = new Set(['for', 'case', 'select', 'function', 'fi', 'done', 'esac', '}', ';;']);

interface RawSeg {
  words: string[];
  /** Output redirect targets (`>`, `>>`, `&>`, `<>`, ...). */
  redirects: string[];
  /** Input redirect targets (`<`). */
  inputRedirects: string[];
  /** Heredoc bodies and herestrings fed to the command. */
  stdin: string[];
}

interface Heredoc {
  delim: string;
  strip: boolean;
  /** Any quoting in the delimiter (`'EOF'`, `\EOF`) makes the body literal. */
  quoted?: boolean;
  /** stdin of the segment the heredoc feeds. */
  stdin?: string[];
  body?: string;
}

export function parseShell(src: string): Segment[] {
  const out: Segment[] = [];
  collect(src, 0, out);
  return out;
}

function collect(src: string, depth: number, out: Segment[]): void {
  if (depth > MAX_DEPTH || !src.trim()) return;
  const nested: string[] = [];
  for (const raw of tokenize(src, nested)) {
    const seg = normalize(raw);
    if (!seg) continue;
    out.push(seg);
    for (const inner of innerScript(seg.argv, raw.stdin)) collect(inner, depth + 1, out);
  }
  for (const n of nested) collect(n, depth + 1, out);
}

function tokenize(src: string, nested: string[]): RawSeg[] {
  const segs: RawSeg[] = [];
  const heredocs: Heredoc[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let inputRedirects: string[] = [];
  let stdin: string[] = [];
  let word = '';
  let inWord = false;
  let quoted = false;
  let pending: 'redirect' | 'input-redirect' | 'heredoc' | 'herestring' | null = null;
  let heredocStrip = false;
  const n = src.length;
  let i = 0;

  const endWord = () => {
    if (!inWord) return;
    if (pending === 'redirect') redirects.push(word);
    else if (pending === 'input-redirect') inputRedirects.push(word);
    else if (pending === 'heredoc') heredocs.push({ delim: word, strip: heredocStrip, quoted, stdin });
    else if (pending === 'herestring') stdin.push(word);
    else words.push(word);
    pending = null;
    word = '';
    inWord = false;
    quoted = false;
  };
  const endSeg = () => {
    endWord();
    if (words.length || redirects.length || inputRedirects.length) {
      segs.push({ words, redirects, inputRedirects, stdin });
    }
    words = [];
    redirects = [];
    inputRedirects = [];
    stdin = [];
    pending = null;
  };
  const substitution = (start: number): number => {
    const [inner, next] = readParen(src, start);
    if (!inner.startsWith('(')) nested.push(inner); // `$((...))` is arithmetic
    return next;
  };

  while (i < n) {
    const c = src[i];

    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (i + 1 < n) word += src[i + 1];
      inWord = true;
      quoted = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? n : end;
      word += src.slice(i + 1, stop);
      inWord = true;
      quoted = true;
      i = stop + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      // ANSI-C quoting: $'\x67it' is `git`.
      let end = i + 2;
      while (end < n && src[end] !== "'") end += src[end] === '\\' ? 2 : 1;
      word += ansiC(src.slice(i + 2, Math.min(end, n)));
      inWord = true;
      quoted = true;
      i = end + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '"') {
      i++; // bash: $"..." is a (translated) double-quoted string
      continue;
    }
    if (c === '"') {
      inWord = true;
      quoted = true;
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n && '"\\$`\n'.includes(src[i + 1])) {
          if (src[i + 1] !== '\n') word += src[i + 1];
          i += 2;
        } else if (src[i] === '$' && src[i + 1] === '(') {
          const next = substitution(i + 1);
          word += src.slice(i, next);
          i = next;
        } else if (src[i] === '`') {
          const [inner, next] = readBacktick(src, i);
          nested.push(inner);
          word += src.slice(i, next);
          i = next;
        } else {
          word += src[i++];
        }
      }
      i++;
      continue;
    }
    if (c === '`') {
      const [inner, next] = readBacktick(src, i);
      nested.push(inner);
      word += src.slice(i, next);
      inWord = true;
      i = next;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      const next = substitution(i + 1);
      word += src.slice(i, next);
      inWord = true;
      i = next;
      continue;
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(' && !inWord) {
      const [inner, next] = readParen(src, i + 1);
      nested.push(inner);
      i = next;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    if (c === '\n') {
      endSeg();
      i++;
      if (heredocs.length) {
        i = skipHeredocs(src, i, heredocs);
        for (const doc of heredocs) {
          doc.stdin?.push(doc.body ?? '');
          if (!doc.quoted) bodySubstitutions(doc.body ?? '', nested);
        }
        heredocs.length = 0;
      }
      continue;
    }
    if (c === '&' && src[i + 1] === '>') {
      endWord();
      i += src[i + 2] === '>' ? 3 : 2;
      pending = 'redirect';
      continue;
    }
    if (c === '(' && inWord) {
      word += c;
      i++;
      continue;
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endSeg();
      i++;
      if ((c === '&' || c === '|') && (src[i] === c || (c === '|' && src[i] === '&'))) i++;
      else if (c === ';' && src[i] === ';') i++;
      continue;
    }
    if (c === '<' || c === '>') {
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else {
        endWord();
      }
      if (c === '<' && src[i + 1] === '<') {
        if (src[i + 2] === '<') {
          i += 3;
          pending = 'herestring';
          continue;
        }
        i += 2;
        heredocStrip = src[i] === '-';
        if (heredocStrip) i++;
        pending = 'heredoc';
        continue;
      }
      // `<>` opens read/write — treat as an output redirect so writePath still fires.
      const readWrite = c === '<' && src[i + 1] === '>';
      i++;
      if (src[i] === '>' || src[i] === '|' || readWrite) i++;
      if (src[i] === '&') {
        i++;
        let j = i;
        while (j < n && /[0-9-]/.test(src[j])) j++;
        if (j > i) {
          i = j; // fd duplication like 2>&1: no file target
          continue;
        }
      }
      pending = c === '<' && !readWrite ? 'input-redirect' : 'redirect';
      continue;
    }

    word += c;
    inWord = true;
    i++;
  }
  endSeg();
  return segs;
}

/** `open` points at `(`. Returns the text between the parens and the index after `)`. */
function readParen(src: string, open: number): [string, number] {
  const n = src.length;
  const docs: Heredoc[] = [];
  let depth = 0;
  let i = open;
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      i = e === -1 ? n : e + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      let j = i + 2;
      const strip = src[j] === '-';
      if (strip) j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      const m = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(src.slice(j));
      if (m) {
        docs.push({ delim: m[2], strip });
        i = j + m[0].length;
        continue;
      }
    }
    if (c === '\n' && docs.length) {
      i = skipHeredocs(src, i + 1, docs);
      docs.length = 0;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return [src.slice(open + 1, i), i + 1];
    }
    i++;
  }
  return [src.slice(open + 1), n];
}

function readBacktick(src: string, open: number): [string, number] {
  let i = open + 1;
  while (i < src.length && src[i] !== '`') i += src[i] === '\\' ? 2 : 1;
  return [src.slice(open + 1, i), Math.min(i + 1, src.length)];
}

/** Skips each heredoc body, keeping its text in `doc.body`. */
function skipHeredocs(src: string, start: number, docs: Heredoc[]): number {
  let i = start;
  for (const doc of docs) {
    const lines: string[] = [];
    while (i < src.length) {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      let line = src.slice(i, end);
      if (doc.strip) line = line.replace(/^\t+/, '');
      i = end + 1;
      if (line.trim() === doc.delim) break;
      lines.push(line);
    }
    doc.body = lines.join('\n');
  }
  return Math.min(i, src.length);
}

/** `$(...)` and backticks in an unquoted heredoc body run while the shell expands it. */
function bodySubstitutions(body: string, nested: string[]): void {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') i++;
    else if (body[i] === '$' && body[i + 1] === '(') {
      const [inner, next] = readParen(body, i + 1);
      if (!inner.startsWith('(')) nested.push(inner); // `$((...))` is arithmetic
      i = next - 1;
    } else if (body[i] === '`') {
      const [inner, next] = readBacktick(body, i);
      nested.push(inner);
      i = next - 1;
    }
  }
}

const ANSI_C: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

/** Decodes the body of `$'...'`; unknown escapes stay as they are, like bash. */
function ansiC(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c[\s\S]|[\s\S])/g, (all, e: string) => {
    if (/^[xuU]./.test(e)) {
      const code = parseInt(e.slice(1), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8) & 0xff);
    if (e.length === 2 && e[0] === 'c') return String.fromCharCode(e.charCodeAt(1) & 0x1f);
    return ANSI_C[e] ?? all;
  });
}

function basename(word: string): string {
  const idx = word.lastIndexOf('/');
  return idx === -1 || idx === word.length - 1 ? word : word.slice(idx + 1);
}

/** The command a word runs: `/usr/bin/GIT` is git where file names ignore case. */
function commandName(word: string): string {
  return CASE_INSENSITIVE ? basename(word).toLowerCase() : basename(word);
}

function skipFlags(args: string[], withValue: Set<string>): string[] {
  let i = 0;
  while (i < args.length && args[i].startsWith('-') && args[i] !== '-') {
    if (args[i] === '--') return args.slice(i + 1);
    i += withValue.has(args[i]) ? 2 : 1;
  }
  return args.slice(i);
}

const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-h', '-p', '-C', '-U', '-r', '-t', '-D', '--user', '--group']);
const ENV_VALUE_FLAGS = new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']);
const NICE_VALUE_FLAGS = new Set(['-n', '--adjustment']);
const TIMEOUT_VALUE_FLAGS = new Set(['-s', '-k', '--signal', '--kill-after']);
const XARGS_VALUE_FLAGS = new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '--max-args', '--max-procs']);
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

export function stripWrappers(argv: string[]): string[] {
  let a = [...argv];
  for (let guard = 0; guard < 32 && a.length; guard++) {
    if (ASSIGN.test(a[0]) || PREFIX_KEYWORDS.has(a[0])) {
      a.shift();
      continue;
    }
    const w = commandName(a[0]);
    if (w === 'sudo' || w === 'doas') a = skipFlags(a.slice(1), SUDO_VALUE_FLAGS);
    else if (w === 'env') a = skipFlags(a.slice(1), ENV_VALUE_FLAGS);
    else if (w === 'command' || w === 'builtin' || w === 'exec' || w === 'nohup' || w === 'stdbuf' || w === 'unbuffer')
      a = skipFlags(a.slice(1), new Set());
    else if (w === 'nice' || w === 'ionice') a = skipFlags(a.slice(1), NICE_VALUE_FLAGS);
    else if (w === 'timeout' || w === 'gtimeout') {
      a = skipFlags(a.slice(1), TIMEOUT_VALUE_FLAGS);
      a.shift();
    } else if (w === 'xargs') a = skipFlags(a.slice(1), XARGS_VALUE_FLAGS);
    else break;
  }
  if (a.length) a[0] = commandName(a[0]);
  if (a[0] === 'git') a = ['git', ...stripGitGlobals(a.slice(1))];
  return a;
}

function stripGitGlobals(args: string[]): string[] {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const flag = args[i];
    if (GIT_VALUE_FLAGS.has(flag)) i += 2;
    else i += 1;
  }
  return args.slice(i);
}

function normalize(raw: RawSeg): Segment | undefined {
  if (raw.words.length && DROP_SEGMENT.has(raw.words[0])) return undefined;
  const argv = stripWrappers(raw.words);
  if (!argv.length && !raw.redirects.length && !raw.inputRedirects.length) return undefined;
  return {
    argv,
    rawArgv: raw.words,
    redirects: raw.redirects,
    inputRedirects: raw.inputRedirects,
    text: argv.join(' '),
  };
}

const SHELL_VALUE_FLAGS = new Set(['--rcfile', '--init-file']);

/**
 * Scripts run by `bash -c "..."`, `sh -lc '...'`, `eval ...` or a shell reading a heredoc.
 * Options come first (`-o pipefail`, `+e`, `--norc`). With `-c` the first operand is the
 * script; with `-s`, or with no operand at all, the shell runs its stdin.
 */
function innerScript(argv: string[], stdin: string[]): string[] {
  if (!argv.length) return [];
  if (argv[0] === 'eval') return [argv.slice(1).join(' ')];
  if (!SHELLS.has(argv[0])) return [];
  let command = false;
  let fromStdin = false;
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--' || a === '-') {
      i++;
      break;
    }
    if (/^[-+][a-zA-Z]+$/.test(a)) {
      if (a[0] === '-' && a.includes('c')) command = true;
      if (a[0] === '-' && a.includes('s')) fromStdin = true;
      if (/[oO]/.test(a)) i++; // `-o pipefail`, `+O extglob`: the option name is the next word
    } else if (a.startsWith('--')) {
      if (SHELL_VALUE_FLAGS.has(a)) i++;
    } else break;
  }
  if (command) return i < argv.length ? [argv[i]] : [];
  return fromStdin || i >= argv.length ? stdin : [];
}

const DEVICE = /^\/dev\/(null|stdout|stderr|stdin|tty|fd\/\d+)$/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Path-like arguments and redirect targets of a segment. */
export function segmentPaths(seg: Segment): string[] {
  const out: string[] = [];
  for (const arg of seg.argv.slice(1)) {
    let value = arg;
    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      if (eq === -1) continue;
      value = arg.slice(eq + 1);
    }
    if (value && !URL_RE.test(value) && !DEVICE.test(value)) out.push(value);
  }
  for (const r of seg.redirects) if (!DEVICE.test(r)) out.push(r);
  for (const r of seg.inputRedirects) if (!DEVICE.test(r)) out.push(r);
  return out;
}

export function segmentUrls(seg: Segment): string[] {
  return seg.argv.filter((a) => /^https?:\/\//i.test(a));
}

const MUTATORS_ALL = new Set(['rm', 'rmdir', 'unlink', 'shred', 'mv', 'tee', 'truncate', 'touch', 'mkdir']);
const MUTATORS_LAST = new Set(['cp', 'ln', 'install', 'rsync', 'scp']);
const MUTATORS_SKIP_FIRST = new Set(['chmod', 'chown', 'chgrp']);

/** Paths a segment modifies: output-redirect targets plus arguments of well-known mutating commands. */
export function segmentWrites(seg: Segment): string[] {
  const out = seg.redirects.filter((r) => !DEVICE.test(r));
  const [cmd, ...rest] = seg.argv;
  const operands = rest.filter((a) => !a.startsWith('-'));
  if (MUTATORS_ALL.has(cmd)) out.push(...operands);
  else if (MUTATORS_LAST.has(cmd) && operands.length) out.push(operands[operands.length - 1]);
  else if (MUTATORS_SKIP_FIRST.has(cmd)) out.push(...operands.slice(1));
  else if (cmd === 'dd') {
    for (const a of rest) if (a.startsWith('of=')) out.push(a.slice(3));
  } else if ((cmd === 'sed' || cmd === 'perl') && rest.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
    out.push(...operands.slice(1));
  } else if (cmd === 'curl' || cmd === 'wget') {
    out.push(...downloadOutputs(cmd, rest));
  }
  return out.filter((p) => !URL_RE.test(p));
}

/** Short options that take a value, so `-sSo file` and `-Ho` split the way curl and wget do. */
const DOWNLOAD_VALUE_FLAGS = { curl: 'AbcCdDeEFhHKmoPQrtTuUwxXyYz', wget: 'aABDeiIlnoOPQRtTUwX' };
const DOWNLOAD_OUTPUT = { curl: ['o', '--output'], wget: ['O', '--output-document'] };

/** Files written by `curl -o FILE` and `wget -O FILE` (`-` is stdout). */
function downloadOutputs(cmd: 'curl' | 'wget', args: string[]): string[] {
  const [short, long] = DOWNLOAD_OUTPUT[cmd];
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === long) out.push(args[++i] ?? '');
    else if (a.startsWith(`${long}=`)) out.push(a.slice(long.length + 1));
    else if (/^-[^-]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        if (!DOWNLOAD_VALUE_FLAGS[cmd].includes(a[j])) continue;
        const value = j + 1 < a.length ? a.slice(j + 1) : args[++i];
        if (a[j] === short && value !== undefined) out.push(value);
        break;
      }
    }
  }
  return out.filter((f) => f && f !== '-' && !DEVICE.test(f));
}
