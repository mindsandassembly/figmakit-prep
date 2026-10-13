import type { RegistryComponent } from '../types';

/**
 * Designer-facing pointer to an approved component, e.g.
 * 'Divi Button ("button 1" in Assets panel → Local components)'. Falls back to the registry name.
 */
export function componentRef(c: RegistryComponent): string {
  const f = c.figma;
  if (!f || (!f.componentName && !f.location)) return c.name;
  const what = f.componentName ? `"${f.componentName}"` : '';
  const where = f.location ? (what ? ` in ${f.location}` : f.location) : '';
  return `${c.name} (${what}${where})`;
}
