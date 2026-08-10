/**
 * Stages 2–5 for one (step, viewport) shot pair: pixel diff → region clustering → DOM attribution
 * → node diff → findings (spec §8).
 *
 * Pure: images and snapshots in, a `ViewportDiff` plus the artifacts the engine writes out. All
 * geometry it returns is image-space, matching `pixel.png`, `regions.json` and the crops.
 *
 * Config `ignore` applies to every finding-producing path here, not only to region clustering: an
 * ignored node (and its subtree) contributes no region, no node change — including the
 * pixel-free a11y pass — and no page-size finding it alone explains. Half-applied noise control is
 * worse than none, because the user believes the element is covered.
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
import { withoutUnbackedChanges } from './fidelity.js';
import { pixelDiff, renderPixelOverlay } from './pixel.js';
import { ignoreSelectorWarnings, matchesAny, selectorFor } from './selector.js';

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
  /**
   * The pair could not compare computed styles or the accessibility tree, because one or both runs
   * were ingested from a Playwright trace (e2e spec §4). Property-level node changes are dropped
   * rather than reported against data one side never had — see `withoutUnbackedChanges`. Optional
   * and false by default, so every replay caller is unaffected.
   */
  degraded?: boolean;
}

export interface ViewportDiffOutput {
  diff: ViewportDiff;
  /** `pixel.png` content, when a comparison actually happened. */
  overlay: PixelImage | null;
  regionSet: ClusterResult | null;
  /** The image crops are cut from: head where it exists, base for a removed step. */
  cropSource: PixelImage | null;
  /**
   * Configuration problems found while applying this diff — today, `diff.ignore` entries the
   * selector matcher cannot evaluate. Identical for every (step, viewport) of a run, so the caller
   * de-duplicates before merging them into `DiffResult.warnings`.
   */
  warnings: string[];
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

/**
 * Every node covered by config `ignore`: the nodes matching a selector, plus their descendants.
 *
 * The subtree is included because the contract is stated in rects — an ignored node's rect covers
 * its children, so a child-level finding would contradict the region that was already excluded.
 * Ignoring `[data-test=session-id]` has to mean the whole widget, not just its outermost box.
 */
export function ignoredNodes(
  nodes: readonly DomNode[],
  ignore: readonly string[],
): Set<DomNode> {
  const out = new Set<DomNode>();
  if (ignore.length === 0) return out;

  const nodeByPath = byPath(nodes);
  const verdict = new Map<string, boolean>();

  // Walked iteratively, and every node on the walked chain is memoized: a 5,000-node capture is
  // one pass, and a malformed parent chain can neither recurse deeply nor loop forever.
  const resolve = (start: DomNode): boolean => {
    const chain: DomNode[] = [];
    const seen = new Set<string>();
    let result = false;
    let current: DomNode | undefined = start;

    while (current !== undefined) {
      const cached = verdict.get(current.path);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      if (seen.has(current.path)) break;
      seen.add(current.path);
      chain.push(current);
      if (matchesAny(current, ignore)) {
        result = true;
        break;
      }
      current = current.parent === null ? undefined : nodeByPath.get(current.parent);
    }

    for (const node of chain) verdict.set(node.path, result);
    return result;
  };

  for (const node of nodes) if (resolve(node)) out.add(node);
  return out;
}

/** Flow `mask` rects plus the rects of nodes matching config `ignore`, in image space. */
export function exclusionRects(
  side: ShotSide | null,
  ignore: readonly string[],
  fallbackScale: number,
  /** Pre-computed {@link ignoredNodes} for this side, to avoid matching the tree twice. */
  ignored?: ReadonlySet<DomNode>,
): Rect[] {
  if (side === null) return [];
  const scale = scaleFor(side.shot, fallbackScale);
  const out: Rect[] = side.shot.dom.masks.map((r) => roundRect(scaleRect(r, scale)));
  if (ignore.length > 0) {
    const covered = ignored ?? ignoredNodes(side.shot.dom.nodes, ignore);
    for (const node of side.shot.dom.nodes) {
      if (!covered.has(node)) continue;
      out.push(roundRect(scaleRect(node.rect, scale)));
    }
  }
  return out;
}

/**
 * Signed size deltas, in CSS pixels, contributed by the ignored nodes along one axis: a pair that
 * resized, an ignored node that appeared (its full extent), or one that disappeared (negative).
 */
function ignoredDeltas(pairs: readonly NodePair[], axis: 'w' | 'h'): number[] {
  const out: number[] = [];
  for (const pair of pairs) {
    const delta =
      pair.base !== null && pair.head !== null
        ? pair.head.rect[axis] - pair.base.rect[axis]
        : pair.head !== null
          ? pair.head.rect[axis]
          : pair.base === null
            ? 0
            : -pair.base.rect[axis];
    if (Math.abs(delta) > SIZE_ATTRIBUTION_EPSILON) out.push(delta);
  }
  return out;
}

/** A page-size delta this close (CSS px) to the ignored contribution counts as explained by it. */
const SIZE_ATTRIBUTION_EPSILON = 1;

/**
 * True when the ignored nodes alone account for a page-size delta — either one of them changed by
 * exactly that much, or their contributions sum to it. An ignored banner that grows the document
 * must not resurface as a `page size changed` finding: that is the same noise under another name.
 */
function ignoredExplainsSize(
  pairs: readonly NodePair[],
  axis: 'w' | 'h',
  pageDeltaCss: number,
): boolean {
  const deltas = ignoredDeltas(pairs, axis);
  if (deltas.length === 0) return false;
  const total = deltas.reduce((sum, d) => sum + d, 0);
  return [...deltas, total].some(
    (candidate) => Math.abs(candidate - pageDeltaCss) <= SIZE_ATTRIBUTION_EPSILON,
  );
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
  // An ignore rule that cannot be evaluated must never pass for a rule that matched nothing.
  const warnings = ignoreSelectorWarnings(options.ignore);

  if (base === null || head === null) {
    return {
      diff: emptyDiff(viewport, base, head),
      overlay: null,
      regionSet: null,
      cropSource: head?.image ?? base?.image ?? null,
      warnings,
    };
  }

  const pixels = pixelDiff(base.image, head.image, {
    antialiasTolerance: options.antialiasTolerance,
  });

  const headScale = scaleFor(head.shot, options.deviceScaleFactor);

  // `ignore` is a findings contract, not just a region filter (spec §8, noise control): an ignored
  // node contributes no region, no node change, and no page-size finding of its own.
  const ignoredBase = ignoredNodes(base.shot.dom.nodes, options.ignore);
  const ignoredHead = ignoredNodes(head.shot.dom.nodes, options.ignore);
  const isIgnored = (node: DomNode | null): boolean =>
    node !== null && (ignoredHead.has(node) || ignoredBase.has(node));

  const exclude = [
    ...exclusionRects(base, options.ignore, options.deviceScaleFactor, ignoredBase),
    ...exclusionRects(head, options.ignore, options.deviceScaleFactor, ignoredHead),
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
  /** Ignored pairs are kept only to attribute a page-size change; they never produce findings. */
  const ignoredPairs: NodePair[] = [];
  for (const pair of match.pairs) {
    if (isIgnored(pair.base) || isIgnored(pair.head)) {
      ignoredPairs.push(pair);
      continue;
    }
    // On a degraded pair the style subset and the a11y-derived attributes are absent from the
    // ingested side, so comparing them would manufacture a change out of a missing capture — and,
    // on a mixed pair, a high-severity "lost accessible name" for every named element (§4).
    const changes =
      input.degraded === true
        ? withoutUnbackedChanges(diffNodePair(pair))
        : diffNodePair(pair);
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

  // Ignored nodes are kept out of attribution entirely, so a surviving region is explained by the
  // nearest element the user still cares about rather than by the thing they asked to ignore.
  const headIndex: IndexedNode[] = buildIndex(
    head.shot.dom.nodes.filter((n) => !ignoredHead.has(n)),
    headScale,
    (n) => changedNodes.has(n),
  );
  const baseIndex: IndexedNode[] = buildIndex(
    base.shot.dom.nodes.filter((n) => !ignoredBase.has(n)),
    scaleFor(base.shot, options.deviceScaleFactor),
    (n) => changedNodes.has(n),
  );

  const findings: Finding[] = [];
  const emitted = new Set<NodeChange>();

  // ---- the page grew or shrank: a finding in its own right (spec §8, stage 2).
  // Each axis is reported only when the ignored nodes do not already account for it; a page that
  // grew solely because an ignored banner grew yields no finding at all.
  if (pixels.dimensionsChanged) {
    const changes: PropChange[] = [];
    if (
      pixels.base.w !== pixels.head.w &&
      !ignoredExplainsSize(ignoredPairs, 'w', (pixels.head.w - pixels.base.w) / headScale)
    ) {
      changes.push({ prop: 'width', from: pixels.base.w, to: pixels.head.w });
    }
    if (
      pixels.base.h !== pixels.head.h &&
      !ignoredExplainsSize(ignoredPairs, 'h', (pixels.head.h - pixels.base.h) / headScale)
    ) {
      changes.push({ prop: 'height', from: pixels.base.h, to: pixels.head.h });
    }
    if (changes.length > 0) {
      const cssDelta =
        Math.max(...changes.map((c) => Math.abs(Number(c.to) - Number(c.from)))) / headScale;
      findings.push({
        id: '',
        kind: 'layout',
        severity: cssDelta > LAYOUT_SHIFT_PX ? 'high' : 'med',
        step,
        viewport,
        changes,
        label: 'page size changed',
        reasons:
          cssDelta > LAYOUT_SHIFT_PX ? ['dimensions-changed', 'layout-shift'] : ['dimensions-changed'],
      });
    }
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
    warnings,
  };
}
