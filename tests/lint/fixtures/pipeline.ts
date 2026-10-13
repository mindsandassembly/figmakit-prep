/**
 * Real-pipeline runner for scenario tests:
 *   raw Figma mocks → buildDesignTree(createMockResolver) → resolveConfig(ALL_RULES)
 *   → loadRegistry → runLint → evaluateReadiness.
 */

import { buildDesignTree, createMockResolver } from '../../../src/lint/snapshot';
import { resolveConfig, checkRegistryCompatibility } from '../../../src/lint/config';
import { loadRegistry } from '../../../src/lint/registry';
import { runLint } from '../../../src/lint/engine';
import { evaluateReadiness } from '../../../src/lint/readiness';
import { ALL_RULES } from '../../../src/lint/rules/index';
import type {
  DesignNode,
  IssueException,
  LintConfig,
  LintIssue,
  LintRule,
  LintRunResult,
  ReadinessResult,
  ResolvedConfig,
  RegistryIndex,
} from '../../../src/lint/types';
import { landingRegistry } from './registry';
import { LOCAL_COMPONENTS } from './landing-page';

export const SCENARIO_NOW = '2026-03-01T12:00:00.000Z';

export const RECOMMENDED: LintConfig = { extends: ['figmakit:recommended'], rulesetVersion: '1.0.0', registryVersion: '^1.0.0' };
export const STRICT: LintConfig = { extends: ['figmakit:strict'], rulesetVersion: '1.0.0', registryVersion: '^1.0.0' };

export interface ScenarioOpts {
  config?: LintConfig;
  registry?: unknown;
  exceptions?: IssueException[];
  rules?: LintRule[];
  now?: string;
}

export interface ScenarioRun {
  roots: DesignNode[];
  nodeCount: number;
  result: LintRunResult;
  readiness: ReadinessResult;
  config: ResolvedConfig;
  registry: RegistryIndex;
}

export async function runScenario(rawRoots: any[], opts: ScenarioOpts = {}): Promise<ScenarioRun> {
  const rules = opts.rules ?? ALL_RULES;
  const resolved = resolveConfig(opts.config ?? RECOMMENDED, rules);
  const loaded = loadRegistry(opts.registry === undefined ? landingRegistry() : opts.registry);
  if (!loaded.index) throw new Error('fixture registry failed to load: ' + JSON.stringify(loaded.diagnostics));
  const configDiagnostics = resolved.diagnostics.concat(checkRegistryCompatibility(resolved.config, loaded.index.version));
  const snap = await buildDesignTree(rawRoots, createMockResolver(LOCAL_COMPONENTS), {
    includeHidden: resolved.config.settings.includeHidden,
  });
  const result = runLint({
    roots: snap.roots,
    rules,
    config: resolved.config,
    registry: loaded.index,
    configDiagnostics,
    registryDiagnostics: loaded.diagnostics,
    exceptions: opts.exceptions ?? [],
    now: opts.now ?? SCENARIO_NOW,
  });
  const readiness = evaluateReadiness({ result, config: resolved.config, registry: loaded.index });
  return { roots: snap.roots, nodeCount: snap.nodeCount, result, readiness, config: resolved.config, registry: loaded.index };
}

/** Issues on one node (optionally one rule). */
export function issuesOn(run: ScenarioRun, nodeId: string, ruleId?: string): LintIssue[] {
  return run.result.issues.filter((i) => i.nodeId === nodeId && (!ruleId || i.ruleId === ruleId));
}

/** Compact, readable issue summary for diagnostics in failure messages. */
export function brief(issues: LintIssue[]): string[] {
  return issues.map((i) => `${i.ruleId}:${i.code}@${i.nodeId}(${i.nodeName})[${i.severity}/${i.certainty}]`);
}

/** All DesignNodes in pre-order. */
export function allNodes(roots: DesignNode[]): DesignNode[] {
  const out: DesignNode[] = [];
  const visit = (n: DesignNode): void => {
    out.push(n);
    n.children.forEach(visit);
  };
  roots.forEach(visit);
  return out;
}
