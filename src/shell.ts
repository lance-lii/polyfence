/**
 * A small, dependency-free shell parser. It does not try to be bash; it tries to
 * see every command a shell string would run, so a rule for `git push --force`
 * still fires on `cd app && FOO=1 sudo bash -c "git -C . push -f"`.
 *
 * Handles: quoting and escapes, `&& || ; | &` and newlines, redirects, heredocs,
 * `$(...)`, backticks, process substitution, `bash -c`/`sh -c`/`eval`, and
 * wrappers such as `sudo`, `env`, `VAR=1`, `timeout`, `nohup` and `xargs`.
 */
import type { Segment } from './types.js';

const MAX_DEPTH = 6;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const PREFIX_KEYWORDS = new Set(['then', 'else', 'elif', 'do', 'if', 'while', 'until', '!', '{', 'time']);
const DROP_SEGMENT = new Set(['for', 'case', 'select', 'function', 'fi', 'done', 'esac', '}', ';;']);

interface RawSeg {
  words: string[];
  redirects: string[];
}

interface Heredoc {
  delim: string;
  strip: boolean;
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
    const inner = innerScript(seg.argv);
    if (inner !== undefined) collect(inner, depth + 1, out);
  }
  for (const n of nested) collect(n, depth + 1, out);
}

function tokenize(src: string, nested: string[]): RawSeg[] {
  const segs: RawSeg[] = [];
  const heredocs: Heredoc[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let word = '';
  let inWord = false;
  let pending: 'redirect' | 'heredoc' | 'herestring' | null = null;
  let heredocStrip = false;
  const n = src.length;
  let i = 0;

  const endWord = () => {
    if (!inWord) return;
    if (pending === 'redirect') redirects.push(word);
    else if (pending === 'heredoc') heredocs.push({ delim: word, strip: heredocStrip });
    else if (pending !== 'herestring') words.push(word);
    pending = null;
    word = '';
    inWord = false;
  };
  const endSeg = () => {
    endWord();
    if (words.length || redirects.length) segs.push({ words, redirects });
    words = [];
    redirects = [];
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
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? n : end;
      word += src.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      inWord = true;
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
      i++;
      if (src[i] === '>' || src[i] === '|' || (c === '<' && src[i] === '>')) i++;
      if (src[i] === '&') {
        i++;
        let j = i;
        while (j < n && /[0-9-]/.test(src[j])) j++;
        if (j > i) {
          i = j; // fd duplication like 2>&1: no file target
          continue;
        }
      }
      pending = 'redirect';
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

function skipHeredocs(src: string, start: number, docs: Heredoc[]): number {
  let i = start;
  for (const doc of docs) {
    while (i < src.length) {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      let line = src.slice(i, end);
      if (doc.strip) line = line.replace(/^\t+/, '');
      i = end + 1;
      if (line.trim() === doc.delim) break;
    }
  }
  return Math.min(i, src.length);
}

function basename(word: string): string {
  const idx = word.lastIndexOf('/');
  return idx === -1 || idx === word.length - 1 ? word : word.slice(idx + 1);
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
    const w = basename(a[0]);
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
  if (a.length && a[0].includes('/')) a[0] = basename(a[0]);
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
  if (!argv.length && !raw.redirects.length) return undefined;
  return { argv, rawArgv: raw.words, redirects: raw.redirects, text: argv.join(' ') };
}

/** Script text run by `bash -c "..."`, `sh -lc '...'` or `eval ...`, if any. */
function innerScript(argv: string[]): string | undefined {
  if (!argv.length) return undefined;
  if (argv[0] === 'eval') return argv.slice(1).join(' ');
  if (!SHELLS.has(argv[0])) return undefined;
  for (let i = 1; i < argv.length; i++) {
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(argv[i])) return argv[i + 1];
    if (!argv[i].startsWith('-')) return undefined;
  }
  return undefined;
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
  return out;
}

export function segmentUrls(seg: Segment): string[] {
  return seg.argv.filter((a) => /^https?:\/\//i.test(a));
}

const MUTATORS_ALL = new Set(['rm', 'rmdir', 'unlink', 'shred', 'mv', 'tee', 'truncate', 'touch', 'mkdir']);
const MUTATORS_LAST = new Set(['cp', 'ln', 'install', 'rsync', 'scp']);
const MUTATORS_SKIP_FIRST = new Set(['chmod', 'chown', 'chgrp']);

/** Paths a segment modifies: redirect targets plus arguments of well-known mutating commands. */
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
  }
  return out.filter((p) => !URL_RE.test(p));
}
