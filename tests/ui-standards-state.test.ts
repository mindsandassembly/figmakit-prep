/**
 * Stateful Standards-tab behavior (ui-standards.ts) driven through a minimal fake DOM.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Fake = {
  posted: any[];
  els: Record<string, any>;
  click(action: string, issueId?: string): void;
  button(id: string): void;
  ui: typeof import('../src/ui-standards');
};

async function setup(locked = false): Promise<Fake> {
  vi.resetModules();
  const els: Record<string, any> = {};
  const get = (id: string) => {
    if (!els[id]) {
      const listeners: Record<string, (e?: any) => void> = {};
      els[id] = {
        id, innerHTML: '', textContent: '', value: '', disabled: false, title: '', style: {}, listeners,
        addEventListener(type: string, fn: (e?: any) => void) { listeners[type] = fn; },
        classList: { add() {}, remove() {} },
        getAttribute() { return null; },
      };
    }
    return els[id];
  };
  (globalThis as any).document = {
    getElementById: get,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const ui = await import('../src/ui-standards');
  const posted: any[] = [];
  ui.setLockedBuildForTests(locked);
  ui.initStandardsUI({ post: (m: any) => posted.push(m), setStatus: () => {} });
  const panel = els['panel-standards'];
  const click = (action: string, issueId?: string) => {
    const item = { getAttribute: (n: string) => (n === 'data-issue-id' ? issueId ?? null : null) };
    const actionEl = {
      getAttribute: (n: string) => (n === 'data-std-action' ? action : null),
      closest: (sel: string) => (sel === '[data-issue-id]' ? item : null),
    };
    const target = { closest: (sel: string) => (sel === '[data-std-action]' ? actionEl : null) };
    panel.listeners.click({ target });
  };
  const button = (id: string) => els[id].listeners.click();
  return { posted, els, click, button, ui };
}

const SCOPE = { type: 'page', pageId: '0:1', pageName: 'Home', rootNodeIds: ['1:1'], rootNodeNames: ['Home'] };

function spacingIssue(from: number, to: number): any {
  return {
    id: 'fk-spacing', ruleId: 'divi/approved-tokens', code: 'off-scale-spacing', nodeId: '1:1', nodeName: 'Card',
    nodePath: 'Card', severity: 'warning', certainty: 'confirmed', message: 'Padding left', fixable: true, blocking: false,
    discriminator: 'paddingLeft',
    fix: { kind: 'REQUIRES_CONFIRMATION', description: `Set ${from}→${to}`, operations: [{ op: 'setNumber', nodeId: '1:1', property: 'paddingLeft', from, to }] },
  };
}

function result(issues: any[], extra: Record<string, any> = {}): any {
  return {
    type: 'standards-result',
    result: { issues, totals: { errors: 0, warnings: issues.length, infos: 0, passedChecks: 1 }, ruleSummaries: [] },
    readiness: { ready: true, status: 'READY', reasons: [], blockingIssues: [], exceptedIssues: [], warnings: [] },
    scope: SCOPE,
    registry: { version: '1.0.0', designSystem: 'Divi 5', status: 'draft', source: 'bundled' },
    rulesetVersion: '1.0.0',
    diagnostics: { config: [], registry: [], exceptions: [] },
    ...extra,
  };
}

function preview(key: string): any {
  return { type: 'standards-fix-preview', mode: 'selected', operations: [{ issueId: 'fk-spacing', kind: 'REQUIRES_CONFIRMATION', description: key, key: 'fk-spacing|' + key }], skipped: [], requiresConfirmation: true };
}

let f: Fake;
beforeEach(async () => {
  f = await setup();
});

describe('fix confirmation is bound to the preview', () => {
  it('sends the previewed operation keys with the confirmation', () => {
    f.ui.handleStandardsUIMessage(result([spacingIssue(13, 12)]));
    f.click('fix', 'fk-spacing');
    f.ui.handleStandardsUIMessage(preview('Set paddingLeft 13px → 12px'));
    f.click('confirm-fix', 'fk-spacing');
    const apply = f.posted.filter((m) => m.type === 'standards-apply-fixes');
    expect(apply).toEqual([{
      type: 'standards-apply-fixes', mode: 'selected', issueIds: ['fk-spacing'], confirmed: true,
      expectedOperations: ['fk-spacing|Set paddingLeft 13px → 12px'],
    }]);
  });

  it('new results close an open preview, so an old preview cannot confirm a new fix', () => {
    f.ui.handleStandardsUIMessage(result([spacingIssue(13, 12)]));
    f.click('fix', 'fk-spacing');
    f.ui.handleStandardsUIMessage(preview('Set paddingLeft 13px → 12px'));
    // Re-run: same issue id, different value / fix.
    f.ui.handleStandardsUIMessage(result([spacingIssue(31, 32)]));
    f.click('confirm-fix', 'fk-spacing');
    expect(f.posted.filter((m) => m.type === 'standards-apply-fixes')).toEqual([]);
  });

  it('does not confirm while results are stale', () => {
    f.ui.handleStandardsUIMessage(result([spacingIssue(13, 12)]));
    f.click('fix', 'fk-spacing');
    f.ui.handleStandardsUIMessage(preview('Set paddingLeft 13px → 12px'));
    f.ui.onStandardsDocumentChanged();
    f.click('confirm-fix', 'fk-spacing');
    expect(f.posted.filter((m) => m.type === 'standards-apply-fixes')).toEqual([]);
  });
});

describe('validated scope', () => {
  it('shows the scope and re-sends it with Mark Ready and Export', () => {
    f.ui.handleStandardsUIMessage(result([]));
    expect(f.els['std-header'].innerHTML).toContain('Validated: <strong>Whole page “Home”</strong>');
    f.button('std-mark-ready');
    expect(f.posted.find((m) => m.type === 'standards-mark-ready')).toEqual({ type: 'standards-mark-ready', scope: SCOPE });
    f.ui.handleStandardsUIMessage({ type: 'standards-mark-ready-result', ok: true, status: 'READY' });
    f.button('std-export');
    expect(f.posted.find((m) => m.type === 'standards-export')).toEqual({ type: 'standards-export', rerun: false, scope: SCOPE });
  });

  it('scopeLabel describes selections', () => {
    expect(f.ui.scopeLabel({ type: 'selection', pageName: 'P', rootNodeIds: ['a'], rootNodeNames: ['Hero'] })).toBe('Selected layer “Hero” on page “P”');
    expect(f.ui.scopeLabel({ type: 'selection', pageName: 'P', rootNodeIds: ['a', 'b'], rootNodeNames: ['A', 'B'] })).toBe('2 selected layers on page “P”');
    expect(f.ui.scopeLabel(null)).toBeNull();
  });
});

describe('standards-state after save / reset', () => {
  it('header and registry notice follow the saved standards, not the previous run', () => {
    f.ui.handleStandardsUIMessage(result([]));
    expect(f.els['std-registry-notice'].innerHTML).toContain('DRAFT');
    f.ui.handleStandardsUIMessage({ type: 'standards-config-saved', ok: true, diagnostics: {} });
    f.ui.handleStandardsUIMessage({
      type: 'standards-state', designSystem: 'Divi 5', registryVersion: '2.0.0', registryStatus: 'approved',
      registrySource: 'document', rulesetVersion: '1.0.0', configSource: 'bundled', rules: [],
      diagnostics: { config: [], registry: [], exceptions: [] },
    });
    expect(f.els['std-header'].innerHTML).toContain('Registry: <strong>2.0.0</strong> (approved, document)');
    expect(f.els['std-registry-notice'].innerHTML).toBe('');
  });

  it('renders exception diagnostics from standards-state when there is no current run', () => {
    f.ui.handleStandardsUIMessage({
      type: 'standards-state', designSystem: 'Divi 5', registryVersion: '1.0.0', registryStatus: 'approved', rules: [],
      diagnostics: { config: [], registry: [], exceptions: [{ level: 'error', code: 'invalid-json', message: 'Exceptions data is not valid JSON.' }] },
    });
    expect(f.els['std-diagnostics'].innerHTML).toContain('exceptions: Exceptions data is not valid JSON.');
  });
});

describe('locked designer build', () => {
  it('opens straight into a validation run with no settings or diagnostics', async () => {
    const g = await setup(true);
    expect(g.posted.map((m) => m.type)).toEqual(['standards-init', 'standards-run']);
    expect(g.els['std-settings'].style.display).toBe('none');
    g.ui.handleStandardsUIMessage(result([], {
      registry: { version: '0.1.0', designSystem: 'Divi 5', status: 'draft', source: 'bundled' },
      diagnostics: { config: [], registry: [{ level: 'warning', code: 'unresolved-key', message: 'placeholder' }], exceptions: [] },
    }));
    expect(g.els['std-diagnostics'].innerHTML).toBe('');
    expect(g.els['std-registry-notice'].innerHTML).toContain('Contact your design-system admin');
  });

  it('the shipped config is the locked build', async () => {
    const g = await setup(false);
    const cfg = (await import('../src/standards/figmakit.config.json')).default as any;
    expect(cfg.adminTools).toBe(false);
    expect(typeof g.ui.LOCKED_BUILD).toBe('boolean');
  });
});
