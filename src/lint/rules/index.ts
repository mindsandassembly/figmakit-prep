/**
 * Built-in FigmaKit Standards rules, sorted by rule id (the engine also sorts, but a
 * stable source order keeps docs / UI listings deterministic).
 */

import type { LintRule } from '../types';
import { rule as approvedComponent } from './approved-component';
import { rule as approvedTokens } from './approved-tokens';
import { rule as autoLayout } from './auto-layout';
import { rule as componentNaming } from './component-naming';
import { rule as detachedComponent } from './detached-component';
import { rule as requiredStates } from './required-states';
import { rule as semanticMapping } from './semantic-mapping';
import { rule as validNesting } from './valid-nesting';

export const ALL_RULES: LintRule[] = [
  approvedComponent,
  approvedTokens,
  autoLayout,
  componentNaming,
  detachedComponent,
  requiredStates,
  semanticMapping,
  validNesting,
].sort((a, b) => (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0));
