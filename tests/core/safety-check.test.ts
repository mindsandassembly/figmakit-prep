import { describe, it, expect } from 'vitest';
import { canRemove, canFlatten, isBackgroundShape } from '../../src/core/safety-check';
import {
  mockFrameNode,
  mockRectangleNode,
  mockTextNode,
  mockEllipseNode,
  mockVectorNode,
  mockGroupNode,
  mockSolidPaint,
  mockImagePaint,
  mockDropShadowEffect,
} from '../helpers/figma-mock';

describe('canRemove', () => {
  it('returns safe=true for hidden node (visible=false)', () => {
    const node = mockFrameNode({ visible: false, children: [mockTextNode()] });
    const result = canRemove(node);
    expect(result.safe).toBe(true);
    expect(result.reason).toBe('hidden');
  });

  it('returns safe=true for zero opacity node', () => {
    const node = mockFrameNode({ opacity: 0, children: [mockTextNode()] });
    const result = canRemove(node);
    expect(result.safe).toBe(true);
    expect(result.reason).toBe('zero-opacity');
  });

  it('returns safe=true for mask node where parent clips with corner radius', () => {
    const parent = mockFrameNode({
      clipsContent: true,
      cornerRadius: 12,
      children: [],
    });
    const node = mockRectangleNode({ isMask: true, parent });
    const result = canRemove(node);
    expect(result.safe).toBe(true);
    expect(result.reason).toBe('redundant-mask');
  });

  it('returns safe=false for mask node when parent does NOT clip', () => {
    const parent = mockFrameNode({ clipsContent: false, cornerRadius: 0, children: [] });
    const node = mockRectangleNode({ isMask: true, parent });
    const result = canRemove(node);
    expect(result.safe).toBe(false);
  });

  it('returns safe=true for empty container (no children, no fill, no stroke, no effects)', () => {
    const node = mockFrameNode({
      children: [],
      fills: [],
      strokes: [],
      effects: [],
    });
    const result = canRemove(node);
    expect(result.safe).toBe(true);
    expect(result.reason).toBe('empty-container');
  });

  it('returns safe=false for empty container with fill', () => {
    const node = mockFrameNode({
      children: [],
      fills: [mockSolidPaint()],
      strokes: [],
      effects: [],
    });
    const result = canRemove(node);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('has-fill');
  });

  it('returns safe=false for node with visible stroke', () => {
    const node = mockFrameNode({
      children: [],
      fills: [],
      strokes: [mockSolidPaint()],
      effects: [],
    });
    const result = canRemove(node);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('has-stroke');
  });

  it('returns safe=false for node with visible effects', () => {
    const node = mockFrameNode({
      children: [],
      fills: [],
      strokes: [],
      effects: [mockDropShadowEffect()],
    });
    const result = canRemove(node);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('has-effects');
  });

  it('returns safe=false for semi-transparent node (0 < opacity < 1)', () => {
    const node = mockFrameNode({
      opacity: 0.5,
      children: [mockTextNode()],
      fills: [],
      strokes: [],
      effects: [],
    });
    const result = canRemove(node);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('has-visual-contribution');
  });

  it('returns safe=false for node with non-normal blend mode', () => {
    const node = mockFrameNode({
      blendMode: 'MULTIPLY',
      children: [mockTextNode()],
      fills: [],
      strokes: [],
      effects: [],
    });
    const result = canRemove(node);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('has-blend-mode');
  });

  it('ignores invisible fills when checking emptiness', () => {
    const node = mockFrameNode({
      children: [],
      fills: [mockSolidPaint({ visible: false })],
      strokes: [],
      effects: [],
    });
    const result = canRemove(node);
    expect(result.safe).toBe(true);
    expect(result.reason).toBe('empty-container');
  });

  it('ignores invisible effects when checking emptiness', () => {
    const node = mockFrameNode({
      children: [],
      fills: [],
      strokes: [],
      effects: [mockDropShadowEffect({ visible: false })],
    });
    const result = canRemove(node);
    expect(result.safe).toBe(true);
    expect(result.reason).toBe('empty-container');
  });

  it('returns safe=false for TEXT node (always has visual contribution)', () => {
    const node = mockTextNode({ characters: 'Hello' });
    const result = canRemove(node);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('has-visual-contribution');
  });

  it('returns safe=false for node with children and fill', () => {
    const node = mockFrameNode({
      children: [mockTextNode()],
      fills: [mockSolidPaint()],
    });
    const result = canRemove(node);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('has-fill');
  });
});

describe('canFlatten', () => {
  it('returns safe=true for single-child frame with no visual props', () => {
    const child = mockTextNode({ characters: 'Hello' });
    const node = mockFrameNode({
      children: [child],
      fills: [],
      strokes: [],
      effects: [],
      cornerRadius: 0,
      layoutMode: 'NONE',
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: 0,
    });
    const result = canFlatten(node);
    expect(result.safe).toBe(true);
  });

  it('returns safe=false for node with fill', () => {
    const child = mockTextNode({ characters: 'Hello' });
    const node = mockFrameNode({
      children: [child],
      fills: [mockSolidPaint()],
      strokes: [],
      effects: [],
      cornerRadius: 0,
      layoutMode: 'NONE',
    });
    const result = canFlatten(node);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('has-fill');
  });

  it('returns safe=false for node with stroke', () => {
    const child = mockTextNode({ characters: 'Hello' });
    const node = mockFrameNode({
      children: [child],
      fills: [],
      strokes: [mockSolidPaint()],
      effects: [],
      cornerRadius: 0,
      layoutMode: 'NONE',
    });
    const result = canFlatten(node);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('has-stroke');
  });

  it('returns safe=false for node with effects', () => {
    const child = mockTextNode({ characters: 'Hello' });
    const node = mockFrameNode({
      children: [child],
      fills: [],
      strokes: [],
      effects: [mockDropShadowEffect()],
      cornerRadius: 0,
      layoutMode: 'NONE',
    });
    const result = canFlatten(node);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('has-effects');
  });

  it('returns safe=false for node with corner radius', () => {
    const child = mockTextNode({ characters: 'Hello' });
    const node = mockFrameNode({
      children: [child],
      fills: [],
      strokes: [],
      effects: [],
      cornerRadius: 8,
      layoutMode: 'NONE',
    });
    const result = canFlatten(node);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('has-corner-radius');
  });

  it('returns safe=false for node with auto-layout', () => {
    const child = mockTextNode({ characters: 'Hello' });
    const node = mockFrameNode({
      children: [child],
      fills: [],
      strokes: [],
      effects: [],
      cornerRadius: 0,
      layoutMode: 'HORIZONTAL',
    });
    const result = canFlatten(node);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('has-auto-layout');
  });

  it('returns safe=false for node with padding', () => {
    const child = mockTextNode({ characters: 'Hello' });
    const node = mockFrameNode({
      children: [child],
      fills: [],
      strokes: [],
      effects: [],
      cornerRadius: 0,
      layoutMode: 'NONE',
      paddingTop: 16,
    });
    const result = canFlatten(node);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('has-padding');
  });

  it('returns safe=false for node with two children', () => {
    const node = mockFrameNode({
      children: [mockTextNode(), mockTextNode({ name: 'Text 2' })],
      fills: [],
      strokes: [],
      effects: [],
      cornerRadius: 0,
      layoutMode: 'NONE',
    });
    const result = canFlatten(node);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('multiple-children');
  });

  it('returns safe=false for node with no children', () => {
    const node = mockFrameNode({
      children: [],
      fills: [],
      strokes: [],
      effects: [],
      cornerRadius: 0,
      layoutMode: 'NONE',
    });
    const result = canFlatten(node);
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('no-children');
  });
});

describe('isBackgroundShape', () => {
  it('returns true for rectangle covering >= 90% of parent', () => {
    const parent = mockFrameNode({ width: 400, height: 300, children: [] });
    const node = mockRectangleNode({ width: 380, height: 285, parent });
    expect(isBackgroundShape(node, parent)).toBe(true);
  });

  it('returns true for rectangle covering exactly 90% of parent', () => {
    const parent = mockFrameNode({ width: 100, height: 100, children: [] });
    const node = mockRectangleNode({ width: 90, height: 100, parent });
    expect(isBackgroundShape(node, parent)).toBe(true);
  });

  it('returns false for rectangle covering < 90% of parent', () => {
    const parent = mockFrameNode({ width: 400, height: 300, children: [] });
    const node = mockRectangleNode({ width: 200, height: 150, parent });
    expect(isBackgroundShape(node, parent)).toBe(false);
  });

  it('returns true for ellipse covering >= 90%', () => {
    const parent = mockFrameNode({ width: 400, height: 400, children: [] });
    const node = mockEllipseNode({ width: 400, height: 400, parent });
    expect(isBackgroundShape(node, parent)).toBe(true);
  });

  it('returns false for non-shape type (text)', () => {
    const parent = mockFrameNode({ width: 400, height: 300, children: [] });
    const node = mockTextNode({ width: 400, height: 300, parent });
    expect(isBackgroundShape(node, parent)).toBe(false);
  });

  it('returns false for non-shape type (frame)', () => {
    const parent = mockFrameNode({ width: 400, height: 300, children: [] });
    const node = mockFrameNode({ width: 400, height: 300, parent });
    expect(isBackgroundShape(node, parent)).toBe(false);
  });

  it('returns false for vector (even if covers parent)', () => {
    const parent = mockFrameNode({ width: 400, height: 300, children: [] });
    const node = mockVectorNode({ width: 400, height: 300, parent });
    // Vectors are not background shapes — they could be icons or illustrations
    expect(isBackgroundShape(node, parent)).toBe(false);
  });

  it('handles zero-size parent gracefully', () => {
    const parent = mockFrameNode({ width: 0, height: 0, children: [] });
    const node = mockRectangleNode({ width: 0, height: 0, parent });
    expect(isBackgroundShape(node, parent)).toBe(false);
  });
});

import { mockComponentNode, mockInstanceNode, mockFrameNode as mkFrame, mockRectangleNode as mkRect } from '../helpers/figma-mock';
import { canRemove as cr, canFlatten as cf, isRedundantNesting as rn } from '../../src/core/safety-check';

describe('component boundaries are never cleaned', () => {
  it('never flattens a single-child COMPONENT (would delete the main component)', () => {
    const comp = mockComponentNode({ name: 'button 1', children: [mkRect()] });
    expect(cf(comp)).toEqual({ safe: false, reason: 'component-boundary' });
    expect(rn(comp).safe).toBe(false);
  });

  it('never flattens an INSTANCE', () => {
    const inst = mockInstanceNode({ children: [mkFrame({ children: [mkRect()] })] });
    expect(cf(inst).safe).toBe(false);
    expect(rn(inst).safe).toBe(false);
  });

  it('never removes a hidden or empty main component', () => {
    expect(cr(mockComponentNode({ visible: false })).safe).toBe(false);
    expect(cr(mockComponentNode({})).safe).toBe(false);
  });

  it('never removes or flattens layers inside an instance', () => {
    const hidden = mockFrameNode({ visible: false });
    const wrapper = mockFrameNode({ children: [mkRect()] });
    mockInstanceNode({ children: [hidden, wrapper] });
    expect(cr(hidden)).toEqual({ safe: false, reason: 'inside-instance' });
    expect(cf(wrapper)).toEqual({ safe: false, reason: 'inside-instance' });
  });

  it('still removes a hidden instance (removing an instance does not affect other layers)', () => {
    expect(cr(mockInstanceNode({ visible: false })).safe).toBe(true);
  });
});
