/**
 * Realistic landing-page fixtures (raw Figma mock trees) for the scenario tests.
 *
 * Every builder returns FRESH raw nodes (no shared state between calls) with explicit,
 * Figma-like ids, so two builds are interchangeable and runs are deterministic.
 * Node ids the tests assert on are exported in `IDS`.
 */

import {
  HEX,
  autoFrame,
  blurb,
  button,
  column,
  decorativeRect,
  detachedFromLibrary,
  detachedFromLocal,
  handmadeButton,
  handmadePill,
  imageModule,
  instance,
  MAINS,
  pageFrame,
  photo,
  row,
  section,
  solid,
  text,
  textModule,
  withPluginData,
} from './figma-nodes';
import { KEYS } from './registry';
import { mockRectangleNode } from '../../helpers/figma-mock';

export const IDS = {
  home: '1:1',
  homeBackdrop: '1:2',

  // Hero (instance-based)
  heroSection: '10:1',
  heroBackdrop: '10:2',
  heroRow: '10:3',
  heroCopyCol: '10:4',
  heroCopyStack: '10:5',
  heroHeadline: '10:6',
  heroLede: '10:7',
  heroActions: '10:8',
  heroPrimary: '10:9',
  heroSecondary: '10:10',
  heroMediaCol: '10:11',
  heroImage: '10:12',
  heroHiddenRogue: '10:13',

  // Hero (frame-based wrapper around an approved section)
  heroBanner: '11:1',
  heroBannerOverlay: '11:2',
  heroBannerSection: '11:3',
  heroBannerRow: '11:4',
  heroBannerCol: '11:5',
  heroBannerTitle: '11:6',
  heroBannerCta: '11:7',

  // Features (cards)
  features: '12:1',
  featuresRow: '12:2',

  // CTA band
  ctaSection: '13:1',
  ctaRow: '13:2',
  ctaCol: '13:3',
  ctaCopy: '13:4',
  ctaButton: '13:5',

  hiddenDraft: '14:1',
  hiddenOffScale: '14:2',

  // Scenario B
  promoStrip: '20:1',
  promoCopy: '20:2',
  recreatedButton: '20:3',
  recreatedPill: '20:4',

  // Scenario C
  misplacedButton: '30:9',

  // Scenario D
  splitLayout: '40:1',
  leftStack: '40:2',
  leftHeadline: '40:3',
  leftBody: '40:4',
  buttonRow: '40:5',
  leftCta: '40:6',
  leftCtaAlt: '40:7',
  rightStack: '40:8',
  mediaGrid: '40:9',
  deepWrapper: '40:13',
  deeper: '40:14',
  deepText: '40:15',
  cardRow: '41:1',
  declaredBlurb: '41:90',
  story: '42:1',
  storyHeading: '42:2',
  storyBody: '42:3',
  storyPhoto: '42:4',
  storyQuote: '42:5',
  storyQuoteText: '42:6',
  testimonial: '42:7',

  // Scenario E
  detachedArea: '50:1',
  detachedLibrary: '50:2',
  detachedLocal: '50:3',
  recreatedBtn: '50:4',
  detachedUnregistered: '50:5',

  // Scenario F
  newsletter: '60:1',
} as const;

/** Local component id used by the "detached from a local component" fixture. */
export const LOCAL_BUTTON_COMPONENT_ID = '310:42';

/** Resolutions for local components (passed to createMockResolver). */
export const LOCAL_COMPONENTS: Record<string, { key: string; componentSetKey: string | null }> = {
  [LOCAL_BUTTON_COMPONENT_ID]: { key: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c', componentSetKey: KEYS.buttonSet },
};

// ---------------------------------------------------------------------------
// Sections of the approved landing page
// ---------------------------------------------------------------------------

/** Hero built from library instances: Section > Row > Columns, with internal wrappers & decoration. */
function heroInstanceBased(): any {
  return section(IDS.heroSection, 'Hero', [
    // Library-owned decoration inside the section (instance internal).
    decorativeRect(IDS.heroBackdrop, 'Rectangle 7'),
    row(IDS.heroRow, 'Hero Row', [
      column(IDS.heroCopyCol, 'Copy Column', [
        // Internal auto-layout wrappers (part of the Column slot content).
        autoFrame(IDS.heroCopyStack, 'Copy Stack', [
          textModule(IDS.heroHeadline, 'Headline', 'Build faster with Divi 5', 'h1'),
          textModule(IDS.heroLede, 'Lede', 'Ship pixel-perfect pages straight from Figma.'),
          autoFrame(IDS.heroActions, 'Actions', [
            button(IDS.heroPrimary, 'Get started', 'Primary'),
            button(IDS.heroSecondary, 'Watch demo', 'Secondary'),
          ], { layoutMode: 'HORIZONTAL', itemSpacing: 16, height: 48 }),
        ]),
      ]),
      column(IDS.heroMediaCol, 'Media Column', [
        imageModule(IDS.heroImage, 'Hero Image'),
        // Hidden swapped-in instance of an UNAPPROVED component: must be ignored.
        instance(IDS.heroHiddenRogue, 'Promo Card', MAINS.rogueCard(), { visible: false, width: 320, height: 200 }),
      ]),
    ]),
  ]);
}

/** Frame-based hero: a plain full-bleed frame with an image fill wrapping an approved section. */
function heroFrameBased(): any {
  return autoFrame(IDS.heroBanner, 'Hero Banner', [
    mockRectangleNode({ id: IDS.heroBannerOverlay, name: 'Overlay', width: 1440, height: 640, fills: [solid(HEX.ink)], opacity: 0.4 }),
    section(IDS.heroBannerSection, 'Banner Section', [
      row(IDS.heroBannerRow, 'Banner Row', [
        column(IDS.heroBannerCol, 'Banner Column', [
          textModule(IDS.heroBannerTitle, 'Banner Title', 'Your site, your rules', 'h1'),
          button(IDS.heroBannerCta, 'Start free trial', 'Primary'),
        ]),
      ]),
    ], { fills: [] }),
  ], { width: 1440, height: 640, fills: [photo('img-banner')], layoutMode: 'NONE', itemSpacing: 0 });
}

/** Feature cards: three columns, each holding an approved Blurb. */
function features(): any {
  const cols = [
    ['12:10', '12:11', 'Visual builder', 'Drag, drop, done.'],
    ['12:20', '12:21', 'Global presets', 'Consistent styles everywhere.'],
    ['12:30', '12:31', 'Responsive', 'Looks great on every device.'],
  ].map(([colId, blurbId, title, body]) => column(colId, 'Feature Column', [blurb(blurbId, title, body)], { width: 384 }));
  return section(IDS.features, 'Features', [row(IDS.featuresRow, 'Features Row', cols)], { fills: [solid(HEX.surface)] });
}

function ctaBand(extra: any[] = []): any {
  return section(IDS.ctaSection, 'Call to Action', [
    row(IDS.ctaRow, 'CTA Row', [
      column(IDS.ctaCol, 'CTA Column', [
        textModule(IDS.ctaCopy, 'CTA Copy', 'Ready to launch?', 'h2'),
        button(IDS.ctaButton, 'Talk to sales', 'Primary'),
      ]),
    ]),
    ...extra,
  ], { fills: [solid(HEX.brand)] });
}

/** Hidden top-level layers: would be flagged if they were visible. */
function hiddenDrafts(): any[] {
  return [
    handmadeButton(IDS.hiddenDraft, 'Button', 'Old CTA', { visible: false }),
    autoFrame(IDS.hiddenOffScale, 'Old Newsletter', [text(IDS.hiddenOffScale + '/t', 'Body', 'Subscribe')], {
      visible: false,
      paddingTop: 23,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Scenario pages
// ---------------------------------------------------------------------------

/** Scenario A: a landing page that only uses approved components (plus decoration and hidden layers). */
export function approvedLandingPage(extraChildren: any[] = []): any {
  return pageFrame(IDS.home, 'Home — Desktop', [
    // Full-page decorative backdrop (top level, outside any instance).
    decorativeRect(IDS.homeBackdrop, 'Rectangle 12', { width: 1440, height: 4200, fills: [solid('#eef2ff')] }),
    heroInstanceBased(),
    heroFrameBased(),
    features(),
    ...extraChildren,
    ctaBand(),
    ...hiddenDrafts(),
  ]);
}

/** Scenario B: a promo strip with a hand-built "Button" and an unnamed recreated pill ("Frame 12"). */
export function promoStrip(): any {
  return autoFrame(IDS.promoStrip, 'Promo Strip', [
    textModule(IDS.promoCopy, 'Promo Copy', 'Spring sale — 30% off all plans'),
    handmadeButton(IDS.recreatedButton, 'Button', 'Shop now'),
    handmadePill(IDS.recreatedPill, 'Frame 12', 'New'),
  ], {
    layoutMode: 'HORIZONTAL',
    width: 1280,
    height: 96,
    paddingTop: 24,
    paddingBottom: 24,
    paddingLeft: 32,
    paddingRight: 32,
    itemSpacing: 24,
    fills: [solid(HEX.surface)],
  });
}

export function pageWithRecreatedButton(): any {
  return approvedLandingPage([promoStrip()]);
}

/** Scenario C: an approved Button placed directly inside a Section (registry: Section → Row only). */
export function announcementSection(): any {
  return section('30:1', 'Announcement', [
    row('30:2', 'Announcement Row', [
      column('30:3', 'Announcement Column', [textModule('30:4', 'Announcement Copy', 'We just shipped v5!')]),
    ]),
    button(IDS.misplacedButton, 'Read the changelog', 'Secondary'),
  ], { fills: [solid(HEX.surface)] });
}

export function pageWithMisplacedButton(): any {
  return approvedLandingPage([announcementSection()]);
}

/**
 * Scenario D (1): a legitimate custom layout — approved instances arranged in plain auto-layout
 * frames with unusual nesting (split layout, button row, absolutely positioned media grid,
 * deep wrappers), plus a metadata-declared Blurb and card-like plain frames.
 */
export function customLayout(): any {
  return autoFrame(IDS.splitLayout, 'Split Layout', [
    autoFrame(IDS.leftStack, 'Left Stack', [
      textModule(IDS.leftHeadline, 'Headline', 'Designed in Figma. Built in Divi.', 'h1'),
      textModule(IDS.leftBody, 'Body', 'No hand-off spreadsheets required.'),
      autoFrame(IDS.buttonRow, 'Button Row', [
        button(IDS.leftCta, 'Try it', 'Primary'),
        button(IDS.leftCtaAlt, 'Pricing', 'Secondary'),
      ], { layoutMode: 'HORIZONTAL', itemSpacing: 12, width: 320, height: 48 }),
    ], { width: 560, height: 520, itemSpacing: 32 }),
    autoFrame(IDS.rightStack, 'Right Stack', [
      // Absolutely positioned collage of approved images.
      autoFrame(IDS.mediaGrid, 'Media Grid', [
        imageModule('40:10', 'Shot A', 240, 240),
        imageModule('40:11', 'Shot B', 240, 160),
        imageModule('40:12', 'Shot C', 240, 160),
      ], { layoutMode: 'NONE', itemSpacing: 0, width: 520, height: 420 }),
      // Needlessly deep wrapper chain (designer habit) — still fine.
      autoFrame(IDS.deepWrapper, 'Caption Wrapper', [
        autoFrame(IDS.deeper, 'Caption Inner', [
          textModule(IDS.deepText, 'Caption', 'Real customer dashboards.'),
        ], { width: 520, height: 48, itemSpacing: 0 }),
      ], { width: 520, height: 48, itemSpacing: 0, paddingTop: 8 }),
    ], { width: 560, height: 520, itemSpacing: 16 }),
  ], {
    layoutMode: 'HORIZONTAL',
    width: 1440,
    height: 720,
    paddingTop: 96,
    paddingBottom: 96,
    paddingLeft: 80,
    paddingRight: 80,
    itemSpacing: 48,
    fills: [solid(HEX.white)],
  });
}

/** Scenario D (1b): a row of card-like plain frames built from approved instances + a metadata-declared Blurb. */
export function cardRow(): any {
  const card = (n: number): any =>
    autoFrame(`41:${n}0`, 'Case Study', [
      imageModule(`41:${n}1`, 'Card Image', 320, 200),
      textModule(`41:${n}2`, 'Card Title', `Case study ${n}`, 'h2'),
      button(`41:${n}3`, 'Read more', 'Secondary'),
    ], {
      width: 352,
      height: 480,
      paddingTop: 16,
      paddingBottom: 16,
      paddingLeft: 16,
      paddingRight: 16,
      itemSpacing: 16,
      cornerRadius: 16,
      fills: [solid(HEX.white)],
      strokes: [solid(HEX.surface)],
    });

  // A plain frame the designer explicitly declared as a Divi Blurb via standards metadata
  // (the registry allows metadata mapping for Blurbs).
  const declared = withPluginData(
    autoFrame(IDS.declaredBlurb, 'Support Blurb', [
      mockRectangleNode({ id: IDS.declaredBlurb + '/icon', name: 'Icon', width: 48, height: 48, fills: [solid(HEX.brand)] }),
      text(IDS.declaredBlurb + '/title', 'Title', '24/7 support', { fontSize: 32, fontWeight: 700, width: 320, height: 48 }),
      text(IDS.declaredBlurb + '/body', 'Body', 'Humans, not bots.', { width: 320 }),
    ], { width: 352, height: 240, itemSpacing: 16 }),
    { 'fk-standards-component': 'divi-blurb' },
  );

  return autoFrame(IDS.cardRow, 'Case Studies', [card(1), card(2), card(3), declared], {
    layoutMode: 'HORIZONTAL',
    width: 1440,
    height: 560,
    paddingTop: 48,
    paddingBottom: 48,
    paddingLeft: 80,
    paddingRight: 80,
    itemSpacing: 32,
    fills: [solid(HEX.surface)],
  });
}

/**
 * Scenario D (2): a custom marketing composition of plain text and images (no components),
 * including an explicitly labelled testimonial block. Allowed (custom), never blocking.
 */
export function marketingStory(): any {
  const testimonial = withPluginData(
    autoFrame(IDS.testimonial, 'Testimonial', [
      text(IDS.testimonial + '/quote', 'Quote', '“We cut hand-off time in half.”', { fontSize: 32, fontWeight: 700, width: 520, height: 48 }),
      text(IDS.testimonial + '/who', 'Attribution', 'Dana, Head of Web', { width: 520 }),
    ], { width: 560, height: 160, itemSpacing: 8, paddingTop: 24, paddingBottom: 24, paddingLeft: 24, paddingRight: 24, fills: [solid(HEX.white)] }),
    { 'fk-type': 'testimonial' },
  );
  return autoFrame(IDS.story, 'Our Story', [
    text(IDS.storyHeading, 'Heading', 'Made by designers, for developers', { fontSize: 48, fontWeight: 700, width: 960, height: 72 }),
    text(IDS.storyBody, 'Paragraph', 'We started FigmaKit to close the gap between design and build.', { width: 960, height: 48 }),
    mockRectangleNode({ id: IDS.storyPhoto, name: 'Team Photo', width: 960, height: 480, fills: [photo('img-team')] }),
    autoFrame(IDS.storyQuote, 'Pull Quote', [
      text(IDS.storyQuoteText, 'Quote Text', 'Ship what you designed.', { fontSize: 32, fontWeight: 700, width: 960, height: 48 }),
    ], { width: 960, height: 96, paddingTop: 24, paddingBottom: 24, itemSpacing: 0 }),
    testimonial,
  ], {
    width: 1440,
    height: 1200,
    paddingTop: 96,
    paddingBottom: 96,
    paddingLeft: 80,
    paddingRight: 80,
    itemSpacing: 32,
    fills: [solid(HEX.surface)],
  });
}

/**
 * Scenario E: four button-like frames outside any instance:
 *  1. detached from the approved library Button (detachedInfo library key = registered set key);
 *  2. detached from a LOCAL component whose resolved component-set key is registered;
 *  3. hand-built, named "Btn", no detachedInfo (name + structure);
 *  4. detached from a library component that is NOT in the registry.
 */
export function detachedArea(): any {
  const lib = handmadeButton(IDS.detachedLibrary, 'Button', 'Subscribe');
  lib.detachedInfo = detachedFromLibrary(KEYS.buttonSet);
  const local = handmadeButton(IDS.detachedLocal, 'Signup CTA', 'Sign up');
  local.detachedInfo = detachedFromLocal(LOCAL_BUTTON_COMPONENT_ID);
  const recreated = handmadeButton(IDS.recreatedBtn, 'Btn', 'Contact');
  const unregistered = handmadePill(IDS.detachedUnregistered, 'Badge', 'Beta');
  unregistered.detachedInfo = detachedFromLibrary(KEYS.rogueBadge);
  return autoFrame(IDS.detachedArea, 'Footer Actions', [lib, local, recreated, unregistered], {
    layoutMode: 'HORIZONTAL',
    width: 800,
    height: 96,
    paddingTop: 24,
    paddingBottom: 24,
    paddingLeft: 32,
    paddingRight: 32,
    itemSpacing: 16,
  });
}

/** Scenario F: a newsletter block with 23px top padding (off the 4/8/…/24 scale). */
export function newsletter(paddingTop = 23): any {
  return autoFrame(IDS.newsletter, 'Newsletter', [
    textModule('60:2', 'Newsletter Copy', 'Get product updates monthly.'),
    button('60:3', 'Subscribe', 'Primary'),
  ], {
    width: 640,
    height: 200,
    paddingTop,
    paddingBottom: 24,
    paddingLeft: 24,
    paddingRight: 24,
    itemSpacing: 16,
    fills: [solid(HEX.white)],
  });
}
