/**
 * Stages 2–5 for one (step, viewport) shot pair: pixel diff → region clustering → DOM attribution
 * → node diff → findings (spec §8).
 *
 * Pure: images and snapshots in, a `ViewportDiff` plus the artifacts the engine writes out. All
 * geometry it returns is image-space, matching `pixel.png`, `regions.json` and the crops.
 */

import type {
  DiffEngineOptions,
  DomNode,
  Finding,
  FindingElement,
  LoadedShot,
  PixelImage,
  PropChange,
  Rect,
  Region,
  StepId,
  ViewportDiff,
  ViewportId,
} from '../types.js';
import { SEVERITY_ORDER } from '../types.js';
import { area as rectArea, roundRect, scaleRect } from './geometry.js';
import { buildIndex, attributeRegion } from './attribution.js';
import type { IndexedNode } from './attribution.js';
import { clusterRegions } from './regions.js';
import type { ClusterResult } from './regions.js';
import { matchNodes } from './nodeMatch.js';
import type { NodePair } from './nodeMatch.js';
import { diffNodePair, rectChanged } from './nodeDiff.js';
import type { NodeChange } from '../types.js';
import { classifyNodeChange, LAYOUT_SHIFT_PX } from './severity.js';
import type { ContrastContext, Verdict } from './severity.js';
import { pixelDiff, renderPixelOverlay } from './pixel.js';
import { matchesAny, selectorFor } from './selector.js';

export interface ShotSide {
  shot: LoadedShot;
  image: PixelImage;
}

export interface ViewportDiffInput {
  step: StepId;
  viewport: ViewportId;
  base: ShotSide | null;
  head: ShotSide | null;
  options: DiffEngineOptions;
}

export interface ViewportDiffOutput {
  diff: ViewportDiff;
  /** `pixel.png` content, when a comparison actually happened. */
  overlay: PixelImage | null;
  regionSet: ClusterResult | null;
  /** The image crops are cut from: head where it exists, base for a removed step. */
  cropSource: PixelImage | null;
}

function scaleFor(shot: LoadedShot, fallback: number): number {
  const dsf = shot.dom.deviceScaleFactor;
  return Number.isFinite(dsf) && dsf > 0 ? dsf : fallback;
}

function elementFor(node: DomNode | null): FindingElement | undefined {
  if (node === null) return undefined;
  const el: FindingElement = { selector: selectorFor(node), path: node.path };
  if (node.role !== undefined && node.role !== '') el.role = node.role;
  if (node.name !== undefined && node.name !== '') el.name = node.name;
  return el;
}

function byPath(nodes: readonly DomNode[]): Map<string, DomNode> {
  const m = new Map<string, DomNode>();
  for (const n of nodes) if (!m.has(n.path)) m.set(n.path, n);
  return m;
}

/** Flow `mask` rects plus the rects of nodes matching config `ignore`, in image space. */
export function exclusionRects(
  side: ShotSide | null,
  ignore: readonly string[],
  fallbackScale: number,
): Rect[] {
  if (side === null) return [];
  const scale = scaleFor(side.shot, fallbackScale);
  const out: Rect[] = side.shot.dom.masks.map((r) => roundRect(scaleRect(r, scale)));
  if (ignore.length > 0) {
    for (const node of side.shot.dom.nodes) {
      if (!matchesAny(node, ignore)) continue;
      out.push(roundRect(scaleRect(node.rect, scale)));
    }
  }
  return out;
}

function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const aArea = a.region === undefined ? 0 : rectArea(a.region);
    const bArea = b.region === undefined ? 0 : rectArea(b.region);
    if (aArea !== bArea) return bArea - aArea;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.label.localeCompare(b.label);
  });
}

function emptyDiff(
  viewport: ViewportId,
  base: ShotSide | null,
  head: ShotSide | null,
): ViewportDiff {
  const missing = base === null && head === null ? 'both' : base === null ? 'base' : 'head';
  return {
    viewport,
    pixelChangedRatio: 0,
    baseSize: base === null ? null : { w: base.image.width, h: base.image.height },
    headSize: head === null ? null : { w: head.image.width, h: head.image.height },
    dimensionsChanged: false,
    regions: [],
    findings: [],
    missing,
  };
}

export function diffViewport(input: ViewportDiffInput): ViewportDiffOutput {
  const { step, viewport, base, head, options } = input;

  if (base === null || head === null) {
    return {
      diff: emptyDiff(viewport, base, head),
      overlay: null,
      regionSet: null,
      cropSource: head?.image ?? base?.image ?? null,
    };
  }

  const pixels = pixelDiff(base.image, head.image, {
    antialiasTolerance: options.antialiasTolerance,
  });

  const headScale = scaleFor(head.shot, options.deviceScaleFactor);
  const exclude = [
    ...exclusionRects(base, options.ignore, options.deviceScaleFactor),
    ...exclusionRects(head, options.ignore, options.deviceScaleFactor),
  ];

  const regionSet = clusterRegions(pixels.mask, pixels.compared.w, pixels.compared.h, {
    minRegionArea: options.minRegionArea,
    maxRegions: options.maxRegions,
    exclude,
  });

  // ---- stage 5: node matching and classification, before attribution needs `rectChanged`.
  const match = matchNodes(base.shot.dom.nodes, head.shot.dom.nodes);
  const changesByPair = new Map<NodePair, NodeChange[]>();
  const changedNodes = new Set<DomNode>();
  for (const pair of match.pairs) {
    const changes = diffNodePair(pair);
    if (changes.length > 0) changesByPair.set(pair, changes);
    if (rectChanged(pair)) {
      if (pair.base !== null) changedNodes.add(pair.base);
      if (pair.head !== null) changedNodes.add(pair.head);
    }
  }

  const contrastCtx: ContrastContext = {
    baseByPath: byPath(base.shot.dom.nodes),
    headByPath: byPath(head.shot.dom.nodes),
  };
  const verdicts = new Map<NodeChange, Verdict>();
  for (const changes of changesByPair.values()) {
    for (const change of changes) verdicts.set(change, classifyNodeChange(change, contrastCtx));
  }

  const headIndex: IndexedNode[] = buildIndex(head.shot.dom.nodes, headScale, (n) =>
    changedNodes.has(n),
  );
  const baseIndex: IndexedNode[] = buildIndex(
    base.shot.dom.nodes,
    scaleFor(base.shot, options.deviceScaleFactor),
    (n) => changedNodes.has(n),
  );

  const findings: Finding[] = [];
  const emitted = new Set<NodeChange>();

  // ---- the page grew or shrank: a finding in its own right (spec §8, stage 2).
  if (pixels.dimensionsChanged) {
    const cssDelta = Math.max(
      Math.abs(pixels.head.w - pixels.base.w),
      Math.abs(pixels.head.h - pixels.base.h),
    ) / headScale;
    const changes: PropChange[] = [];
    if (pixels.base.w !== pixels.head.w) {
      changes.push({ prop: 'width', from: pixels.base.w, to: pixels.head.w });
    }
    if (pixels.base.h !== pixels.head.h) {
      changes.push({ prop: 'height', from: pixels.base.h, to: pixels.head.h });
    }
    findings.push({
      id: '',
      kind: 'layout',
      severity: cssDelta > LAYOUT_SHIFT_PX ? 'high' : 'med',
      step,
      viewport,
      changes,
      label: 'page size changed',
      reasons: cssDelta > LAYOUT_SHIFT_PX ? ['dimensions-changed', 'layout-shift'] : ['dimensions-changed'],
    });
  }

  // ---- stage 4 + merge: one finding per node change under each region.
  for (const region of regionSet.regions) {
    const attribution = attributeRegion(region.rect, headIndex, baseIndex);
    const node = attribution.node;
    const pair =
      node === null
        ? undefined
        : attribution.side === 'head'
          ? match.byHeadPath.get(node.path)
          : match.byBasePath.get(node.path);
    const changes = pair === undefined ? [] : (changesByPair.get(pair) ?? []);
    const fresh = changes.filter((c) => !emitted.has(c));

    if (fresh.length === 0) {
      // Pixels moved with no DOM explanation — canvas, image or background rendering (D5).
      const regionElement = elementFor(node);
      findings.push({
        id: '',
        kind: 'content',
        severity: 'med',
        step,
        viewport,
        ...(regionElement === undefined ? {} : { element: regionElement }),
        region: region.rect,
        changes: [],
        label: 'visual change',
        reasons: changes.length === 0 ? ['pixels-only'] : ['pixels-only', 'already-reported'],
      });
      continue;
    }

    for (const change of fresh) {
      emitted.add(change);
      const verdict = verdicts.get(change) ?? classifyNodeChange(change, contrastCtx);
      const element = elementFor(change.head ?? change.base ?? node);
      findings.push({
        id: '',
        kind: verdict.kind,
        severity: verdict.severity,
        step,
        viewport,
        ...(element === undefined ? {} : { element }),
        region: region.rect,
        nodeChange: change.kind,
        changes: change.changes,
        label: verdict.label,
        reasons: verdict.reasons,
      });
    }
  }

  // ---- accessibility regressions are reported even when they moved no pixels (spec §8 severity).
  for (const changes of changesByPair.values()) {
    for (const change of changes) {
      if (emitted.has(change)) continue;
      const verdict = verdicts.get(change) ?? classifyNodeChange(change, contrastCtx);
      if (verdict.severity !== 'high' || verdict.kind !== 'a11y') continue;
      emitted.add(change);
      const element = elementFor(change.head ?? change.base);
      findings.push({
        id: '',
        kind: verdict.kind,
        severity: verdict.severity,
        step,
        viewport,
        ...(element === undefined ? {} : { element }),
        nodeChange: change.kind,
        changes: change.changes,
        label: verdict.label,
        reasons: verdict.reasons,
      });
    }
  }

  // ---- the capped remainder, as one entry (spec §8, stage 3).
  if (regionSet.collapsed > 0 && regionSet.collapsedRect !== null) {
    findings.push({
      id: '',
      kind: 'content',
      severity: 'low',
      step,
      viewport,
      region: regionSet.collapsedRect,
      changes: [],
      label: `${regionSet.collapsed} smaller changes`,
      collapsed: { count: regionSet.collapsed },
      reasons: ['collapsed'],
    });
  }

  const regions: Region[] = regionSet.regions;
  const diff: ViewportDiff = {
    viewport,
    pixelChangedRatio: pixels.changedRatio,
    baseSize: pixels.base,
    headSize: pixels.head,
    dimensionsChanged: pixels.dimensionsChanged,
    regions,
    findings: sortFindings(findings),
  };

  return {
    diff,
    overlay: renderPixelOverlay(head.image, pixels),
    regionSet,
    cropSource: head.image,
  };
}
