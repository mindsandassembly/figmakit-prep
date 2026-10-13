import { describe, it, expect } from 'vitest';
import { componentRef } from '../../../src/lint/rules/where';
import { validateRegistry } from '../../../src/lint/registry';
import bundled from '../../../src/standards/registry.json';

describe('componentRef (designer-facing component pointer)', () => {
  const base = { id: 'divi-button', name: 'Divi Button', diviType: null, figmaComponentKeys: ['k'] };
  it('names the Figma component and where to find it', () => {
    expect(componentRef({ ...base, figma: { componentName: 'button 1', location: 'Assets panel → Local components' } }))
      .toBe('Divi Button ("button 1" in Assets panel → Local components)');
  });
  it('falls back to the registry name', () => {
    expect(componentRef(base)).toBe('Divi Button');
  });
  it('the shipped registry is valid and points designers at "button 1"', () => {
    expect(validateRegistry(bundled).filter((d) => d.level === 'error')).toEqual([]);
    expect((bundled as any).components[0].figma.componentName).toBe('button 1');
  });
  it('rejects a malformed figma field', () => {
    const reg = { version: '1.0.0', designSystem: 'X', status: 'approved', components: [{ ...base, figma: { componentName: 3 } }] };
    expect(validateRegistry(reg).map((d) => d.code)).toContain('invalid-field');
  });
});
