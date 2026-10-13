import { describe, it, expect } from 'vitest';
import { fnv1a, stableStringify, issueId } from '../../src/lint/hash';

describe('fnv1a', () => {
  it('matches known FNV-1a 32-bit vectors', () => {
    expect(fnv1a('')).toBe('811c9dc5');
    expect(fnv1a('a')).toBe('e40c292c');
    expect(fnv1a('foobar')).toBe('bf9cf968');
  });
  it('is always 8 lowercase hex chars', () => {
    for (const s of ['x', 'hello world', 'ünïcødé', '1234567890'.repeat(50)]) {
      expect(fnv1a(s)).toMatch(/^[0-9a-f]{8}$/);
    }
  });
  it('is deterministic and input-sensitive', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });
});

describe('stableStringify', () => {
  it('sorts object keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });
  it('keeps array order and omits undefined props', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
    expect(stableStringify({ a: undefined, b: null })).toBe('{"b":null}');
    expect(stableStringify([undefined, 1])).toBe('[null,1]');
  });
  it('handles primitives and non-finite numbers', () => {
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(true)).toBe('true');
    expect(stableStringify(NaN)).toBe('null');
    expect(stableStringify(undefined)).toBe('null');
  });
});

describe('issueId', () => {
  it('is fk- + fnv1a of the joined parts', () => {
    expect(issueId('r', 'c', 'n', 'd')).toBe('fk-' + fnv1a('r|c|n|d'));
    expect(issueId('r', 'c', 'n')).toBe('fk-' + fnv1a('r|c|n|'));
  });
  it('differs by discriminator', () => {
    expect(issueId('r', 'c', 'n', 'a')).not.toBe(issueId('r', 'c', 'n', 'b'));
  });
});
