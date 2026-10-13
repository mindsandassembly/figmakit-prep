/**
 * Scenario integration tests (DESIGN spec scenarios A–I).
 *
 * Realistic RAW Figma mock trees (tests/lint/fixtures/landing-page.ts) go through the real
 * pipeline: buildDesignTree(createMockResolver) → resolveConfig(ALL_RULES) → loadRegistry
 * (approved fixture registry) → runLint → evaluateReadiness. No DesignNode is hand-built here.
 */

import { describe, it, expect } from 'vitest';
import { ALL_RULES } from '../../src/lint/rules/index';
import { createException } from '../../src/lint/exceptions';
import { issueId } from '../../src/lint/hash';
import { planFixes } from '../../src/lint/autofix';
import { INTERNAL_ERROR_RULE_ID } from '../../src/lint/types';
import type { IssueException, LintConfig, LintRule } from '../../src/lint/types';
import {
  IDS,
  approvedLandingPage,
  cardRow,
  customLayout,
  detachedArea,
  marketingStory,
  newsletter,
  announcementSection,
  pageWithMisplacedButton,
  pageWithRecreatedButton,
  promoStrip,
} from './fixtures/landing-page';
import { KEYS } from './fixtures/registry';
import { RECOMMENDED, STRICT, SCENARIO_NOW, allNodes, brief, issuesOn, runScenario } from './fixtures/pipeline';

const STRUCTURE_RULES = [
  'divi/approved-component',
  'divi/valid-nesting',
  'divi/detached-component',
  'divi/semantic-mapping',
];

function withRules(base: LintConfig, rules: LintConfig['rules']): LintConfig {
  return { ...base, rules: { ...(base.rules ?? {}), ...rules } };
}

// ---------------------------------------------------------------------------
// Fixture sanity
// ---------------------------------------------------------------------------

describe('fixtures go through the real snapshot', () => {
  it('resolves library instances via getMainComponentAsync (variant → component set) and marks internals', async () => {
    const run = await runScenario([approvedLandingPage()]);
    const byId = new Map(allNodes(run.roots).map((n) => [n.id, n]));

    const primary = byId.get(IDS.heroPrimary)!;
    expect(primary.type).toBe('INSTANCE');
    expect(primary.instance!.mainComponent).toMatchObject({
      key: KEYS.buttonPrimary,
      componentSetKey: KEYS.buttonSet,
      componentSetName: 'Divi Button',
      remote: true,
    });
    expect(primary.instance!.componentProperties).toMatchObject({ Type: 'Primary', Label: 'Get started' });
    expect(primary.insideInstance).toBe(true); // swapped into the Column slot
    expect(primary.path).toEqual(['Home — Desktop', 'Hero', 'Hero Row', 'Copy Column', 'Copy Stack', 'Actions', 'Button']);

    const label = byId.get(IDS.heroPrimary + ';label')!;
    expect(label.insideInstance).toBe(true);
    expect(label.instanceAncestorId).toBe(IDS.heroPrimary);

    // Top-level page frame sits on a PAGE.
    expect(run.roots[0].scopeRootIsTopLevel).toBe(true);
    // Hidden layers are not part of the snapshot.
    for (const hidden of [IDS.heroHiddenRogue, IDS.hiddenDraft, IDS.hiddenOffScale]) expect(byId.has(hidden)).toBe(false);
    expect(run.nodeCount).toBe(byId.size);
  });

  it('fixture registry is approved and loads without diagnostics errors', async () => {
    const run = await runScenario([approvedLandingPage()]);
    expect(run.registry.status).toBe('approved');
    expect(run.result.registryDiagnostics.filter((d) => d.level !== 'info')).toEqual([]);
    expect(run.result.configDiagnostics.filter((d) => d.level === 'error')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A — only approved components
// ---------------------------------------------------------------------------

describe('Scenario A: approved landing page', () => {
  it('recommended: zero issues, every rule passes, READY', async () => {
    const run = await runScenario([approvedLandingPage()]);
    expect(brief(run.result.issues)).toEqual([]);
    expect(run.result.internalErrors).toEqual([]);
    expect(run.readiness.status).toBe('READY');
    expect(run.readiness.ready).toBe(true);
    expect(run.readiness.reasons).toEqual([]);
    expect(run.readiness.blockingIssues).toEqual([]);
    expect(run.result.totals.checks).toBeGreaterThan(0);
    for (const s of run.result.ruleSummaries) {
      expect(s.status, s.ruleId).toBe('passed');
      expect(s.errorCount).toBe(0);
    }
    // Rules that should have seen something actually did.
    const checks = Object.fromEntries(run.result.ruleSummaries.map((s) => [s.ruleId, s.checks]));
    expect(checks['divi/approved-component']).toBeGreaterThan(10);
    expect(checks['divi/valid-nesting']).toBeGreaterThan(10);
  });

  it('strict: still zero blocking issues and READY', async () => {
    const run = await runScenario([approvedLandingPage()], { config: STRICT });
    expect(brief(run.readiness.blockingIssues)).toEqual([]);
    expect(run.readiness.status).toBe('READY');
  });
});

// ---------------------------------------------------------------------------
// B — manually recreated button
// ---------------------------------------------------------------------------

describe('Scenario B: manually recreated button', () => {
  it('recommended: "Button" frame is a likely recreated Divi Button (non-blocking warning); "Frame 12" pill is not flagged', async () => {
    const run = await runScenario([pageWithRecreatedButton()]);
    const issues = issuesOn(run, IDS.recreatedButton);
    expect(brief(issues)).toEqual([
      `divi/detached-component:recreated-component@${IDS.recreatedButton}(Button)[warning/likely]`,
    ]);
    const issue = issues[0];
    expect(issue.blocking).toBe(false);
    expect(issue.fixable).toBe(false);
    expect(issue.fix?.kind).toBe('UNSUPPORTED');
    expect(issue.data?.componentId).toBe('divi-button');
    expect(issue.data?.evidence).toEqual(['name', 'structure']);
    expect(issue.message).toMatch(/heuristic/i);
    expect(issue.message).toContain('Divi Button');
    expect(issue.suggestion).toContain('Divi Button');
    expect(issue.nodePath).toBe('Home — Desktop / Promo Strip / Button');

    expect(issuesOn(run, IDS.recreatedPill)).toEqual([]);
    // Nothing else on the page is affected.
    expect(brief(run.result.issues)).toEqual(brief(issues));
    expect(run.readiness.status).toBe('READY');
    expect(run.readiness.warnings.map((i) => i.id)).toEqual([issue.id]);
  });

  it('strict: "Frame 12" is flagged as requires-review on structure alone (reportStructureOnly)', async () => {
    const run = await runScenario([pageWithRecreatedButton()], { config: STRICT });
    const pill = issuesOn(run, IDS.recreatedPill);
    expect(pill).toHaveLength(1);
    expect(pill[0]).toMatchObject({
      ruleId: 'divi/detached-component',
      code: 'recreated-component',
      certainty: 'requires-review',
      severity: 'warning', // strict maps requires-review → warning
      blocking: false,
    });
    expect(pill[0].data?.evidence).toEqual(['structure']);
    expect(pill[0].message).toMatch(/heuristic/i);

    // The named recreation becomes an error under strict (likely → error).
    const btn = issuesOn(run, IDS.recreatedButton);
    expect(btn.map((i) => [i.code, i.certainty, i.severity, i.blocking])).toEqual([['recreated-component', 'likely', 'error', true]]);
  });
});

// ---------------------------------------------------------------------------
// C — approved component in an invalid location
// ---------------------------------------------------------------------------

describe('Scenario C: approved Button directly inside a Section', () => {
  it('reports a confirmed, blocking valid-nesting error and nothing else', async () => {
    const run = await runScenario([pageWithMisplacedButton()]);
    expect(brief(run.result.issues)).toEqual([
      `divi/valid-nesting:invalid-child@${IDS.misplacedButton}(Button)[error/confirmed]`,
    ]);
    const issue = run.result.issues[0];
    expect(issue.message).toBe('Divi Button is not allowed inside Divi Section.');
    expect(issue.expected).toBe('Divi Row');
    expect(issue.actual).toBe('Divi Button');
    expect(issue.blocking).toBe(true);
    expect(issue.data).toMatchObject({ componentId: 'divi-button', parentComponentId: 'divi-section', parentNodeId: '30:1' });
    expect(issue.nodePath).toBe('Home — Desktop / Announcement / Button');

    // The approved instance itself is fine (approved-component passes).
    expect(issuesOn(run, IDS.misplacedButton, 'divi/approved-component')).toEqual([]);
    expect(run.readiness.status).toBe('NOT_READY');
    expect(run.readiness.blockingIssues.map((i) => i.id)).toEqual([issue.id]);
  });

  it('partial selection of a correctly nested Column/Row yields no "$root" placement errors', async () => {
    const page = pageWithMisplacedButton();
    const hero = page.children.find((c: any) => c.id === IDS.heroSection);
    const heroRow = hero.children.find((c: any) => c.id === IDS.heroRow);
    const copyCol = heroRow.children.find((c: any) => c.id === IDS.heroCopyCol);
    for (const selection of [[heroRow], [copyCol], [heroRow, copyCol]]) {
      const run = await runScenario(selection);
      expect(run.roots[0].scopeRootIsTopLevel).toBe(false);
      expect(brief(run.result.issues)).toEqual([]);
      expect(run.readiness.status).toBe('READY');
    }
  });
});

// ---------------------------------------------------------------------------
// D — legitimate custom layouts
// ---------------------------------------------------------------------------

describe('Scenario D: legitimate custom layouts', () => {
  for (const [label, config] of [['recommended', RECOMMENDED], ['strict', STRICT]] as const) {
    it(`${label}: approved instances inside plain, unusually nested auto-layout frames raise no component/structure issues`, async () => {
      const run = await runScenario([customLayout(), cardRow()], { config });
      const structural = run.result.issues.filter((i) => STRUCTURE_RULES.indexOf(i.ruleId) !== -1);
      expect(brief(structural)).toEqual([]);
      expect(brief(run.result.issues)).toEqual([]);
      expect(run.readiness.status).toBe('READY');
      // Top-level approved instances are fully checked (states, layout, naming).
      const checks = Object.fromEntries(run.result.ruleSummaries.map((s) => [s.ruleId, s.checks]));
      expect(checks['divi/required-states']).toBeGreaterThanOrEqual(5);
      expect(checks['divi/auto-layout']).toBeGreaterThanOrEqual(5);
    });
  }

  it('a top-level approved Button with a disallowed variant value is still caught (required-states)', async () => {
    const layout = customLayout();
    const left = layout.children.find((c: any) => c.id === IDS.leftStack);
    const row = left.children.find((c: any) => c.id === IDS.buttonRow);
    const alt = row.children.find((c: any) => c.id === IDS.leftCtaAlt);
    alt.variantProperties = { Type: 'Ghost', State: 'Default' };
    alt.componentProperties = { ...alt.componentProperties, Type: { type: 'VARIANT', value: 'Ghost' } };
    const run = await runScenario([layout]);
    expect(brief(run.result.issues)).toEqual([
      `divi/required-states:invalid-property-value@${IDS.leftCtaAlt}(Button)[error/confirmed]`,
    ]);
    expect(run.result.issues[0].expected).toBe('Primary, Secondary');
  });

  it('metadata-declared Blurb frame is treated as a registered component (no recreation report)', async () => {
    const run = await runScenario([cardRow()]);
    const declared = allNodes(run.roots).find((n) => n.id === IDS.declaredBlurb)!;
    expect(declared.standardsMeta.componentId).toBe('divi-blurb');
    expect(issuesOn(run, IDS.declaredBlurb)).toEqual([]);
  });

  it('custom marketing composition of plain text/images: no blocking issues (informational review only)', async () => {
    const run = await runScenario([marketingStory()]);
    expect(run.readiness.blockingIssues).toEqual([]);
    expect(run.readiness.status).toBe('READY');
    for (const i of run.result.issues) {
      expect(i.blocking, brief([i])[0]).toBe(false);
      expect(i.severity).not.toBe('error');
      expect(['divi/approved-component', 'divi/valid-nesting', 'divi/detached-component']).not.toContain(i.ruleId);
    }
    // The explicitly labelled testimonial is surfaced as a (non-blocking) mapping warning.
    expect(brief(issuesOn(run, IDS.testimonial))).toEqual([
      `divi/semantic-mapping:unmapped-label@${IDS.testimonial}(Testimonial)[warning/confirmed]`,
    ]);
    // Plain text / image leaves are never flagged by structure rules.
    for (const id of [IDS.storyHeading, IDS.storyBody, IDS.storyPhoto, IDS.storyQuoteText]) {
      expect(issuesOn(run, id)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// E — detached components
// ---------------------------------------------------------------------------

describe('Scenario E: detached components', () => {
  it('distinguishes confirmed (library / local) detaches, heuristic recreations and unregistered detaches', async () => {
    const run = await runScenario([detachedArea()]);

    // (1) detachedInfo library key in registry → confirmed error.
    const lib = issuesOn(run, IDS.detachedLibrary);
    expect(brief(lib)).toEqual([`divi/detached-component:detached-approved@${IDS.detachedLibrary}(Button)[error/confirmed]`]);
    expect(lib[0].blocking).toBe(true);
    expect(lib[0].message).toBe('Detached from approved component Divi Button.');
    expect(lib[0].data).toMatchObject({ componentId: 'divi-button', matchedKey: KEYS.buttonSet, detachedType: 'library' });
    expect(lib[0].fix?.kind).toBe('UNSUPPORTED');

    // (2) detachedInfo local componentId resolved via the resolver → confirmed error.
    const local = issuesOn(run, IDS.detachedLocal);
    expect(brief(local)).toEqual([`divi/detached-component:detached-approved@${IDS.detachedLocal}(Signup CTA)[error/confirmed]`]);
    expect(local[0].data).toMatchObject({ componentId: 'divi-button', matchedKey: KEYS.buttonSet, detachedType: 'local' });

    // (3) no detachedInfo, name + structure → likely (warning under recommended).
    const recreated = issuesOn(run, IDS.recreatedBtn);
    expect(brief(recreated)).toEqual([`divi/detached-component:recreated-component@${IDS.recreatedBtn}(Btn)[warning/likely]`]);
    expect(recreated[0].data?.evidence).toEqual(['name', 'structure']);

    // (4) detachedInfo for an unregistered component → info only.
    const unreg = issuesOn(run, IDS.detachedUnregistered);
    expect(brief(unreg)).toEqual([
      `divi/detached-component:detached-unregistered@${IDS.detachedUnregistered}(Badge)[info/confirmed]`,
    ]);
    expect(unreg[0].blocking).toBe(false);
    expect(unreg[0].data).toMatchObject({ detachedType: 'library', componentKey: KEYS.rogueBadge });

    // Confirmed detaches carry a registry identity, so their other rules pass (Button layout etc.).
    expect(run.result.issues).toHaveLength(4);
    expect(run.readiness.status).toBe('NOT_READY');
    expect(run.readiness.blockingIssues.map((i) => i.nodeId).sort()).toEqual([IDS.detachedLibrary, IDS.detachedLocal].sort());
  });

  it('a local detach whose component cannot be resolved is not claimed as an approved detach', async () => {
    const area = detachedArea();
    const local = area.children.find((c: any) => c.id === IDS.detachedLocal);
    local.detachedInfo = { type: 'local', componentId: '999:1' }; // deleted local component
    const run = await runScenario([area]);
    const issues = issuesOn(run, IDS.detachedLocal);
    expect(issues.map((i) => i.code)).toEqual(['detached-unregistered']);
    expect(issues[0].severity).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// F — off-scale spacing
// ---------------------------------------------------------------------------

describe('Scenario F: off-scale spacing (23px padding)', () => {
  it('recommended: approved-tokens warning with a confirm-to-apply 23→24 fix; page stays READY', async () => {
    const run = await runScenario([approvedLandingPage([newsletter(23)])]);
    expect(brief(run.result.issues)).toEqual([
      `divi/approved-tokens:off-scale-spacing@${IDS.newsletter}(Newsletter)[warning/confirmed]`,
    ]);
    const issue = run.result.issues[0];
    expect(issue.expected).toBe('md (24px)');
    expect(issue.actual).toBe('23px');
    expect(issue.blocking).toBe(false);
    expect(issue.fixable).toBe(true);
    expect(issue.fix).toMatchObject({
      kind: 'REQUIRES_CONFIRMATION',
      operations: [{ op: 'setNumber', nodeId: IDS.newsletter, property: 'paddingTop', from: 23, to: 24 }],
    });
    expect(issue.id).toBe(issueId('divi/approved-tokens', 'off-scale-spacing', IDS.newsletter, 'paddingTop'));
    expect(run.readiness.status).toBe('READY');

    // Never applied by "Fix safe issues"; only when explicitly selected.
    expect(planFixes(run.result.issues, 'safe').operations).toEqual([]);
    expect(planFixes(run.result.issues, 'selected', [issue.id]).operations.map((o) => o.op)).toEqual(issue.fix!.operations);
  });

  it("config 'divi/approved-tokens': 'error' makes it a blocking error", async () => {
    const run = await runScenario([approvedLandingPage([newsletter(23)])], {
      config: withRules(RECOMMENDED, { 'divi/approved-tokens': 'error' }),
    });
    expect(brief(run.result.issues)).toEqual([
      `divi/approved-tokens:off-scale-spacing@${IDS.newsletter}(Newsletter)[error/confirmed]`,
    ]);
    expect(run.result.issues[0].blocking).toBe(true);
    expect(run.result.issues[0].fix?.kind).toBe('REQUIRES_CONFIRMATION');
    expect(run.readiness.status).toBe('NOT_READY');
  });

  it('on-scale spacing (24px) produces no token issue', async () => {
    const run = await runScenario([approvedLandingPage([newsletter(24)])]);
    expect(run.result.issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// G — readiness denied
// ---------------------------------------------------------------------------

describe('Scenario G: blocking errors deny readiness', () => {
  it('lists every unexcepted blocking issue and explains why', async () => {
    const run = await runScenario([pageWithMisplacedButton(), detachedArea(), newsletter(23)]);
    const blocking = run.result.issues.filter((i) => i.blocking);
    expect(blocking.map((i) => `${i.code}@${i.nodeId}`).sort()).toEqual(
      [
        `invalid-child@${IDS.misplacedButton}`,
        `detached-approved@${IDS.detachedLibrary}`,
        `detached-approved@${IDS.detachedLocal}`,
      ].sort(),
    );
    expect(run.readiness.ready).toBe(false);
    expect(run.readiness.status).toBe('NOT_READY');
    expect(run.readiness.blockingIssues.map((i) => i.id).sort()).toEqual(blocking.map((i) => i.id).sort());
    expect(run.readiness.reasons).toEqual(['3 blocking issues must be fixed or excepted.']);
    // Warnings are reported separately and never block.
    const warningIds = run.readiness.warnings.map((i) => i.nodeId).sort();
    expect(warningIds).toEqual([IDS.recreatedBtn, IDS.newsletter].sort());
  });
});

// ---------------------------------------------------------------------------
// H — exceptions
// ---------------------------------------------------------------------------

describe('Scenario H: authorized exceptions', () => {
  const approvedBy = { id: 'figma-user-1042', name: 'Dana Lead' };
  const nestingException = (extra: { expiresAt?: string } = {}): IssueException =>
    createException({
      ruleId: 'divi/valid-nesting',
      nodeId: IDS.misplacedButton,
      code: 'invalid-child',
      reason: 'Announcement bar CTA approved by design system team (DS-218).',
      approvedBy,
      createdAt: '2026-02-01T09:00:00.000Z',
      ...extra,
    });

  it('an exception covering the only blocking issue → READY_WITH_EXCEPTIONS', async () => {
    const ex = nestingException({ expiresAt: '2026-12-31T00:00:00.000Z' });
    const run = await runScenario([pageWithMisplacedButton()], { exceptions: [ex] });
    expect(run.result.issues).toHaveLength(1);
    expect(run.result.issues[0].exception).toEqual(ex);
    expect(run.readiness.ready).toBe(true);
    expect(run.readiness.status).toBe('READY_WITH_EXCEPTIONS');
    expect(run.readiness.blockingIssues).toEqual([]);
    expect(run.readiness.exceptedIssues.map((i) => i.nodeId)).toEqual([IDS.misplacedButton]);
    expect(run.readiness.reasons).toEqual([]);
  });

  it('exceptions.enabled = false → NOT_READY', async () => {
    const run = await runScenario([pageWithMisplacedButton()], {
      exceptions: [nestingException()],
      config: { ...RECOMMENDED, exceptions: { enabled: false } },
    });
    expect(run.readiness.status).toBe('NOT_READY');
    expect(run.readiness.exceptedIssues).toEqual([]);
    expect(run.readiness.blockingIssues.map((i) => i.nodeId)).toEqual([IDS.misplacedButton]);
  });

  it('rule listed in nonExemptRules → NOT_READY', async () => {
    const run = await runScenario([pageWithMisplacedButton()], {
      exceptions: [nestingException()],
      config: { ...RECOMMENDED, exceptions: { nonExemptRules: ['divi/valid-nesting'] } },
    });
    expect(run.readiness.status).toBe('NOT_READY');
    expect(run.readiness.exceptedIssues).toEqual([]);
    expect(run.readiness.blockingIssues).toHaveLength(1);
  });

  it('expired exception → NOT_READY', async () => {
    const run = await runScenario([pageWithMisplacedButton()], {
      exceptions: [nestingException({ expiresAt: '2026-02-15T00:00:00.000Z' })],
      now: SCENARIO_NOW,
    });
    expect(run.result.issues[0].exception).toBeUndefined();
    expect(run.readiness.status).toBe('NOT_READY');
  });

  it('an exception for a different code or node does not cover the issue', async () => {
    const wrongCode = createException({
      ruleId: 'divi/valid-nesting',
      nodeId: IDS.misplacedButton,
      code: 'invalid-parent',
      reason: 'x',
      approvedBy,
      createdAt: '2026-02-01T09:00:00.000Z',
    });
    const wrongNode = createException({
      ruleId: 'divi/valid-nesting',
      nodeId: IDS.heroPrimary,
      reason: 'x',
      approvedBy,
      createdAt: '2026-02-01T09:00:00.000Z',
    });
    const run = await runScenario([pageWithMisplacedButton()], { exceptions: [wrongCode, wrongNode] });
    expect(run.readiness.status).toBe('NOT_READY');
  });

  it('only covers its own issue: other blocking issues still deny readiness', async () => {
    const run = await runScenario([pageWithMisplacedButton(), detachedArea()], { exceptions: [nestingException()] });
    expect(run.readiness.exceptedIssues.map((i) => i.nodeId)).toEqual([IDS.misplacedButton]);
    expect(run.readiness.blockingIssues).toHaveLength(2);
    expect(run.readiness.status).toBe('NOT_READY');
  });
});

// ---------------------------------------------------------------------------
// I — crashing rule
// ---------------------------------------------------------------------------

function crashingRule(id: string, where: 'validate' | 'appliesTo'): LintRule {
  return {
    meta: {
      id,
      description: 'Test rule that throws on button instances.',
      category: 'components',
      defaultSeverity: 'error',
      defaultOptions: {},
      fixable: false,
    },
    appliesTo(node) {
      const isButton = node.type === 'INSTANCE' && node.name === 'Button';
      if (where === 'appliesTo' && isButton) throw new Error('appliesTo exploded');
      return isButton;
    },
    validate() {
      throw new TypeError("Cannot read properties of undefined (reading 'variant')");
    },
  };
}

describe('Scenario I: a rule that throws', () => {
  for (const where of ['validate', 'appliesTo'] as const) {
    it(`${where} crash → internal error issues, rule 'crashed', other rules unaffected, NOT_READY`, async () => {
      const crashing = crashingRule('test/crashy-' + where, where);
      const rules = ALL_RULES.concat([crashing]);
      const run = await runScenario([approvedLandingPage([newsletter(23)])], { rules });

      const internal = run.result.internalErrors;
      expect(internal.length).toBeGreaterThan(0);
      expect(internal.length).toBeLessThanOrEqual(25);
      for (const i of internal) {
        expect(i.ruleId).toBe(INTERNAL_ERROR_RULE_ID);
        expect(i.code).toBe('rule-crashed');
        expect(i.severity).toBe('error');
        expect(i.blocking).toBe(true);
        expect(i.data?.failedRule).toBe(crashing.meta.id);
        expect(run.result.issues).toContainEqual(i);
      }
      expect(internal.some((i) => i.nodeId === IDS.heroPrimary)).toBe(true);

      const summary = run.result.ruleSummaries.find((s) => s.ruleId === crashing.meta.id)!;
      expect(summary.status).toBe('crashed');
      expect(summary.errorCount).toBeGreaterThan(0);
      expect(summary.firstError).toBeTruthy();

      // Other rules keep working: the off-scale spacing warning is still reported.
      expect(brief(run.result.issues.filter((i) => i.ruleId !== INTERNAL_ERROR_RULE_ID))).toEqual([
        `divi/approved-tokens:off-scale-spacing@${IDS.newsletter}(Newsletter)[warning/confirmed]`,
      ]);
      for (const s of run.result.ruleSummaries) if (s.ruleId !== crashing.meta.id) expect(s.status, s.ruleId).not.toBe('crashed');

      expect(run.readiness.ready).toBe(false);
      expect(run.readiness.status).toBe('NOT_READY');
      expect(run.readiness.reasons.join(' ')).toContain(crashing.meta.id);
    });
  }

  it('crash on an otherwise clean page still denies readiness and cannot be excepted', async () => {
    const crashing = crashingRule('test/crashy', 'validate');
    const clean = await runScenario([approvedLandingPage()], { rules: ALL_RULES.concat([crashing]) });
    expect(clean.result.issues.every((i) => i.ruleId === INTERNAL_ERROR_RULE_ID)).toBe(true);
    const first = clean.result.internalErrors[0];

    const ex: IssueException = createException({
      ruleId: INTERNAL_ERROR_RULE_ID,
      nodeId: first.nodeId,
      reason: 'please let me ship',
      approvedBy: { id: null, name: 'Someone' },
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    const run = await runScenario([approvedLandingPage()], { rules: ALL_RULES.concat([crashing]), exceptions: [ex] });
    expect(run.result.internalErrors.every((i) => i.exception === undefined)).toBe(true);
    expect(run.readiness.status).toBe('NOT_READY');
    expect(run.readiness.exceptedIssues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting guarantees
// ---------------------------------------------------------------------------

/** One document with every scenario on it: the landing page plus extra top-level frames. */
function everything(): any[] {
  return [
    approvedLandingPage([announcementSection(), promoStrip()]),
    customLayout(),
    cardRow(),
    marketingStory(),
    detachedArea(),
    newsletter(23),
  ];
}

describe('determinism and stable ids', () => {
  it('fixture layer ids are unique within a document (as in real Figma)', () => {
    const seen = new Map<string, number>();
    const visit = (n: any): void => {
      seen.set(n.id, (seen.get(n.id) ?? 0) + 1);
      (n.children ?? []).forEach(visit);
    };
    everything().forEach(visit);
    expect([...seen.entries()].filter(([, c]) => c > 1)).toEqual([]);
    expect(seen.size).toBeGreaterThan(100);
  });

  it('two runs over freshly built trees are deep-equal (snapshot, result, readiness)', async () => {
    for (const config of [RECOMMENDED, STRICT]) {
      const a = await runScenario(everything(), { config });
      const b = await runScenario(everything(), { config });
      expect(a.result.issues.length).toBeGreaterThan(5);
      expect(b.roots).toEqual(a.roots);
      expect(b.result).toEqual(a.result);
      expect(b.readiness).toEqual(a.readiness);
      expect(JSON.stringify(b.result)).toBe(JSON.stringify(a.result));
    }
  });

  it('issue ids are stable across runs and unaffected by unrelated content', async () => {
    const alone = await runScenario([pageWithMisplacedButton()]);
    const crowded = await runScenario(everything());
    const id = issueId('divi/valid-nesting', 'invalid-child', IDS.misplacedButton);
    expect(alone.result.issues.map((i) => i.id)).toEqual([id]);
    expect(crowded.result.issues.filter((i) => i.nodeId === IDS.misplacedButton).map((i) => i.id)).toEqual([id]);

    // Ids are unique within a run.
    const ids = crowded.result.issues.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('issues are ordered by layer order (pre-order), then rule id', async () => {
    const run = await runScenario(everything());
    const order = new Map(allNodes(run.roots).map((n) => [n.id, n.order]));
    const keys = run.result.issues.map((i) => [order.get(i.nodeId)!, i.ruleId] as const);
    const sorted = keys.slice().sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
    expect(keys).toEqual(sorted);
  });
});

describe('hidden layers', () => {
  it('are ignored by default (hidden unapproved instance, hidden recreated button, hidden off-scale frame)', async () => {
    const run = await runScenario([approvedLandingPage()]);
    for (const id of [IDS.heroHiddenRogue, IDS.hiddenDraft, IDS.hiddenOffScale]) {
      expect(issuesOn(run, id)).toEqual([]);
    }
    expect(run.readiness.status).toBe('READY');
  });

  it('are linted when settings.includeHidden is on (proves the fixtures would otherwise be flagged)', async () => {
    const run = await runScenario([approvedLandingPage()], { config: { ...RECOMMENDED, settings: { includeHidden: true } } });
    expect(issuesOn(run, IDS.heroHiddenRogue).map((i) => i.code)).toEqual(['unapproved-instance']);
    expect(issuesOn(run, IDS.hiddenDraft).map((i) => i.code)).toEqual(['recreated-component']);
    expect(issuesOn(run, IDS.hiddenOffScale).map((i) => i.code)).toEqual(['off-scale-spacing']);
    expect(run.readiness.status).toBe('NOT_READY');
  });
});

describe('ordinary internal layers are never flagged', () => {
  for (const [label, config] of [['recommended', RECOMMENDED], ['strict', STRICT]] as const) {
    it(`${label}: text inside approved instances, internal wrappers and decorative rectangles`, async () => {
      const run = await runScenario(everything(), { config });
      const nodes = allNodes(run.roots);
      const internal = nodes.filter((n) => n.insideInstance && n.type !== 'INSTANCE');
      // Non-vacuous: the fixtures really contain internal text, wrappers and decoration.
      expect(internal.some((n) => n.type === 'TEXT')).toBe(true);
      expect(internal.some((n) => n.id === IDS.heroCopyStack)).toBe(true);
      expect(internal.some((n) => n.id === IDS.heroBackdrop)).toBe(true);

      const flagged = new Set(run.result.issues.map((i) => i.nodeId));
      for (const n of internal) expect(flagged.has(n.id), `${n.id} ${n.path.join(' / ')}`).toBe(false);
      for (const id of [IDS.homeBackdrop, IDS.heroBannerOverlay]) expect(flagged.has(id), id).toBe(false);
      // Approved instances themselves are never flagged by component rules.
      for (const id of [IDS.heroPrimary, IDS.heroSecondary, IDS.heroImage, IDS.ctaButton, IDS.heroBannerCta]) {
        expect(flagged.has(id), id).toBe(false);
      }
    });
  }

  it('promo strip alone (top-level scope) still reports only the recreated button under recommended', async () => {
    const strip = promoStrip();
    const run = await runScenario([strip]);
    expect(brief(run.result.issues).filter((s) => !s.startsWith('divi/semantic-mapping'))).toEqual([
      `divi/detached-component:recreated-component@${IDS.recreatedButton}(Button)[warning/likely]`,
    ]);
  });
});
