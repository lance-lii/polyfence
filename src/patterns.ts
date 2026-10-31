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

const cache = new Map<string, RegExp>();

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/s;

export function isRegexLiteral(pattern: string): boolean {
  return REGEX_LITERAL.test(pattern);
}

function regexLiteral(pattern: string): RegExp | undefined {
  const m = REGEX_LITERAL.exec(pattern);
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

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p.startsWith('$HOME/')) return path.join(os.homedir(), p.slice(6));
  return p;
}

const toPosix = (p: string) => p.split(path.sep).join('/');

export interface PathContext {
  cwd: string;
  root: string;
}

export function resolvePath(p: string, ctx: PathContext): string {
  return toPosix(path.resolve(ctx.cwd, expandHome(p)));
}

export function isInside(abs: string, root: string): boolean {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Does one concrete path match one (non-negated) path glob? */
export function pathMatches(p: string, pattern: string, ctx: PathContext): boolean {
  const abs = resolvePath(p, ctx);
  const lit = regexLiteral(pattern);
  if (lit) return lit.test(abs);
  let glob = pattern.startsWith('./') ? pattern.slice(2) : pattern;
  if (glob.endsWith('/')) glob += '**';
  if (!glob.includes('/')) {
    // Like .gitignore: a bare name matches at any depth.
    const re = memo('base', glob, () => new RegExp('^' + pathGlobSource(glob) + '$'));
    return re.test(abs.slice(abs.lastIndexOf('/') + 1));
  }
  const expanded = toPosix(expandHome(glob));
  if (expanded.startsWith('/')) {
    return memo('abs', expanded, () => new RegExp('^' + pathGlobSource(expanded) + '$')).test(abs);
  }
  const rootAbs = toPosix(path.resolve(ctx.root));
  if (!isInside(abs, rootAbs)) return false;
  const rel = toPosix(path.relative(rootAbs, abs));
  return memo('rel', expanded, () => new RegExp('^' + pathGlobSource(expanded) + '$')).test(rel);
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
