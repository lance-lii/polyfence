/**
 * Pattern compilers. Every pattern is either a glob or a `/regex/flags` literal.
 *
 * - command patterns: anchored glob over a normalized segment (`git push *`).
 *   `*` matches anything, whitespace matches any run of whitespace, and a
 *   trailing ` *` also matches nothing, so `git push *` matches `git push`.
 * - commandLine patterns: unanchored search over the whole raw command.
 * - path patterns: gitignore-flavoured globs (`.env`, `src/**`, `~/.ssh/**`).
 * - url patterns: anchored globs where `*` matches anything.
 *
 * A leading `!` negates a pattern inside a list (see `matchList`).
 */
import os from 'node:os';
import path from 'node:path';

/** macOS and Windows file systems ignore case by default: there `.ENV` is `.env` and `GIT` runs git. */
export const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

const cache = new Map<string, RegExp>();

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/s;
/**
 * Path patterns are often absolute paths (`/etc/hosts`, `/etc/`), so there `/.../flags` is a
 * regex only if the flags are real and the body uses regex syntax: `\`, `^`, `$`, `|`, `(` or `[`.
 */
const PATH_REGEX_LITERAL = /^\/(.*[\\^$|([].*)\/([dgimsuyv]*)$/s;

export function isRegexLiteral(pattern: string): boolean {
  return REGEX_LITERAL.test(pattern);
}

export function isPathRegexLiteral(pattern: string): boolean {
  return PATH_REGEX_LITERAL.test(pattern);
}

/** The RegExp of a `/regex/flags` pattern (throws if it is invalid), or undefined for a glob. */
export function regexLiteral(pattern: string, forPath = false): RegExp | undefined {
  const m = (forPath ? PATH_REGEX_LITERAL : REGEX_LITERAL).exec(pattern);
  return m ? new RegExp(m[1], m[2]) : undefined;
}

function memo(kind: string, pattern: string, build: () => RegExp): RegExp {
  const key = kind + '\0' + pattern;
  let re = cache.get(key);
  if (!re) {
    re = build();
    cache.set(key, re);
  }
  return re;
}

/** Glob body for commands: `*` -> `.*`, `?` -> `.`, whitespace -> `\s+`. */
export function commandGlobSource(glob: string): string {
  let src = '';
  let rest = glob.trim();
  let optionalTail = false;
  if (/\s\*$/.test(rest)) {
    rest = rest.replace(/\s+\*$/, '');
    optionalTail = true;
  }
  for (const ch of rest) {
    if (ch === '*') src += '.*';
    else if (ch === '?') src += '.';
    else if (/\s/.test(ch)) src += src.endsWith('\\s+') ? '' : '\\s+';
    else src += escapeRe(ch);
  }
  return src + (optionalTail ? '(?:\\s.*)?' : '');
}

export function commandRegex(pattern: string): RegExp {
  return memo('cmd', pattern, () => regexLiteral(pattern) ?? new RegExp('^' + commandGlobSource(pattern) + '$', 's'));
}

export function commandLineRegex(pattern: string): RegExp {
  return memo('line', pattern, () => regexLiteral(pattern) ?? new RegExp(commandGlobSource(pattern), 's'));
}

export function urlRegex(pattern: string): RegExp {
  return memo('url', pattern, () => {
    const lit = regexLiteral(pattern);
    if (lit) return lit;
    const body = pattern
      .split('*')
      .map((part) => escapeRe(part).replace(/\?/g, '.'))
      .join('.*');
    return new RegExp('^' + body + '$', 'i');
  });
}

/** Path glob to a regex source (no anchors). Supports `**`, `*`, `?`, `{a,b}`. */
export function pathGlobSource(glob: string): string {
  let src = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        src += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 3 : 2;
        continue;
      }
      src += '[^/]*';
    } else if (ch === '?') {
      src += '[^/]';
    } else if (ch === '{') {
      const close = glob.indexOf('}', i);
      if (close === -1) {
        src += '\\{';
      } else {
        const alts = glob.slice(i + 1, close).split(',').map(pathGlobSource);
        src += '(?:' + alts.join('|') + ')';
        i = close + 1;
        continue;
      }
    } else {
      src += escapeRe(ch);
    }
    i++;
  }
  return src;
}

/** What path handling depends on: the separator rules, the home directory and whether names fold case. */
export interface Platform {
  path: path.PlatformPath;
  home: string;
  caseInsensitive: boolean;
}

/** The machine polyfence runs on. */
export const HOST: Platform = {
  path,
  get home() {
    return os.homedir();
  },
  caseInsensitive: CASE_INSENSITIVE,
};

const isWindows = (pf: Platform) => pf.path.sep === '\\';
const DRIVE = /^[a-zA-Z]:/;
/** Paths are compared with forward slashes on every platform. */
const toPosix = (p: string, pf: Platform) => (isWindows(pf) ? p.replace(/\\/g, '/') : p);

export function expandHome(p: string, pf: Platform = HOST): string {
  if (p === '~' || p === '$HOME' || p === '${HOME}') return pf.home;
  if (p.startsWith('~/')) return pf.path.join(pf.home, p.slice(2));
  if (p.startsWith('$HOME/')) return pf.path.join(pf.home, p.slice(6));
  if (p.startsWith('${HOME}/')) return pf.path.join(pf.home, p.slice(8));
  return p;
}

export interface PathContext {
  cwd: string;
  root: string;
  /** Defaults to the host; tests pass another to check Windows or POSIX behaviour anywhere. */
  platform?: Platform;
}

export function resolvePath(p: string, ctx: PathContext): string {
  const pf = ctx.platform ?? HOST;
  let target = expandHome(p, pf);
  // Git Bash, the usual shell for agents on Windows, writes C:\Users as /c/Users.
  if (isWindows(pf)) target = target.replace(/^\/([a-zA-Z])\//, '$1:/');
  return toPosix(pf.path.resolve(ctx.cwd, target), pf);
}

export function isInside(abs: string, root: string, pf: Platform = HOST): boolean {
  const lower = (s: string) => (pf.caseInsensitive ? s.toLowerCase() : s);
  const rel = pf.path.relative(lower(root), lower(abs));
  return rel === '' || (!rel.startsWith('..') && !pf.path.isAbsolute(rel));
}

/** Does one concrete path match one (non-negated) path glob? */
export function pathMatches(p: string, pattern: string, ctx: PathContext): boolean {
  const pf = ctx.platform ?? HOST;
  const flags = pf.caseInsensitive ? 'i' : '';
  const compiled = (kind: string, glob: string) => memo(kind + flags, glob, () => new RegExp('^' + pathGlobSource(glob) + '$', flags));
  const abs = resolvePath(p, ctx);
  const lit = regexLiteral(pattern, true);
  if (lit) return lit.test(abs);
  let glob = pattern.startsWith('./') ? pattern.slice(2) : pattern;
  if (glob.endsWith('/')) glob += '**';
  if (!glob.includes('/')) {
    // Like .gitignore: a bare name matches at any depth.
    return compiled('base', glob).test(abs.slice(abs.lastIndexOf('/') + 1));
  }
  const expanded = toPosix(expandHome(glob, pf), pf);
  if (expanded.startsWith('/')) {
    // On Windows a pattern without a drive letter (`/etc/hosts`) applies on every drive.
    return compiled('abs', expanded).test(isWindows(pf) ? abs.replace(DRIVE, '') : abs);
  }
  if (isWindows(pf) && DRIVE.test(expanded)) return compiled('abs', expanded).test(abs);
  const rootAbs = toPosix(pf.path.resolve(ctx.root), pf);
  if (!isInside(abs, rootAbs, pf)) return false;
  const lower = (s: string) => (pf.caseInsensitive ? s.toLowerCase() : s);
  const rel = toPosix(pf.path.relative(lower(rootAbs), lower(abs)), pf);
  return compiled('rel', expanded).test(rel);
}

/**
 * Evaluate a pattern list against a set of values. A value matches the list when
 * it matches at least one positive pattern and no `!negated` pattern. The list
 * matches when any value does.
 */
export function matchList(values: string[], patterns: string[], test: (value: string, pattern: string) => boolean): boolean {
  const positive = patterns.filter((p) => !p.startsWith('!'));
  const negative = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  return values.some((v) => positive.some((p) => test(v, p)) && !negative.some((p) => test(v, p)));
}
