import { describe, it, expect } from 'vitest';
import { parseVersion, compareVersions, satisfies, isValidRange } from '../../src/lint/semver';

describe('parseVersion', () => {
  it('parses full versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
    expect(parseVersion('v0.1.0-beta.2+build')).toEqual({ major: 0, minor: 1, patch: 0, prerelease: 'beta.2' });
  });
  it('rejects invalid', () => {
    for (const v of ['', '1', '1.2', '01.2.3', 'a.b.c', '1.2.3.4']) expect(parseVersion(v)).toBeNull();
    expect(parseVersion(undefined as unknown as string)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders versions', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
  });
  it('never throws on invalid input', () => {
    expect(compareVersions('junk', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', 'junk')).toBe(1);
  });
});

describe('satisfies', () => {
  const cases: Array<[string, string, boolean]> = [
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['1.2.3', '=1.2.3', true],
    ['1.9.0', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['1.2.2', '^1.2.3', false],
    ['0.2.5', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.2.3', '>=1.2.3', true],
    ['1.2.2', '>=1.2.3', false],
    ['2.0.0', '>1', true],
    ['1.9.9', '>1', false],
    ['1.99.0', '<2.0.0', true],
    ['2.0.0', '<2.0.0', false],
    ['1.5.0', '1.x', true],
    ['2.0.0', '1.x', false],
    ['9.9.9', '*', true],
    ['0.1.0', '>=0.1.0 <2.0.0', true],
    ['2.0.0', '>=0.1.0 <2.0.0', false],
    ['0.0.9', '>=0.1.0 <2.0.0', false],
    ['3.1.0', '^1.0.0 || ^3.0.0', true],
    ['2.1.0', '^1.0.0 || ^3.0.0', false],
    ['1.2.3', '>= 1.2.0', true],
    ['1.2.0', '<=1.2', true],
    ['1.3.0', '<=1.2', false],
    ['1.0.0-beta', '^1.0.0', false],
    ['1.0.0-beta', '>=1.0.0-alpha', true],
  ];
  for (const [v, r, expected] of cases) {
    it(`${v} ${expected ? 'satisfies' : 'does not satisfy'} "${r}"`, () => {
      expect(satisfies(v, r)).toBe(expected);
    });
  }
  it('invalid input → false', () => {
    expect(satisfies('nope', '^1.0.0')).toBe(false);
    expect(satisfies('1.0.0', 'garbage!')).toBe(false);
    expect(satisfies('1.0.0', '')).toBe(false);
    expect(satisfies('1.0.0', '>=a.b')).toBe(false);
  });
  it('isValidRange', () => {
    expect(isValidRange('>=0.1.0 <2.0.0')).toBe(true);
    expect(isValidRange('^1 || 2.x')).toBe(true);
    expect(isValidRange('banana')).toBe(false);
    expect(isValidRange('')).toBe(false);
  });
});
