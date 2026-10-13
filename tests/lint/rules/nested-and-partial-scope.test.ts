import { describe, it, expect } from 'vitest';
import { rule as approvedComponent } from '../../../src/lint/rules/approved-component';
import { rule as validNesting } from '../../../src/lint/rules/valid-nesting';
import { node, instanceOf, lint } from '../helpers';

describe('nested instances inside instances (swaps / slots)', () => {
  it('flags an unapproved instance swapped into a governed Column instance', () => {
    const roots = [
      instanceOf('key-column', {
        name: 'Column',
        children: [instanceOf('rogue-key', { name: 'Fancy Button' }, { componentName: 'Fancy Button' })],
      }),
    ];
    const issues = lint(roots, { rules: [approvedComponent] }).result.issues;
    expect(issues.map((i) => i.code)).toEqual(['unapproved-instance']);
  });

  it('does not flag non-instance internal layers of an approved instance', () => {
    const roots = [instanceOf('key-column', { name: 'Column', children: [node({ name: 'Frame 1' })] })];
    expect(lint(roots, { rules: [approvedComponent] }).result.issues).toEqual([]);
  });

  it('can be turned off with checkNestedInstances: false', () => {
    const roots = [
      instanceOf('key-column', { name: 'Column', children: [instanceOf('rogue-key', { name: 'X' })] }),
    ];
    const config = {
      extends: ['figmakit:recommended'],
      rules: { 'divi/approved-component': ['error', { checkNestedInstances: false }] as any },
    };
    expect(lint(roots, { rules: [approvedComponent], config }).result.issues).toEqual([]);
  });

  it('checks nesting of a registered instance swapped into another instance', () => {
    const roots = [instanceOf('key-section', { name: 'Section', children: [instanceOf('key-button', { name: 'Button' })] })];
    const issues = lint(roots, { rules: [validNesting] }).result.issues;
    expect(issues.map((i) => i.code)).toContain('invalid-child');
  });
});

describe('partial selection scope', () => {
  it('does not report $root placement for a Row validated on its own inside a larger frame', () => {
    const row = instanceOf('key-row', { name: 'Row' });
    row.scopeRootIsTopLevel = false;
    expect(lint([row], { rules: [validNesting] }).result.issues).toEqual([]);
  });

  it('still reports a Row placed directly on the page', () => {
    const row = instanceOf('key-row', { name: 'Row' });
    row.scopeRootIsTopLevel = true;
    const issues = lint([row], { rules: [validNesting] }).result.issues;
    expect(issues.map((i) => i.code)).toEqual(['invalid-parent']);
  });
});

import { rule as requiredStates } from '../../../src/lint/rules/required-states';

describe('required-states on nested instances', () => {
  it('flags an invalid variant on a Button swapped into a Column instance', () => {
    const roots = [
      instanceOf('key-column', {
        name: 'Column',
        children: [instanceOf('key-button', { name: 'Button' }, { variantProperties: { Type: 'Ghost' } })],
      }),
    ];
    const issues = lint(roots, { rules: [requiredStates] }).result.issues;
    expect(issues.map((i) => i.code)).toEqual(['invalid-property-value']);
  });
});

describe('library-owned sub-instances (nestedInstanceOrigin)', () => {
  // Section > Row > Column (governsChildren) > library-internal "Divider" instance.
  const tree = (origin: 'library' | 'override' | 'unknown' | undefined) =>
    instanceOf('key-section', {
      name: 'Section',
      children: [
        instanceOf('key-row', {
          name: 'Row',
          children: [
            instanceOf('key-column', {
              name: 'Column',
              children: [instanceOf('lib-internal-divider', { name: 'Divider', nestedInstanceOrigin: origin })],
            }),
          ],
        }),
      ],
    });

  it('never reports a sub-instance proven to be part of the library component', () => {
    const { result, readiness } = lint([tree('library')], { rules: [approvedComponent, validNesting, requiredStates] });
    expect(result.issues).toEqual([]);
    expect(readiness.ready).toBe(true);
  });

  it('reports a swapped sub-instance as confirmed / blocking', () => {
    const { result, readiness } = lint([tree('override')], { rules: [approvedComponent] });
    expect(result.issues.map((i) => `${i.code}:${i.certainty}:${i.severity}`)).toEqual(['unapproved-instance:confirmed:error']);
    expect(readiness.ready).toBe(false);
  });

  it('downgrades to requires-review (non-blocking) when the origin is unknown', () => {
    const { result, readiness } = lint([tree('unknown')], { rules: [approvedComponent] });
    expect(result.issues.map((i) => `${i.code}:${i.certainty}:${i.severity}`)).toEqual(['unapproved-instance:requires-review:info']);
    expect(readiness.ready).toBe(true);
  });

  it('valid-nesting skips library-owned registered sub-instances and downgrades unknown ones', () => {
    const roots = (origin: 'library' | 'unknown') => [
      instanceOf('key-section', { name: 'Section', children: [instanceOf('key-button', { name: 'Button', nestedInstanceOrigin: origin })] }),
    ];
    expect(lint(roots('library'), { rules: [validNesting] }).result.issues).toEqual([]);
    const unknown = lint(roots('unknown'), { rules: [validNesting] }).result.issues;
    expect(unknown.map((i) => `${i.code}:${i.certainty}`)).toContain('invalid-child:requires-review');
    expect(unknown.every((i) => !i.blocking)).toBe(true);
  });

  it('required-states skips library-owned sub-instances', () => {
    const roots = [
      instanceOf('key-column', {
        name: 'Column',
        children: [instanceOf('key-button', { name: 'Button', nestedInstanceOrigin: 'library' }, { variantProperties: { Type: 'Ghost' } })],
      }),
    ];
    expect(lint(roots, { rules: [requiredStates] }).result.issues).toEqual([]);
  });
});
