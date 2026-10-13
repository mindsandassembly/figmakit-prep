import type { AnalysisResult, RenameAction, NodeRole } from '../shared/types';
import { AUTO_NAME_PATTERN, SEMANTIC_NAMES, HEADING_THRESHOLDS } from '../shared/constants';

const ROLE_TO_NAME: Record<string, string> = {
  'text': 'text',
  'image': 'image',
  'icon': 'icon',
  'button': 'button',
  'divider': 'divider',
  'spacer': 'spacer',
  'wrapper': 'wrapper',
  'section': 'section',
  'row': 'row',
  'flex-row': 'row',
  'flex-col': 'vstack',
  'column': 'column',
  'group': 'group',
  'card': 'card',
  'hero': 'hero',
  'feature': 'feature',
  'cta': 'cta',
  'testimonial': 'testimonial',
  'accordion': 'accordion',
  'tabs': 'tabs',
  'modal': 'modal',
  'gallery': 'gallery',
  'isi': 'isi',
  'header': 'header',
  'buttons': 'buttons',
  'list': 'list',
  'list-item': 'list-item',
};

// Composite parent roles that get parent-prefixed child names
const COMPOSITE_ROLES = new Set<NodeRole>([
  'card', 'hero', 'feature', 'cta', 'testimonial', 'button', 'list',
]);

// Parent role → child role → child element name (matches FigmaKit WP resolver name patterns)
// Child element names that EXACTLY match FigmaKit WP plugin's
// fk_resolve_from_name_patterns() regex patterns.
//
// Divi 4: card-header → et_pb_image, card-body → et_pb_text, card-cta → et_pb_button
// Divi 5: same names → divi/image, divi/text, divi/button
// Gutenberg: same names → core/image, core/paragraph, core/button
const CHILD_ELEMENT_MAP: Record<string, Record<string, string>> = {
  card: {
    image: 'header',       // card-header → image (matches WP pattern)
    heading: 'title',      // card-title → heading (matched via 'title' pattern)
    text: 'body',          // card-body → text (matches WP pattern)
    button: 'cta',         // card-cta → button (matches WP pattern)
    divider: 'divider',    // card-divider
    icon: 'icon',          // card-icon → image (matched via 'icon' pattern)
    'flex-row': 'content', // card-content → text (matches WP pattern)
    'flex-col': 'content', // card-content → text (matches WP pattern)
    spacer: 'spacer',      // card-spacer
  },
  hero: {
    image: 'image',        // hero-image → image (matched via 'image' pattern)
    heading: 'title',      // hero-title → heading (matched via 'title' pattern)
    text: 'description',   // hero-description → text (matched via 'description' pattern)
    button: 'cta',         // hero-cta → button/cta (matched via 'cta' pattern)
    icon: 'icon',          // hero-icon → image
    'flex-row': 'content', // hero-content → text
    'flex-col': 'content', // hero-content → text
  },
  feature: {
    icon: 'icon',          // feature-icon → image
    heading: 'title',      // feature-title → heading
    text: 'description',   // feature-description → text
    button: 'cta',         // feature-cta → button/cta
    image: 'image',        // feature-image → image
  },
  cta: {
    heading: 'title',      // cta-title → heading
    text: 'description',   // cta-description → text
    button: 'button',      // cta-button → button
    image: 'image',        // cta-image → image
  },
  testimonial: {
    image: 'avatar',       // testimonial-avatar → image (matched via 'avatar' pattern)
    text: 'quote',         // testimonial-quote → testimonial (matched via 'quote' pattern)
    heading: 'author',     // testimonial-author
    icon: 'icon',          // testimonial-icon
  },
  button: {
    text: 'label',         // button_label → text for Divi button_text extraction
    heading: 'label',      // any text-like child is the button label
    icon: 'icon',          // button_icon → SVG/vector icon in button
    image: 'icon',         // small image in button = icon
    wrapper: 'icon',       // SVG wrapper around vector = icon
  },
  list: {
    text: 'item',          // list-item
    heading: 'item',       // list-item
    'list-item': 'item',   // list-item (already named Link)
    button: 'item',        // clickable list item
    'flex-col': 'item',    // wrapper around text = list item
    'flex-row': 'item',    // wrapper around text = list item
    container: 'item',     // container wrapper = list item
    wrapper: 'item',       // wrapper = list item
    image: 'image',        // exportable asset in list
    icon: 'image',         // SVG/vector in list → image (exportable)
  },
};

// Structural names that should just be lowercased, not fully renamed
var STRUCTURAL_NAMES: Record<string, string> = {
  'section': 'section',
  'row': 'row',
  'column': 'column',
  'col': 'column',
  'group': 'group',
  'container': 'container',
  'buttons': 'buttons',
  'card': 'card',
  'accordion': 'accordion',
  'tabs': 'tabs',
  'hero': 'hero',
  'feature': 'feature',
  'cta': 'cta',
  'testimonial': 'testimonial',
  'modal': 'modal',
  'gallery': 'gallery',
  'divider': 'divider',
  'separator': 'divider',
  'button': 'button',
  'image': 'image',
  'icon': 'icon',
  'logo': 'logo',
  'text': 'text',
  'heading': 'heading',
  'header': 'header',
  'footer': 'footer',
  'spacer': 'spacer',
  'wrapper': 'wrapper',
  'list': 'list',
  'item': 'list-item',
  'list-item': 'list-item',
  'nav': 'nav',
  'menu': 'menu',
  'main': 'list',
  'div': 'container',
  'form': 'form',
};

function isAutoNamed(name: string): boolean {
  return AUTO_NAME_PATTERN.test(name);
}

function isSemanticName(name: string): boolean {
  return SEMANTIC_NAMES.includes(name.toLowerCase());
}

/**
 * Get layout suffix based on auto-layout direction.
 * Returns "_vstack" for vertical, "_hstack" for horizontal, "" for none.
 */
function getLayoutSuffix(result: AnalysisResult): string {
  if (result.layoutMode === 'VERTICAL') return '_vstack';
  if (result.layoutMode === 'HORIZONTAL') return '_hstack';
  return '';
}

/**
 * Add layout suffix to a base name if the node has auto-layout.
 */
function withLayoutSuffix(baseName: string, result: AnalysisResult): string {
  var suffix = getLayoutSuffix(result);
  // Don't double-suffix if already has _vstack/_hstack
  if (baseName.indexOf('_vstack') >= 0 || baseName.indexOf('_hstack') >= 0) return baseName;
  // Don't add suffix to roles that imply direction already
  if (baseName === 'row' || baseName === 'vstack' || baseName === 'hstack') return baseName;
  return baseName + suffix;
}

function getHeadingLevel(fontSize: number): number {
  for (var i = 0; i < HEADING_THRESHOLDS.length; i++) {
    if (fontSize >= HEADING_THRESHOLDS[i].minSize) return HEADING_THRESHOLDS[i].level;
  }
  return 6;
}

/**
 * Check if a name is a structural name that just needs lowercasing.
 * E.g., "Section" → "section", "Row" → "row"
 */
function getStructuralLowercase(name: string): string | null {
  var lower = name.toLowerCase().trim();
  // Exact match (e.g., "Section", "Row", "Card")
  if (STRUCTURAL_NAMES[lower] && name !== lower) {
    return STRUCTURAL_NAMES[lower];
  }
  return null;
}

/**
 * Generate a semantic name for an analyzed node, considering parent context.
 * - Structural names (Section, Row, etc.) just get lowercased
 * - Auto-generated names (Frame 1, Group 2) get semantic names
 * - Children of composites (card, hero) get parent-prefixed names
 */
export function generateName(result: AnalysisResult, parentRole?: NodeRole, insideSection?: boolean): string | null {
  var name = result.name;
  var role = result.role;
  var type = result.type;

  // Don't rename component definitions
  if (type === 'COMPONENT') return null;

  // Don't rename layers with (skip) or (ignore) markers
  if (name.indexOf('(skip)') >= 0 || name.indexOf('(ignore)') >= 0) return null;

  // Don't rename layers that are already marked as decorative
  if (role === 'background-shape') return null;

  // "Heading N" frames are wrappers (classified as wrapper by classifier)
  // Don't rename them — they will be flattened instead.
  // "Heading" without number → just lowercase
  if (/^heading$/i.test(name) && name !== 'heading') {
    return 'heading';
  }

  // "Div" → "container"
  if (/^div$/i.test(name)) return 'container';

  // Logo patterns → "logo"
  if (/logo/i.test(name) && name.toLowerCase() !== 'logo') return 'logo';

  // "CTA Section" → "cta"
  if (/^cta[-_\s]section/i.test(name)) return 'cta';

  // "Hero Image", "Footer Image", "Content + image" → "section" (layout containers, not images)
  if (/^(hero|content|leadership|about)[-_\s+]image/i.test(name)) return 'section';
  if (/^footer[-_\s]image/i.test(name)) return 'footer';

  // CamelCase section names: "LeadershipSection" → "section"
  if (/section$/i.test(name) && name.toLowerCase() !== 'section') return 'section';

  // Names ending in "card" with prefix: "What-we-do card" → "card"
  if (/\bcard\b(\/\w+)*$/i.test(name) && name.toLowerCase() !== 'card') return 'card';

  // "Navlink" → "list-item"
  if (/^navlink/i.test(name)) return 'list-item';

  // Page wrappers: "1.0_Something_Desktop" → "section"
  if (/^\d+\.\d+[-_\s]/.test(name)) return withLayoutSuffix('section', result);

  // "primary_nav" → "header"
  if (/^primary[-_\s]?nav/i.test(name)) return 'header';

  // "highlighted text" → "text"
  if (/^highlighted[-_\s]?text$/i.test(name)) return 'text';

  // "copy chunk" → "content_vstack"
  if (/^copy[-_\s]?chunk$/i.test(name)) return withLayoutSuffix('container', result);

  // "Footnote" → "text"
  if (/^footnote$/i.test(name)) return 'text';

  // "Stat", "85-percent" → container
  if (/^stat$/i.test(name) || /^\d+[-_]?percent$/i.test(name)) return withLayoutSuffix('container', result);

  // "icon.Something" → "icon"
  if (/^icon\./i.test(name)) return 'icon';

  // Long layer names (40+ chars) that are the actual text content → "text"
  // Figma auto-names TEXT nodes with their content when no explicit name is set
  if (name.length >= 40 && role === 'text') return 'text';
  if (name.length >= 40 && role === 'heading') return 'text';

  // "module-left", "module-right" → card with layout suffix
  if (/^module[-_](left|right)/i.test(name)) return withLayoutSuffix('card', result);

  // "module-CRM-signup", "module-signup" → cta
  if (/^module[-_]?(cta|signup|sign[-_]?up|crm)/i.test(name)) return 'cta';

  // "module" or "module-*" → group
  if (/^module([-_\s/].*)?$/i.test(name)) return withLayoutSuffix('group', result);

  // "website-header-nav" → "header"
  if (/^website[-_]header/i.test(name)) return 'header';

  // "body" as container (not text) — when it's a frame with children
  if (/^body$/i.test(name) && result.children.length > 0) return withLayoutSuffix('container', result);

  // "FPO" → "image" (For Placement Only)
  if (/^fpo$/i.test(name)) return 'image';

  // Strip Figma variant suffixes: "quiz/Default" → "quiz", "card/desktop" → "card"
  var slashIdx = name.indexOf('/');
  if (slashIdx > 0) {
    var basePart = name.substring(0, slashIdx).trim().toLowerCase();
    if (basePart.length > 0) {
      var strippedLower = getStructuralLowercase(basePart.charAt(0).toUpperCase() + basePart.slice(1));
      if (strippedLower) return strippedLower;
      // Return the base part without the variant suffix
      return basePart;
    }
  }

  // Check if it's a structural name that just needs lowercasing
  var lowered = getStructuralLowercase(name);
  if (lowered) {
    // Nested sections become groups — only root can be section
    if (lowered === 'section' && insideSection) {
      return withLayoutSuffix('group', result);
    }
    // Add layout suffix for containers and sections
    if (lowered === 'container' || lowered === 'section' || lowered === 'group') {
      return withLayoutSuffix(lowered, result);
    }
    return lowered;
  }

  // Already-correct semantic names — but add layout suffix if missing
  if (isSemanticName(name) && name === name.toLowerCase()) {
    var containerLikeNames = ['container', 'group', 'card', 'hero', 'feature', 'cta', 'footer', 'header'];
    var suffix = getLayoutSuffix(result);
    if (suffix && containerLikeNames.indexOf(name) >= 0 && name.indexOf('_vstack') < 0 && name.indexOf('_hstack') < 0) {
      return name + suffix;
    }
    return null;
  }

  // Don't rename user-given non-auto names (unless they match structural names above)
  if (!isAutoNamed(name) && !isSemanticName(name)) return null;

  // Don't rename low-confidence defaults or decorative layers
  if (role === 'container' || role === 'unknown' || (role as NodeRole) === 'background-shape') return null;

  // If parent is a composite, use parent-prefixed naming
  if (parentRole && COMPOSITE_ROLES.has(parentRole)) {
    var elementMap = CHILD_ELEMENT_MAP[parentRole];
    if (elementMap) {
      var elementName = elementMap[role];
      if (elementName) {
        // Button children use _ separator (WP plugin expects button_label)
        var separator = parentRole === 'button' ? '_' : '-';
        return parentRole + separator + elementName;
      }
    }
    // Inside a button, any container child is just a wrapper — skip renaming
    if (parentRole === 'button' && ((role as NodeRole) === 'container' || role === 'flex-row' || role === 'flex-col' || role === 'wrapper')) {
      return null;
    }
  }

  // Heading with level
  if (role === 'heading') {
    var fontSize = result.tokens.typography ? result.tokens.typography.fontSize : 16;
    var level = getHeadingLevel(fontSize);
    return 'h' + level;
  }

  var baseName = ROLE_TO_NAME[role] || null;
  if (!baseName) return null;

  // Nested sections become groups
  if (baseName === 'section' && insideSection) {
    return withLayoutSuffix('group', result);
  }

  if (baseName === 'section' || role === 'flex-row' || role === 'flex-col') {
    return withLayoutSuffix(baseName, result);
  }
  return baseName;
}

/**
 * Collect renamable nodes from analysis results (recursively).
 * Passes parent role context down so children of composites get prefixed names.
 */
function collectRenamable(
  results: AnalysisResult[],
  actions: RenameAction[],
  parentRole?: NodeRole,
  insideSection?: boolean,
): void {
  for (var ri = 0; ri < results.length; ri++) {
    var result = results[ri];
    var suggested = generateName(result, parentRole, insideSection);
    if (suggested) {
      // If already named exactly this, skip entirely
      if (result.name !== suggested) {
        actions.push({
          nodeId: result.id,
          node: result.node,
          currentName: result.name,
          suggestedName: suggested,
          confidence: result.confidence,
          source: result.source,
        });
      }
    }

    // Recurse into children, passing this node's role as parent context
    if (result.children.length > 0) {
      var childParentRole = COMPOSITE_ROLES.has(result.role) ? result.role : parentRole;
      // Track if we're inside a section — children of sections can't be sections
      var isThisSection = result.role === 'section' || !!(suggested && suggested.indexOf('section') === 0);
      var childInsideSection = insideSection || isThisSection;
      collectRenamable(result.children, actions, childParentRole, childInsideSection);
    }
  }
}

/**
 * Scan analysis results for nodes that should be renamed.
 * Parent-context-aware: children of composite components (card, hero, feature, etc.)
 * get parent-prefixed names matching FigmaKit's WP resolver patterns.
 */
export function scanForRenaming(results: AnalysisResult[]): RenameAction[] {
  var actions: RenameAction[] = [];
  collectRenamable(results, actions);
  return actions;
}

/**
 * Apply rename actions by setting node.name for each action.
 */
export function applyRenames(actions: RenameAction[]): number {
  for (const action of actions) {
    action.node.name = action.suggestedName;
  }
  return actions.length;
}
