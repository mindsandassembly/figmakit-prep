/**
 * Minimal semver parsing / range matching (subset of node-semver), sandbox safe.
 *
 * Supported range syntax: exact `1.2.3` / `=1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.2.3`, `>1`,
 * `<2.0.0`, `<=1.2`, partials / wildcards (`1`, `1.x`, `1.2.*`, `*`, `x`), space-separated
 * AND of comparators, and `||` OR. Invalid input never throws: it simply does not match.
 *
 * Pre-release versions (1.2.3-beta) only satisfy a comparator set when one of its comparators
 * has a pre-release on the same major.minor.patch (node-semver semantics).
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers joined with '.', or null. */
  prerelease: string | null;
}

const VERSION_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Parse a full semantic version. Returns null when invalid. */
export function parseVersion(v: string): ParsedVersion | null {
  if (typeof v !== 'string') return null;
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] !== undefined ? m[4] : null };
}

function comparePre(a: string | null, b: string | null): -1 | 0 | 1 {
  if (a === b) return 0;
  if (a === null) return 1; // release > pre-release
  if (b === null) return -1;
  const pa = a.split('.');
  const pb = b.split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    if (i >= pa.length) return -1;
    if (i >= pb.length) return 1;
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return +x < +y ? -1 : 1;
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function cmpParsed(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePre(a.prerelease, b.prerelease);
}

/**
 * Compare two versions. Invalid versions sort before valid ones; two invalid
 * versions compare by string order (deterministic, never throws).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa && pb) return cmpParsed(pa, pb);
  if (pa) return 1;
  if (pb) return -1;
  const sa = String(a);
  const sb = String(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

type Op = '<' | '<=' | '>' | '>=' | '=';
interface Comparator {
  op: Op;
  v: ParsedVersion;
}

const PARTIAL_RE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Partial3 {
  major: number | null;
  minor: number | null;
  patch: number | null;
  pre: string | null;
}

function parsePartial(s: string): Partial3 | null {
  const m = PARTIAL_RE.exec(s);
  if (!m) return null;
  const num = (x: string | undefined): number | null => (x === undefined || /^[xX*]$/.test(x) ? null : +x);
  const major = num(m[1]);
  let minor = num(m[2]);
  let patch = num(m[3]);
  // Anything after a wildcard is a wildcard.
  if (major === null) {
    minor = null;
    patch = null;
  } else if (minor === null) {
    patch = null;
  }
  const pre = m[4] !== undefined && patch !== null ? m[4] : null;
  if (m[4] !== undefined && patch === null) return null;
  return { major, minor, patch, pre };
}

function ver(major: number, minor: number, patch: number, pre: string | null = null): ParsedVersion {
  return { major, minor, patch, prerelease: pre };
}

/** Expand one comparator token into primitive comparators. null = invalid. */
function expand(token: string): Comparator[] | null {
  const m = /^(\^|~>?|>=|<=|>|<|=)?(.*)$/.exec(token);
  if (!m) return null;
  const op = m[1] || '';
  const p = parsePartial(m[2]);
  if (!p) return null;
  const { major, minor, patch, pre } = p;

  if (op === '' || op === '=') {
    if (major === null) return [];
    if (minor === null) return [{ op: '>=', v: ver(major, 0, 0) }, { op: '<', v: ver(major + 1, 0, 0) }];
    if (patch === null) return [{ op: '>=', v: ver(major, minor, 0) }, { op: '<', v: ver(major, minor + 1, 0) }];
    return [{ op: '=', v: ver(major, minor, patch, pre) }];
  }
  if (op === '^') {
    if (major === null) return [];
    const lo = ver(major, minor ?? 0, patch ?? 0, pre);
    let hi: ParsedVersion;
    if (major > 0 || minor === null) hi = ver(major + 1, 0, 0);
    else if (minor > 0 || patch === null) hi = ver(0, minor + 1, 0);
    else hi = ver(0, 0, patch + 1);
    return [{ op: '>=', v: lo }, { op: '<', v: hi }];
  }
  if (op === '~' || op === '~>') {
    if (major === null) return [];
    const lo = ver(major, minor ?? 0, patch ?? 0, pre);
    const hi = minor === null ? ver(major + 1, 0, 0) : ver(major, minor + 1, 0);
    return [{ op: '>=', v: lo }, { op: '<', v: hi }];
  }
  if (op === '>=') {
    if (major === null) return [];
    return [{ op: '>=', v: ver(major, minor ?? 0, patch ?? 0, pre) }];
  }
  if (op === '>') {
    if (major === null) return [{ op: '<', v: ver(0, 0, 0) }]; // ">*" matches nothing
    if (minor === null) return [{ op: '>=', v: ver(major + 1, 0, 0) }];
    if (patch === null) return [{ op: '>=', v: ver(major, minor + 1, 0) }];
    return [{ op: '>', v: ver(major, minor, patch, pre) }];
  }
  if (op === '<') {
    if (major === null) return [{ op: '<', v: ver(0, 0, 0) }];
    return [{ op: '<', v: ver(major, minor ?? 0, patch ?? 0, pre) }];
  }
  if (op === '<=') {
    if (major === null) return [];
    if (minor === null) return [{ op: '<', v: ver(major + 1, 0, 0) }];
    if (patch === null) return [{ op: '<', v: ver(major, minor + 1, 0) }];
    return [{ op: '<=', v: ver(major, minor, patch, pre) }];
  }
  return null;
}

function parseRange(range: string): Comparator[][] | null {
  if (typeof range !== 'string') return null;
  const sets = range.split('||');
  const out: Comparator[][] = [];
  for (const raw of sets) {
    // Allow whitespace between operator and version (">= 1.2.3").
    const norm = raw.trim().replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1');
    const tokens = norm === '' ? ['*'] : norm.split(/\s+/);
    const set: Comparator[] = [];
    for (const t of tokens) {
      const c = expand(t);
      if (!c) return null;
      set.push(...c);
    }
    out.push(set);
  }
  return out;
}

/** True when `range` parses as a supported range expression. */
export function isValidRange(range: string): boolean {
  if (typeof range !== 'string' || range.trim() === '') return false;
  return parseRange(range) !== null;
}

function test(c: Comparator, v: ParsedVersion): boolean {
  const r = cmpParsed(v, c.v);
  switch (c.op) {
    case '<': return r < 0;
    case '<=': return r <= 0;
    case '>': return r > 0;
    case '>=': return r >= 0;
    default: return r === 0;
  }
}

/** True when `version` satisfies `range`. Invalid version or range → false. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  if (typeof range !== 'string' || range.trim() === '') return false;
  const sets = parseRange(range);
  if (!sets) return false;
  for (const set of sets) {
    if (!set.every((c) => test(c, v))) continue;
    if (v.prerelease !== null) {
      const allowed = set.some(
        (c) => c.v.prerelease !== null && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch,
      );
      if (!allowed) continue;
    }
    return true;
  }
  return false;
}
