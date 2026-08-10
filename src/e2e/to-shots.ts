/**
 * `e2e/` — converting an ingest into the payload the diff engine consumes (e2e spec §4).
 *
 * The diff engine reads a run as `LoadedShot`s: a screenshot on disk, a `DomSnapshot`, an optional
 * `A11ySnapshot`, and a size. An ingested step has to arrive in that shape or nothing downstream
 * works — but three of those fields cannot be filled honestly from a trace, and the difference
 * between "filled with a lie" and "filled with a documented absence" is the whole of §4.
 *
 * **Accessibility tree → `null`.** `LoadedShot.a11y` is already nullable. Nothing to invent.
 *
 * **Computed styles → every property the empty string.** `DomNode.styles` is a required record, so
 * the only choice is what to put in it. Empty is the one value that behaves correctly: two e2e runs
 * both carry empty styles, so the style comparison finds no difference and produces no findings,
 * which is exactly right — no property-level detail was captured, so none can be reported. The
 * alternative, plausible-looking defaults, would manufacture "padding 0px → 0px" non-findings and,
 * worse, would compare as *changed* against a replay run that measured real values.
 *
 * **Rects → zero.** A snapshot carries attributes, never box metrics. A zero rect intersects
 * nothing, so pixel regions simply fail to attribute to an element rather than attributing to the
 * wrong one. `E2eCapabilities.missing` carries `element-geometry` so the report can say why.
 *
 * That last one is a correction to §4, which lists DOM attribution as working for e2e runs. Region
 * detection works; attributing a region to the element beneath it does not, because there is no
 * geometry in the archive to attribute with. Everything else in §4's table stands.
 */

import { CAPTURED_ATTRS, STYLE_PROPS } from '../types.js';
import type {
  A11ySnapshot,
  DomNode,
  DomSnapshot,
  IsoDate,
  StepId,
  StyleSubset,
  ViewportId,
} from '../types.js';
import type { E2eDom, E2eDomNode, E2eShot, E2eStep, E2eTest } from './types.js';

/**
 * The style record every e2e node carries: every captured property, every value empty.
 *
 * Frozen and shared, because it is the same object for every node of every e2e run and its
 * emptiness is a contract rather than an accident.
 */
export const UNAVAILABLE_STYLES: StyleSubset = Object.freeze(
  Object.fromEntries(STYLE_PROPS.map((prop) => [prop, ''])),
) as StyleSubset;

/** The rect every e2e node carries: no geometry exists in a trace to fill it with. */
export const UNAVAILABLE_RECT = Object.freeze({ x: 0, y: 0, w: 0, h: 0 });

/** The accessibility tree an e2e step carries. There is none, at any trace version. */
export const UNAVAILABLE_A11Y: A11ySnapshot | null = null;

/** One step's artifacts, in the shapes the store writes and the diff engine reads. */
export interface E2eShotPayload {
  step: StepId;
  viewport: ViewportId;
  /** The screenshot bytes, still the JPEG the trace stored. */
  screenshot: Uint8Array;
  /** `jpg`, so a caller naming the file does not have to know the encoding. */
  screenshotExtension: 'jpg';
  /** True pixel size of `screenshot`, read from the image and never from the trace event. */
  width: number;
  height: number;
  /**
   * Image pixels per CSS pixel. Playwright downscales screencast frames to fit an 800x800 box, so
   * this is typically well below 1 — and the diff engine needs it to place DOM rects in image
   * space. That it cannot place any (see the header) does not make the number wrong.
   */
  deviceScaleFactor: number;
  dom: DomSnapshot;
  a11y: A11ySnapshot | null;
}

/**
 * Converts one ingested step into its shot payload.
 *
 * Returns `null` when the step has no screenshot: the archive as a whole having no screenshots is
 * an ingest failure (§8), but an individual step without one is only possible when it never touched
 * a page, and a step with nothing to compare is better skipped than written as an empty shot.
 */
export function toShotPayload(
  step: E2eStep,
  viewport: ViewportId,
): E2eShotPayload | null {
  const shot = step.shot;
  if (shot === null) return null;
  return {
    step: step.id,
    viewport,
    screenshot: shot.bytes,
    screenshotExtension: 'jpg',
    width: shot.width,
    height: shot.height,
    deviceScaleFactor: shot.scale,
    dom: toDomSnapshot(step, viewport, shot),
    a11y: UNAVAILABLE_A11Y,
  };
}

/** Every step of a test that has a shot, in order. */
export function toShotPayloads(test: E2eTest): E2eShotPayload[] {
  const viewport = test.viewport ?? viewportOf(test);
  const payloads: E2eShotPayload[] = [];
  for (const step of test.steps) {
    const payload = toShotPayload(step, viewport);
    if (payload !== null) payloads.push(payload);
  }
  return payloads;
}

/**
 * The viewport id for a test whose archive did not record one.
 *
 * Falls back to the logical viewport of the first shot, which the screencast events do carry, and
 * then to the store's own default shape so the id is always well-formed.
 */
function viewportOf(test: E2eTest): ViewportId {
  for (const step of test.steps) {
    if (step.shot !== null) return `${step.shot.viewport.w}x${step.shot.viewport.h}`;
  }
  return '0x0';
}

/** An ingested DOM snapshot in the store's shape, with the absences filled as documented above. */
export function toDomSnapshot(step: E2eStep, viewport: ViewportId, shot: E2eShot): DomSnapshot {
  const dom: E2eDom | null = step.dom;
  const capturedAt: IsoDate = dom?.capturedAt ?? shot.capturedAt;
  const document =
    dom === null ? { w: shot.viewport.w, h: shot.viewport.h } : { w: dom.viewport.w, h: dom.viewport.h };
  return {
    step: step.id,
    viewport,
    url: dom?.url ?? step.url ?? '',
    capturedAt,
    deviceScaleFactor: shot.scale,
    document,
    nodeCount: dom?.nodes.length ?? 0,
    // The 5,000-node cap belongs to the runner's in-page capture; a trace snapshot is whatever the
    // recorder stored, and is never truncated by us.
    truncated: false,
    // §5's `ignore` list is applied by the ingest layer against the run, not baked into a snapshot.
    masks: [],
    nodes: (dom?.nodes ?? []).map(toDomNode),
  };
}

function toDomNode(node: E2eDomNode): DomNode {
  const out: DomNode = {
    path: node.path,
    parent: node.parent,
    depth: node.depth,
    tag: node.tag,
    rect: { ...UNAVAILABLE_RECT },
    // Every node in a snapshot was in the rendered document; without styles or geometry there is no
    // stronger statement available, and marking them all invisible would hide the DOM entirely.
    visible: true,
    styles: UNAVAILABLE_STYLES,
    attrs: pickCapturedAttrs(node.attrs),
  };
  if (node.testId !== undefined) out.testId = node.testId;
  if (node.role !== undefined) out.role = node.role;
  if (node.text !== undefined) out.text = node.text;
  return out;
}

/**
 * `DomNode.attrs` is a closed subset (`CAPTURED_ATTRS`), and the diff's `attr` finding kind is
 * defined over it. A snapshot carries every author attribute, so the extras are dropped here rather
 * than widening a shape the diff engine has opinions about.
 */
function pickCapturedAttrs(attrs: Record<string, string>): DomNode['attrs'] {
  const out: Record<string, string> = {};
  for (const attr of CAPTURED_ATTRS) {
    const value = attrs[attr];
    if (value !== undefined) out[attr] = value;
  }
  return out as DomNode['attrs'];
}
