/**
 * Stage 4 — DOM attribution (spec §8).
 *
 * For each region, hit-test `dom.json` on both sides and select the smallest node fully containing
 * the region, preferring nodes whose own rect changed. This is the step that turns "pixels at
 * 340,220" into "the Pay button".
 *
 * Regions are image-space; DOM rects are CSS-space, so nodes are indexed once with their rects
 * scaled by the shot's device scale factor.
 */

import type { DomNode, Rect } from '../types.js';
import { area as rectArea, contains, intersect, roundRect, scaleRect } from './geometry.js';

/** Slop allowed when testing containment, in image pixels: text can bleed a hair past its box. */
export const CONTAIN_TOLERANCE = 2;

/** A region overlapping a node by less than this fraction is not attributed to it. */
const MIN_OVERLAP_RATIO = 0.2;

/**
 * How much bigger than the tightest containing node a node may be and still win the
 * "prefer nodes whose own rect changed" tie-break. Without a bound, a page whose height changed
 * makes `<body>`'s rect change and every region on the page gets attributed to `<body>`.
 */
const PREFER_CHANGED_AREA_FACTOR = 2;

export interface IndexedNode {
  node: DomNode;
  /** Image-space rect. */
  rect: Rect;
  area: number;
  /** Whether this node's own rect changed between the two runs. */
  rectChanged: boolean;
}

export function buildIndex(
  nodes: readonly DomNode[],
  scale: number,
  rectChangedFor: (node: DomNode) => boolean,
): IndexedNode[] {
  const out: IndexedNode[] = [];
  for (const node of nodes) {
    if (node.visible === false) continue;
    const rect = roundRect(scaleRect(node.rect, scale));
    if (rect.w <= 0 || rect.h <= 0) continue;
    out.push({ node, rect, area: rectArea(rect), rectChanged: rectChangedFor(node) });
  }
  return out;
}

export type AttributionConfidence = 'contained' | 'overlap' | 'none';

export interface SideAttribution {
  node: DomNode | null;
  confidence: AttributionConfidence;
}

export interface Attribution {
  head: SideAttribution;
  base: SideAttribution;
  /** The node the finding is reported against: head where possible, base for removals. */
  node: DomNode | null;
  side: 'head' | 'base' | null;
}

/**
 * The smallest node fully containing the region wins; among containing nodes no more than
 * `PREFER_CHANGED_AREA_FACTOR` times that tightest area, one whose own rect changed wins. Falling
 * back, the node with the largest overlap is used — that is also the degradation path when
 * `dom.json` hit its node cap and only ancestors were retained (spec §12).
 */
export function attributeSide(region: Rect, index: readonly IndexedNode[]): SideAttribution {
  const containing: IndexedNode[] = [];
  let bestOverlap: IndexedNode | null = null;
  let bestOverlapScore = 0;

  const regionArea = Math.max(1, rectArea(region));

  for (const candidate of index) {
    if (contains(candidate.rect, region, CONTAIN_TOLERANCE)) {
      containing.push(candidate);
      continue;
    }
    const overlap = intersect(candidate.rect, region);
    if (overlap === null) continue;
    const score = rectArea(overlap) / regionArea;
    if (score < MIN_OVERLAP_RATIO) continue;
    if (
      score > bestOverlapScore + 1e-6 ||
      (Math.abs(score - bestOverlapScore) <= 1e-6 &&
        bestOverlap !== null &&
        candidate.area < bestOverlap.area)
    ) {
      bestOverlap = candidate;
      bestOverlapScore = score;
    }
  }

  if (containing.length > 0) {
    let smallest = containing[0] as IndexedNode;
    for (const c of containing) if (c.area < smallest.area) smallest = c;

    const limit = Math.max(smallest.area, 1) * PREFER_CHANGED_AREA_FACTOR;
    let changed: IndexedNode | null = null;
    for (const c of containing) {
      if (!c.rectChanged || c.area > limit) continue;
      if (changed === null || c.area < changed.area) changed = c;
    }
    return { node: (changed ?? smallest).node, confidence: 'contained' };
  }

  if (bestOverlap !== null) return { node: bestOverlap.node, confidence: 'overlap' };
  return { node: null, confidence: 'none' };
}

export function attributeRegion(
  region: Rect,
  headIndex: readonly IndexedNode[],
  baseIndex: readonly IndexedNode[],
): Attribution {
  const head = attributeSide(region, headIndex);
  const base = attributeSide(region, baseIndex);
  if (head.node !== null) return { head, base, node: head.node, side: 'head' };
  if (base.node !== null) return { head, base, node: base.node, side: 'base' };
  return { head, base, node: null, side: null };
}
