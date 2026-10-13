/**
 * Fixture registry for the scenario tests: an APPROVED, fully keyed Divi 5 registry
 * with realistic library keys (no placeholders) and the nesting constraints the
 * scenarios rely on.
 *
 * Keys follow the shape of real Figma publish keys (40 hex chars) so nothing here can
 * be mistaken for a placeholder. The Button is registered by its COMPONENT_SET key only,
 * so instance matching has to go through `componentSetKey` (as it does for most real
 * variant libraries).
 */

import type { ComponentRegistry } from '../../../src/lint/types';
import { SPACING_SCALE } from '../../../src/shared/constants';

/** Library keys used by the fixture components. */
export const KEYS = {
  section: '5c1d7e0a9b3f4e2d8a6c1b0f9e8d7c6b5a4f3e2d',
  row: '6d2e8f1bac404f3e9b7d2c1fa09e8d7c6b5a4f3e',
  column: '7e3f902cbd515a4fac8e3d2fb1af9e8d7c6b5a4f',
  /** COMPONENT_SET key of the Button (the registry lists only this one). */
  buttonSet: '8f40a13dce626b5abd9f4e3fc2bfaf9e8d7c6b5a',
  /** Variant keys (NOT listed in the registry; matched via the set key). */
  buttonPrimary: '9051b24edf737c6bcea05f40d3c0bfaf9e8d7c6b',
  buttonSecondary: 'a162c35fe0848d7cdfb16051e4d1c0bfaf9e8d7c',
  text: 'b273d460f1959e8de0c27162f5e2d1c0bfaf9e8d',
  image: 'c384e571a2a6af9ef1d38273a6f3e2d1c0bfaf9e',
  blurb: 'd495f682b3b7b0aff2e49384b7a4f3e2d1c0bfaf',
  /** Components that exist in some library but are NOT approved. */
  rogueCard: 'e5a60793c4c8c1b0a3f5a495c8b5a4f3e2d1c0bf',
  rogueBadge: 'f6b718a4d5d9d2c1b4a6b5a6d9c6b5a4f3e2d1c0',
} as const;

/** Approved fixture registry (fresh object on every call — tests may mutate it). */
export function landingRegistry(): ComponentRegistry {
  return {
    version: '1.2.0',
    designSystem: 'Divi 5',
    status: 'approved',
    description: 'Scenario fixture: approved Divi 5 library for the marketing site.',
    components: [
      {
        id: 'divi-section',
        name: 'Divi Section',
        diviType: 'et_pb_section',
        figmaComponentKeys: [KEYS.section],
        allowedChildren: ['divi-row'],
        allowedParents: ['$root'],
        governsChildren: true,
        match: { namePatterns: ['^(divi[-_ ]?)?section$'], roles: ['section'] },
      },
      {
        id: 'divi-row',
        name: 'Divi Row',
        diviType: 'et_pb_row',
        figmaComponentKeys: [KEYS.row],
        allowedChildren: ['divi-column'],
        allowedParents: ['divi-section'],
        governsChildren: true,
        match: { namePatterns: ['^(divi[-_ ]?)?row$'], roles: ['row'] },
      },
      {
        id: 'divi-column',
        name: 'Divi Column',
        diviType: 'et_pb_column',
        figmaComponentKeys: [KEYS.column],
        allowedChildren: ['divi-button', 'divi-text', 'divi-image', 'divi-blurb'],
        allowedParents: ['divi-row'],
        governsChildren: true,
        match: { namePatterns: ['^(divi[-_ ]?)?(column|col)$'], roles: ['column'] },
      },
      {
        id: 'divi-button',
        name: 'Divi Button',
        diviType: 'et_pb_button',
        figmaComponentKeys: [KEYS.buttonSet],
        requiresAutoLayout: { direction: 'HORIZONTAL' },
        requiredProperties: [{ name: 'Type', allowedValues: ['Primary', 'Secondary'] }],
        optionalStates: { State: ['Default', 'Hover'] },
        match: { namePatterns: ['^(divi[-_ ]?)?(button|btn)$'], roles: ['button'] },
      },
      {
        id: 'divi-text',
        name: 'Divi Text',
        diviType: 'et_pb_text',
        figmaComponentKeys: [KEYS.text],
        match: { namePatterns: ['^(divi[-_ ]?)?text$'] },
      },
      {
        id: 'divi-image',
        name: 'Divi Image',
        diviType: 'et_pb_image',
        figmaComponentKeys: [KEYS.image],
        match: { namePatterns: ['^(divi[-_ ]?)?image$'] },
      },
      {
        id: 'divi-blurb',
        name: 'Divi Blurb',
        diviType: 'et_pb_blurb',
        figmaComponentKeys: [KEYS.blurb],
        allowMetadataMapping: true,
        match: { namePatterns: ['^(divi[-_ ]?)?blurb$'], roles: ['feature'] },
      },
    ],
    tokens: {
      spacing: Object.keys(SPACING_SCALE).map((name) => ({ name, value: SPACING_SCALE[name] })),
      colors: [
        { name: 'brand', value: '#4f46e5' },
        { name: 'ink', value: '#111111' },
        { name: 'white', value: '#ffffff' },
        { name: 'surface', value: '#f5f5f7' },
      ],
      typography: [
        { name: 'body', fontFamily: 'Inter', fontSize: 16, fontWeight: 400 },
        { name: 'h2', fontFamily: 'Inter', fontSize: 32, fontWeight: 700 },
        { name: 'h1', fontFamily: 'Inter', fontSize: 48, fontWeight: 700 },
      ],
      fontFamilies: ['Inter'],
    },
  };
}
