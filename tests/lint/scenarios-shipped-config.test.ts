import { describe, it, expect } from 'vitest';
import { node, textNode, instanceOf, lint, testRegistry } from './helpers';
import { BUNDLED_CONFIG } from '../../src/lint/config';

describe('shipped config', () => {
  it('a hand-made button (likely recreated) is a blocking error and denies readiness', () => {
    const fake = node({
      name: 'Button', layoutMode: 'HORIZONTAL', width: 105, height: 49,
      padding: { top: 16, right: 24, bottom: 16, left: 24 },
      structural: { role: 'button', confidence: 85, source: 'type' },
      analysis: { role: 'button', confidence: 90, source: 'type' },
      children: [textNode({ name: 'Click me' })],
    });
    const registry = { ...testRegistry(), status: 'approved' as const };
    const out = lint([node({ name: 'Page', children: [fake, instanceOf('key-button', { name: 'Button' }, { variantProperties: { Type: 'Primary' } })] })], { config: BUNDLED_CONFIG, registry });
    const recreated = out.result.issues.filter((i) => i.code === 'recreated-component');
    expect(recreated).toHaveLength(1);
    expect(recreated[0]).toMatchObject({ severity: 'error', certainty: 'likely', blocking: true });
    expect(out.readiness.ready).toBe(false);
  });
});
