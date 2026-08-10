/**
 * Test support: builds the small synthetic run directories the golden tests diff (spec §11.3).
 *
 * It writes the real spec §6 layout — `meta.json`, `flow.snapshot.yaml`,
 * `steps/<id>/{step.json,console.json,network.json}` and `steps/<id>/<viewport>/*` — so the golden
 * tests exercise the same reader the CLI uses, not a shortcut.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { SCENARIO_NONE, STYLE_PROPS } from '../types.js';
import type {
  A11ySnapshot,
  ConsoleEntry,
  DomNode,
  DomSnapshot,
  FlowSnapshot,
  NetworkEntry,
  PixelImage,
  Rect,
  RunMeta,
  Step,
  StepId,
  StepResult,
  StepStatus,
  StyleSubset,
  ViewportId,
} from '../types.js';
import { VARIANT_NONE } from '../store/internal/variant.js';
import type { MaybeVariant, VariantRunMeta } from '../store/internal/variant.js';
import { SOURCE_REPLAY } from '../store/internal/e2e.js';
import type { MaybeE2e, RunSource } from '../store/internal/e2e.js';
import { createImage, encodePng } from './pixel.js';

export type Rgba = [number, number, number, number];

export function solidImage(width: number, height: number, color: Rgba = [255, 255, 255, 255]): PixelImage {
  return createImage(width, height, color);
}

export function paintRect(image: PixelImage, rect: Rect, color: Rgba): PixelImage {
  for (let y = Math.max(0, rect.y); y < Math.min(image.height, rect.y + rect.h); y += 1) {
    for (let x = Math.max(0, rect.x); x < Math.min(image.width, rect.x + rect.w); x += 1) {
      const i = (y * image.width + x) * 4;
      image.data[i] = color[0];
      image.data[i + 1] = color[1];
      image.data[i + 2] = color[2];
      image.data[i + 3] = color[3];
    }
  }
  return image;
}

export function defaultStyles(overrides: Partial<StyleSubset> = {}): StyleSubset {
  const base = Object.fromEntries(STYLE_PROPS.map((p) => [p, ''])) as StyleSubset;
  return { ...base, ...overrides };
}

export function domNode(
  init: Omit<Partial<DomNode>, 'styles'> & {
    path: string;
    rect: Rect;
    /** Only the properties under test; the rest of the closed style subset defaults to ''. */
    styles?: Partial<StyleSubset>;
  },
): DomNode {
  return {
    parent: null,
    depth: init.path.split('>').length - 1,
    tag: 'div',
    visible: true,
    attrs: {},
    ...init,
    styles: defaultStyles(init.styles),
  };
}

export interface FixtureShot {
  viewport: ViewportId;
  image: PixelImage;
  nodes?: DomNode[];
  masks?: Rect[];
  /** Screenshot pixels per CSS pixel. Defaults to 1 so fixtures can use image coordinates. */
  deviceScaleFactor?: number;
  a11y?: A11ySnapshot;
}

export interface FixtureStep {
  id: StepId;
  /** The step as it appears in flow.snapshot.yaml. */
  spec?: Partial<Step>;
  status?: StepStatus;
  shots?: FixtureShot[];
  console?: ConsoleEntry[];
  network?: NetworkEntry[];
  failureMessage?: string;
}

export interface FixtureRun {
  runId: string;
  flow?: string;
  viewports?: ViewportId[];
  steps: FixtureStep[];
  meta?: Partial<RunMeta> & MaybeVariant & MaybeE2e;
}

const EPOCH = '2026-08-08T10:00:00.000Z';

/**
 * `source` is typed loosely on purpose: the §8 case "a run records a source this version does not
 * know" has to be constructible from a fixture, and it is a string on disk.
 */
function metaFor(
  run: FixtureRun,
  viewports: ViewportId[],
): VariantRunMeta & { source: RunSource | string } {
  return {
    runId: run.runId,
    flow: run.flow ?? 'checkout',
    // Overridable through `meta`; a fixture that says nothing is the slice-1 case (mocking §6).
    scenario: SCENARIO_NONE,
    // Likewise on the variant axis: nothing said means the unmodified page (variants §5).
    variant: VARIANT_NONE,
    // And on the source axis: nothing said means a run vdiff captured itself (e2e §7). A fixture
    // sets `meta: { source: 'e2e' }` to stand in for one ingested from a trace.
    source: SOURCE_REPLAY,
    flowHash: 'sha256:fixture',
    revision: { sha: `sha-${run.runId}`, ref: 'main', dirty: false },
    mode: 'attach',
    network: 'replay',
    harHits: 0,
    harMisses: 0,
    viewports,
    status: 'ok',
    failedSteps: run.steps.filter((s) => s.status === 'failed').map((s) => s.id),
    env: {
      tool: '0.1.0',
      node: 'v20.0.0',
      playwright: '1.49.0',
      chromium: '131',
      os: 'darwin-arm64',
      deviceScaleFactor: 1,
    },
    startedAt: EPOCH,
    finishedAt: EPOCH,
    unstable: false,
    pinned: false,
    pruned: false,
    warnings: [],
    ...run.meta,
  };
}

function flowSnapshot(run: FixtureRun, viewports: ViewportId[]): FlowSnapshot {
  return {
    version: 1,
    flow: run.flow ?? 'checkout',
    viewports,
    network: { mode: 'replay', har: 'checkout.har' },
    steps: run.steps.map((s) => ({ id: s.id, ...(s.spec ?? {}) })),
  };
}

function domSnapshot(step: FixtureStep, shot: FixtureShot): DomSnapshot {
  const dsf = shot.deviceScaleFactor ?? 1;
  return {
    step: step.id,
    viewport: shot.viewport,
    url: 'http://localhost:5173/',
    capturedAt: EPOCH,
    deviceScaleFactor: dsf,
    document: { w: shot.image.width / dsf, h: shot.image.height / dsf },
    nodeCount: (shot.nodes ?? []).length,
    truncated: false,
    masks: shot.masks ?? [],
    nodes: shot.nodes ?? [],
  };
}

function stepResult(step: FixtureStep, index: number, shots: FixtureShot[]): StepResult {
  const result: StepResult = {
    id: step.id,
    index,
    status: step.status ?? 'ok',
    shoot: shots.length > 0,
    startedAt: EPOCH,
    finishedAt: EPOCH,
    durationMs: 10,
    viewports: Object.fromEntries(
      shots.map((s) => [
        s.viewport,
        {
          viewport: s.viewport,
          screenshot: `steps/${step.id}/${s.viewport}/screenshot.png`,
          dom: `steps/${step.id}/${s.viewport}/dom.json`,
          a11y: `steps/${step.id}/${s.viewport}/a11y.json`,
          width: s.image.width,
          height: s.image.height,
          nodeCount: (s.nodes ?? []).length,
          truncated: false,
        },
      ]),
    ),
    truncated: false,
    consoleErrors: (step.console ?? []).filter((c) => c.level === 'error').length,
    networkRequests: (step.network ?? []).length,
    harMisses: (step.network ?? []).filter((n) => n.harMatch === 'miss').length,
  };
  if (step.failureMessage !== undefined) {
    result.failure = { message: step.failureMessage };
  }
  return result;
}

/** Writes a complete run directory and returns its path. */
export async function writeRunFixture(runDir: string, run: FixtureRun): Promise<string> {
  const viewports =
    run.viewports ??
    [...new Set(run.steps.flatMap((s) => (s.shots ?? []).map((shot) => shot.viewport)))].sort();

  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, 'meta.json'),
    `${JSON.stringify(metaFor(run, viewports), null, 2)}\n`,
  );
  await writeFile(
    path.join(runDir, 'flow.snapshot.yaml'),
    stringifyYaml(flowSnapshot(run, viewports)),
  );

  for (const [index, step] of run.steps.entries()) {
    const stepDir = path.join(runDir, 'steps', step.id);
    await mkdir(stepDir, { recursive: true });
    const shots = step.shots ?? [];
    await writeFile(
      path.join(stepDir, 'step.json'),
      `${JSON.stringify(stepResult(step, index, shots), null, 2)}\n`,
    );
    await writeFile(
      path.join(stepDir, 'console.json'),
      `${JSON.stringify(step.console ?? [], null, 2)}\n`,
    );
    await writeFile(
      path.join(stepDir, 'network.json'),
      `${JSON.stringify(step.network ?? [], null, 2)}\n`,
    );

    for (const shot of shots) {
      const vpDir = path.join(stepDir, shot.viewport);
      await mkdir(vpDir, { recursive: true });
      await writeFile(path.join(vpDir, 'screenshot.png'), encodePng(shot.image));
      await writeFile(
        path.join(vpDir, 'dom.json'),
        `${JSON.stringify(domSnapshot(step, shot), null, 2)}\n`,
      );
      await writeFile(
        path.join(vpDir, 'a11y.json'),
        `${JSON.stringify(shot.a11y ?? { step: step.id, viewport: shot.viewport, root: null }, null, 2)}\n`,
      );
    }
  }

  return runDir;
}

export function consoleEntry(
  step: StepId,
  level: ConsoleEntry['level'],
  text: string,
  viewport: ViewportId = '1280x800',
): ConsoleEntry {
  return { step, viewport, level, text, ts: EPOCH };
}

export function networkEntry(
  step: StepId,
  url: string,
  init: Partial<NetworkEntry> = {},
): NetworkEntry {
  return {
    step,
    viewport: '1280x800',
    method: 'GET',
    url,
    status: 200,
    resourceType: 'fetch',
    harMatch: 'hit',
    durationMs: 5,
    ...init,
  };
}
