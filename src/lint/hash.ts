/**
 * Small, dependency-free hashing helpers (Figma sandbox safe: no crypto/Buffer).
 * Used for stable issue ids and report integrity hashes. NOT cryptographic.
 */

/** 32-bit FNV-1a over the UTF-16 code units of `input`, as 8-char lowercase hex. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16);
  return ('00000000' + hex).slice(-8);
}

/**
 * Deterministic JSON: object keys sorted recursively, arrays keep order,
 * undefined / function properties omitted (rendered as null inside arrays,
 * like JSON.stringify). Non-finite numbers render as null.
 */
export function stableStringify(value: unknown): string {
  const out = stringifyValue(value);
  return out === undefined ? 'null' : out;
}

function stringifyValue(value: unknown): string | undefined {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined;
  if (t === 'number') return isFinite(value as number) ? JSON.stringify(value) : 'null';
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (t === 'bigint') return JSON.stringify(String(value));
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const s = stringifyValue(value[i]);
      parts.push(s === undefined ? 'null' : s);
    }
    return '[' + parts.join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  if (typeof (obj as { toJSON?: unknown }).toJSON === 'function') {
    return stringifyValue((obj as { toJSON: () => unknown }).toJSON());
  }
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const s = stringifyValue(obj[k]);
    if (s !== undefined) parts.push(JSON.stringify(k) + ':' + s);
  }
  return '{' + parts.join(',') + '}';
}

/** Stable issue id: 'fk-' + fnv1a(ruleId|code|nodeId|discriminator). */
export function issueId(ruleId: string, code: string, nodeId: string, discriminator?: string): string {
  return 'fk-' + fnv1a([ruleId, code, nodeId, discriminator ?? ''].join('|'));
}
