import { describe, expect, it } from 'vitest';

import type { DiffResult } from '../types.js';
import {
  makeDiff,
  makeFinding,
  makeStepDiff,
  makeSummary,
  makeViewportDiff,
} from '../report/ui/test-fixtures.js';
import {
  MAX_COMMENT_BYTES,
  markerFor,
  renderComment,
  renderCommentWithGate,
} from './comment.js';

function diffWithFindings(count: number, patch: Partial<DiffResult> = {}): DiffResult {
  const findings = Array.from({ length: count }, (_, index) =>
    makeFinding(`f${index + 1}`, {
      severity: index === 0 ? 'high' : index % 2 === 0 ? 'med' : 'low',
    }),
  );
  return makeDiff({
    steps: [
      makeStepDiff('pay-form', 'matched', {
        viewports: {
          '1280x800': makeViewportDiff('1280x800', {
            pixelChangedRatio: 0.0341,
            findings,
            pixelPath: 'diffs/checkout/0003..0007/steps/pay-form/1280x800/pixel.png',
          }),
        },
      }),
      makeStepDiff('cart', 'matched', {
        viewports: { '1280x800': makeViewportDiff('1280x800') },
      }),
    ],
    summary: makeSummary({
      totalFindings: count,
      bySeverity: {
        high: findings.filter((f) => f.severity === 'high').length,
        med: findings.filter((f) => f.severity === 'med').length,
        low: findings.filter((f) => f.severity === 'low').length,
      },
      stepsCompared: 2,
      stepsChanged: 1,
      maxPixelChangedRatio: 0.0341,
    }),
    ...patch,
  });
}

describe('markerFor', () => {
  it('is keyed by flow so one comment per flow updates in place', () => {
    expect(markerFor('checkout')).toBe('<!-- vdiff:checkout:pr -->');
    expect(markerFor('checkout', 'nightly')).toBe('<!-- vdiff:checkout:nightly -->');
  });
});

describe('renderComment', () => {
  it('opens with the marker and then the answer', () => {
    const doc = renderComment({ result: diffWithFindings(3), version: '0.6.0' });
    const lines = doc.markdown.split('\n');
    expect(lines[0]).toBe(doc.marker);
    expect(lines[1]).toBe('### visual-diff — `checkout` `0003..0007`');
    expect(doc.markdown).toContain('**3 findings** — 1 high, 1 med, 1 low');
    expect(doc.markdown).toContain('max pixel change 3.4%');
    expect(doc.markdown).toContain('1/2 steps changed');
  });

  it('says so plainly when nothing changed', () => {
    const doc = renderComment({ result: makeDiff({}), version: '0.6.0' });
    expect(doc.markdown).toContain('**No findings.**');
    expect(doc.markdown).not.toContain('#### Findings');
    expect(doc.images).toBe(0);
  });

  it('renders no images without an image base, and images with one', () => {
    const result = diffWithFindings(2);
    const without = renderComment({ result, version: '0.6.0' });
    expect(without.markdown).not.toContain('#### Screenshots');
    expect(without.images).toBe(0);

    const withBase = renderComment({
      result,
      version: '0.6.0',
      imageBase: 'https://raw.githubusercontent.com/o/r/vdiff-reports/pr-7/',
    });
    expect(withBase.images).toBe(1);
    expect(withBase.markdown).toContain(
      '<img src="https://raw.githubusercontent.com/o/r/vdiff-reports/pr-7/images/pay-form/1280x800/pixel.png"',
    );
    // The unchanged cell is not shown: a reviewer wants the step that moved.
    expect(withBase.markdown).not.toContain('images/cart/');
  });

  it('states the number of findings it dropped, and where the rest live', () => {
    const doc = renderComment({
      result: diffWithFindings(30),
      version: '0.6.0',
      maxFindings: 5,
      artifactUrl: 'https://github.com/o/r/actions/runs/1#artifacts',
    });
    expect(doc.truncated.findings).toBe(25);
    expect(doc.markdown).toContain('… 25 more findings — see [`findings.json`]');
  });

  it('shrinks to fit a byte budget without dropping the verdict or the footer', () => {
    const doc = renderComment({
      result: diffWithFindings(40),
      version: '0.6.0',
      imageBase: 'https://example.test/base',
      maxFindings: 40,
      maxImages: 10,
      maxBytes: 2200,
    });
    expect(doc.bytes).toBeLessThanOrEqual(2200);
    expect(doc.markdown).toContain('**40 findings**');
    expect(doc.markdown).toContain('vdiff 0.6.0');
    expect(doc.truncated.findings).toBeGreaterThan(0);
    expect(doc.truncated.steps).toBe(true);
  });

  it('stays under GitHub\'s limit by default on a pathological diff', () => {
    const doc = renderComment({
      result: diffWithFindings(400),
      version: '0.6.0',
      imageBase: 'https://example.test/base',
      maxFindings: 400,
      maxImages: 50,
    });
    expect(doc.bytes).toBeLessThanOrEqual(MAX_COMMENT_BYTES);
  });

  it('carries the pairing notices above everything else', () => {
    const doc = renderComment({
      result: diffWithFindings(1),
      version: '0.6.0',
      notices: ['mock-vs-recorded: one side is a mock-only run with no recording behind it'],
    });
    const marker = doc.markdown.indexOf('> ⚠️ mock-vs-recorded');
    expect(marker).toBeGreaterThan(0);
    expect(marker).toBeLessThan(doc.markdown.indexOf('#### Findings'));
  });

  it('flags an incomplete pair rather than letting it read as clean', () => {
    const doc = renderComment({
      result: diffWithFindings(0, {
        summary: makeSummary({ stepsCompared: 4, stepsFailed: 2, stepsBlocked: 1 }),
      }),
      version: '0.6.0',
    });
    expect(doc.markdown).toContain('**This pair is incomplete.**');
    expect(doc.markdown).toContain('2 step(s) failed');
  });

  it('escapes a pipe and a backtick so no cell can invent a column', () => {
    const result = diffWithFindings(1);
    const finding = result.steps[0]?.viewports['1280x800']?.findings[0];
    if (finding === undefined) throw new Error('fixture lost its finding');
    finding.element = { selector: 'a[href="x|y"]' };
    finding.changes = [{ prop: 'text', from: 'a`b', to: 'c|d' }];

    const doc = renderComment({ result, version: '0.6.0' });
    const row = doc.markdown
      .split('\n')
      .find((line) => line.includes('a[href='));
    expect(row).toBeDefined();
    expect(row?.split(' | ')).toHaveLength(6);
    expect(doc.markdown).toContain('x\\|y');
    expect(doc.markdown).toContain('``a`b``');
  });

  it('renders the gate only when one is configured', () => {
    const result = diffWithFindings(2);
    expect(renderComment({ result, version: '0.6.0' }).markdown).not.toContain('Gate');

    const none = renderCommentWithGate({ result, version: '0.6.0' }, 'none');
    expect(none.document.markdown).not.toContain('Gate');

    const any = renderCommentWithGate({ result, version: '0.6.0' }, 'any');
    expect(any.gate.tripped).toBe(true);
    expect(any.document.markdown).toContain('❌ **Gate failed** — 2 findings (gate: any)');

    const high = renderCommentWithGate({ result, version: '0.6.0' }, 'high');
    expect(high.document.markdown).toContain('❌ **Gate failed** — 1 high-severity finding');
  });

  it('footers the provenance and the commands that reproduce the pair', () => {
    const doc = renderComment({
      result: diffWithFindings(1),
      version: '0.6.0',
      artifactUrl: 'https://example.test/artifact',
      repro: ['vdiff diff checkout 0003 0007', 'vdiff serve --open'],
    });
    expect(doc.markdown).toContain('base `0003` @ `sha-0003`');
    expect(doc.markdown).toContain('engine 1 · vdiff 0.6.0');
    expect(doc.markdown).toContain('[evidence bundle](https://example.test/artifact)');
    expect(doc.markdown).toContain('`vdiff diff checkout 0003 0007`');
  });

  it('names the artifact when there is no URL for it yet', () => {
    const doc = renderComment({
      result: diffWithFindings(1),
      version: '0.6.0',
      artifactName: 'visual-diff',
    });
    expect(doc.markdown).toContain('artifact `visual-diff`');
  });
});
