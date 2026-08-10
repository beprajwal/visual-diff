/**
 * What a pair with an ingested side may claim — and, above all, what an *e2e pair* may not.
 *
 * The claim under test is the one an earlier version of this codebase made in four places at once:
 * that an e2e diff still says "this region changed, and this element is responsible". It never did.
 * A Playwright trace snapshot serialises attributes and no geometry, so ingestion gives every node
 * the rect `{0,0,0,0}` (`e2e/to-shots.ts`), no pixel region intersects any node, and every DOM node
 * change computed for such a pair is discarded before it can become a finding.
 *
 * The user's decision of 2026-08-11 is that this stays — inventing findings a reviewer can neither
 * locate nor check would be worse than reporting pixels — and that the tool says so wherever a user
 * can see it. So the last test here diffs two runs shaped exactly as ingestion shapes them, with a
 * DOM difference that a replay pair would report as a text change on a named element, and asserts
 * that not one finding carries an element or a property. If that assertion ever starts failing
 * because attribution has genuinely been restored (box metrics recovered at ingest), the sentences
 * in `report/e2e.ts` and spec §4 have to change in the same commit: they promise its absence.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { SOURCE_E2E, SOURCE_REPLAY } from '../store/internal/e2e.js';
import type { MaybeE2e } from '../store/internal/e2e.js';
import type { DiffResult, Finding, Rect, Revision } from '../types.js';
import { computeDiff, defaultDiffOptions } from './engine.js';
import {
  attributionOf,
  fidelityOf,
  withoutUnbackedChanges,
  DEGRADED_CAPTURES,
  DEGRADED_REASON,
  FULL_FIDELITY,
  PIXELS_ONLY_REASON,
} from './fidelity.js';
import { domNode, paintRect, solidImage, writeRunFixture } from './testkit.js';
import type { FixtureRun } from './testkit.js';

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempVdiff(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vdiff-fidelity-'));
  dirs.push(dir);
  return path.join(dir, '.visual-diff');
}

describe('attributionOf — how far a pair can locate a change', () => {
  it('gives a replay pair element attribution, which is what slice 1 always had', () => {
    expect(attributionOf(SOURCE_REPLAY, SOURCE_REPLAY)).toBe('element');
    expect(fidelityOf(SOURCE_REPLAY, SOURCE_REPLAY)).toEqual(FULL_FIDELITY);
  });

  it('gives an e2e pair none at all: no geometry on either side', () => {
    expect(attributionOf(SOURCE_E2E, SOURCE_E2E)).toBe('none');
  });

  it('gives a mixed pair the replayed side only, in either direction', () => {
    expect(attributionOf(SOURCE_REPLAY, SOURCE_E2E)).toBe('replay-side-only');
    expect(attributionOf(SOURCE_E2E, SOURCE_REPLAY)).toBe('replay-side-only');
  });

  it('names element geometry among the captures a trace does not carry', () => {
    expect([...DEGRADED_CAPTURES]).toEqual([
      'computed-styles',
      'accessibility-tree',
      'element-geometry',
    ]);
  });
});

describe('the sentence a degraded pair carries', () => {
  it('tells an e2e pair it is a pixel comparison, and never promises an element', () => {
    const fidelity = fidelityOf(SOURCE_E2E, SOURCE_E2E);
    expect(fidelity.level).toBe('degraded');
    expect(fidelity.attribution).toBe('none');
    expect(fidelity.note).toContain('pixel comparison only');
    expect(fidelity.note).toContain('cannot say which element or which property changed');
    // The two phrasings that would put the old, false claim back.
    expect(fidelity.note).not.toContain('DOM attribution');
    expect(fidelity.note).not.toContain('element is responsible');
  });

  it('tells a mixed pair the different truth: the name came from the replayed run', () => {
    const fidelity = fidelityOf(SOURCE_REPLAY, SOURCE_E2E);
    expect(fidelity.level).toBe('degraded');
    expect(fidelity.attribution).toBe('replay-side-only');
    expect(fidelity.note).toContain('any element named below was located in the replayed run alone');
    expect(fidelity.note).toContain('no property-level finding is possible');
  });

  it('leaves the replay pair’s sentence intact — an ordinary diff is unchanged', () => {
    expect(FULL_FIDELITY.attribution).toBe('element');
    expect(FULL_FIDELITY.note).toContain(
      'pixel regions, DOM attribution and property-level findings',
    );
  });
});

/**
 * The behaviour the words above are accountable to. Two runs shaped as ingestion shapes them —
 * `source: 'e2e'`, zero rects, empty styles, no accessibility tree — whose headings genuinely
 * differ, exactly the measured case: 'Saved locations' against 'Your places'.
 */
describe('an e2e pair reports pixels and nothing else (§4, decision of 2026-08-11)', () => {
  const REV: Revision = { sha: 'rev-1', ref: 'main', dirty: false };
  const ZERO: Rect = { x: 0, y: 0, w: 0, h: 0 };
  const HEADING = { x: 12, y: 12, w: 80, h: 20 };

  /**
   * One step of a run. `measured` is the whole difference between the two fixtures below: an
   * ingested run has the zero rect on every node (`UNAVAILABLE_RECT`), a replay run has the
   * rectangles it measured. The DOM, the text and the images are identical either way.
   */
  function step(heading: string, changed: boolean, measured: boolean): FixtureRun['steps'][number] {
    const image = solidImage(120, 120, [255, 255, 255, 255]);
    if (changed) paintRect(image, HEADING, [220, 30, 30, 255]);
    return {
      id: 'locations',
      spec: { goto: '/' },
      shots: [
        {
          viewport: '1280x800',
          image,
          nodes: [
            domNode({
              path: 'html>body',
              rect: measured ? { x: 0, y: 0, w: 120, h: 120 } : ZERO,
              tag: 'body',
            }),
            domNode({
              path: 'html>body>h1',
              parent: 'html>body',
              rect: measured ? HEADING : ZERO,
              tag: 'h1',
              text: heading,
            }),
          ],
        },
      ],
    };
  }

  async function diffOfPair(base: MaybeE2e, head: MaybeE2e, measured: boolean): Promise<DiffResult> {
    const vdiffDir = await tempVdiff();
    const baseRunDir = path.join(vdiffDir, 'runs', 'locations', '0003');
    const headRunDir = path.join(vdiffDir, 'runs', 'locations', '0007');
    await writeRunFixture(baseRunDir, {
      runId: '0003',
      flow: 'locations',
      steps: [step('Saved locations', false, measured)],
      meta: { revision: REV, ...base },
    });
    await writeRunFixture(headRunDir, {
      runId: '0007',
      flow: 'locations',
      steps: [step('Your places', true, measured)],
      meta: { revision: REV, ...head },
    });
    return computeDiff({
      baseRunDir,
      headRunDir,
      vdiffDir,
      options: defaultDiffOptions({ deviceScaleFactor: 1 }),
    });
  }

  const E2E: MaybeE2e = { source: SOURCE_E2E };

  function findingsOf(result: DiffResult): Finding[] {
    return result.steps.flatMap((step) => [
      ...step.findings,
      ...Object.values(step.viewports).flatMap((vp) => vp.findings),
    ]);
  }

  it('reports the changed region, names no element, and lists no property', async () => {
    const findings = findingsOf(await diffOfPair(E2E, E2E, false));

    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.element).toBeUndefined();
      expect(finding.changes).toEqual([]);
      expect(finding.nodeChange).toBeUndefined();
    }
    // What is left is the region, and the two codes that say why there is nothing attached to it.
    const regions = findings.filter((f) => f.region !== undefined);
    expect(regions.length).toBeGreaterThan(0);
    for (const finding of regions) {
      expect(finding.kind).toBe('content');
      expect(finding.reasons).toContain(PIXELS_ONLY_REASON);
      expect(finding.reasons).toContain(DEGRADED_REASON);
    }
  });

  /**
   * The discard is real, and this is what makes it visible: the same DOM difference, the same
   * images, measured rectangles instead of zero ones, and the rename comes back as a text change on
   * a named element. Nothing about the DOM difference is invisible to the engine — only its
   * location is, and location is what a finding needs to exist.
   */
  it('is a text change on a named element once the nodes have real rectangles', async () => {
    const findings = findingsOf(await diffOfPair({}, {}, true));
    expect(findings.some((f) => f.element !== undefined)).toBe(true);
    expect(findings.some((f) => f.changes.some((c) => c.prop === 'text'))).toBe(true);
  });
});

describe('withoutUnbackedChanges — the filter that runs before the discard', () => {
  it('drops what a trace never recorded and keeps what its snapshot genuinely carries', () => {
    const kept = withoutUnbackedChanges([
      {
        kind: 'attr',
        key: 'k',
        keyKind: 'path',
        base: null,
        head: null,
        changes: [
          { prop: 'name', from: 'Pay now', to: null },
          { prop: 'data-test', from: 'pay', to: 'pay-now' },
        ],
      },
      {
        kind: 'style',
        key: 'k',
        keyKind: 'path',
        base: null,
        head: null,
        changes: [{ prop: 'color', from: 'rgb(15, 23, 42)', to: '' }],
      },
    ]);

    expect(kept).toHaveLength(1);
    expect(kept[0]?.kind).toBe('attr');
    expect(kept[0]?.changes.map((c) => c.prop)).toEqual(['data-test']);
  });
});
