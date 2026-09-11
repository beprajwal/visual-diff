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
  LOGO_URL,
  MAX_COMMENT_BYTES,
  markerFor,
  renderComment,
  renderCommentWithGate,
} from './comment.js';
import { fakeReview } from '../cli/testing.js';
import { minorDiff } from '../diff/tolerance-testkit.js';
import { commentFingerprint } from './review-triage.js';

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
  it('does not round a small significant pixel change down to zero', () => {
    const result = diffWithFindings(0);
    result.steps[0]!.viewports['1280x800']!.pixelChangedRatio = 0.000002685546875;
    result.summary.maxPixelChangedRatio = 0.000002685546875;
    const { markdown } = renderComment({ result, version: 'test', imageBase: 'https://example.test/images' });
    expect(markdown).toContain('max pixel change <0.1%');
    expect(markdown).toContain('<strong><0.1% of pixels changed</strong>');
    expect(markdown).not.toContain('0.0% of pixels changed');
  });

  it('omits minor changes from all PR surfaces and does not reuse an unfiltered AI review', () => {
    const result = minorDiff();
    const { document, gate } = renderCommentWithGate({ result, version: 'test',
      imageBase: 'https://example.test/images', reportUrl: 'https://example.test/report',
      review: fakeReview({ headline: 'tiny pixel noise' }),
      preview: { light: 'stale-preview.png' },
    }, 'any');
    expect(document.markdown).toContain('No changes above the configured thresholds.');
    expect(document.markdown).toContain('Open the full report');
    expect(document.markdown).not.toContain('minor-step');
    expect(document.markdown).not.toContain('0.3%');
    expect(document.markdown).not.toContain('tiny pixel noise');
    expect(document.markdown).not.toContain('stale-preview.png');
    expect(document.images).toBe(0);
    expect(gate.tripped).toBe(false);
    expect(result.summary.totalFindings).toBe(1);
  });

  it('opens with the marker and then the answer', () => {
    const doc = renderComment({ result: diffWithFindings(3), version: '0.6.0' });
    const lines = doc.markdown.split('\n');
    expect(lines[0]).toBe(doc.marker);
    // The heading carries the mark and the name, so a reader knows whose comment it is at a glance.
    expect(lines.slice(1, 4)).toEqual([
      `## <img src="${LOGO_URL}" width="32" alt="" align="absmiddle"> Visual Diff`,
      '',
      '`checkout` · `0003..0007`',
    ]);
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

  it('renders --report-url as the call to action, next to the verdict', () => {
    const doc = renderComment({
      result: diffWithFindings(2),
      version: '0.6.0',
      reportUrl: 'https://claude.ai/artifacts/abc123',
    });
    const lines = doc.markdown.split('\n');
    const link = lines.findIndex((l) => l.includes('[Open the full report](https://claude.ai/artifacts/abc123)'));
    const footer = lines.findIndex((l) => l.startsWith('---'));
    expect(link).toBeGreaterThan(-1);
    // With the verdict, well before the footer — a footer credit is not a call to action.
    expect(link).toBeLessThan(footer);

    const without = renderComment({ result: diffWithFindings(2), version: '0.6.0' });
    expect(without.markdown).not.toContain('Open the full report');
  });

  it('renders no findings table — the counts live in the verdict and the group headings (D37)', () => {
    const doc = renderComment({
      result: diffWithFindings(30),
      version: '0.6.0',
      imageBase: 'https://example.test/base',
      artifactUrl: 'https://github.com/o/r/actions/runs/1#artifacts',
    });
    expect(doc.markdown).not.toContain('#### Findings');
    expect(doc.markdown).toContain('**30 findings**');
    // Each rendered image group states its own load: pixel ratio plus findings by severity.
    expect(doc.markdown).toMatch(/of pixels changed<\/strong> · \d+ findings? \(/);
  });

  it('shrinks to fit a byte budget: steps table first, then images, never the verdict or footer', () => {
    const input = {
      result: diffWithFindings(40),
      version: '0.6.0',
      imageBase: 'https://example.test/base',
      maxImages: 10,
    };
    const full = renderComment(input);

    // One byte short of the full document: the steps table goes, the images stay (D37).
    const squeezed = renderComment({ ...input, maxBytes: full.bytes - 1 });
    expect(squeezed.bytes).toBeLessThanOrEqual(full.bytes - 1);
    expect(squeezed.truncated.steps).toBe(true);
    expect(squeezed.truncated.images).toBe(0);
    expect(squeezed.markdown).toContain('**40 findings**');
    expect(squeezed.markdown).toContain('vdiff 0.6.0');

    // Tighter still: image groups shrink, the verdict and the footer survive.
    const tiny = renderComment({ ...input, maxBytes: squeezed.bytes - 1 });
    expect(tiny.bytes).toBeLessThanOrEqual(squeezed.bytes - 1);
    expect(tiny.truncated.images).toBeGreaterThan(0);
    expect(tiny.markdown).toContain('**40 findings**');
    expect(tiny.markdown).toContain('vdiff 0.6.0');
  });

  it('stays under GitHub\'s limit by default on a pathological diff', () => {
    const doc = renderComment({
      result: diffWithFindings(400),
      version: '0.6.0',
      imageBase: 'https://example.test/base',
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
    expect(marker).toBeLessThan(doc.markdown.indexOf('<details><summary>All steps'));
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

  it('says the findings channel was off rather than letting "No findings" read as clean (D54)', () => {
    const doc = renderComment({
      result: diffWithFindings(0, { emit: { findings: false, warnings: true } }),
      version: '0.6.0',
    });
    expect(doc.markdown).toContain('**Findings are off for this diff**');
    expect(doc.markdown).toContain('`diff.findings: false`');
  });

  it('names the kinds it never looked for (D57)', () => {
    const doc = renderComment({
      result: diffWithFindings(2, {
        emit: { findings: true, warnings: true, kinds: ['content', 'style', 'layout', 'a11y'] },
      }),
      version: '0.6.0',
    });
    expect(doc.markdown).toContain('**Not looked for in this diff**');
    expect(doc.markdown).toContain('structural, console, network');
  });

  it('says nothing about the channels when both were on', () => {
    const doc = renderComment({ result: diffWithFindings(0), version: '0.6.0' });
    expect(doc.markdown).not.toContain('Findings are off');
  });

  it('escapes a pipe in a step detail so no cell can invent a column', () => {
    const result = diffWithFindings(1);
    const step = result.steps[0];
    if (step === undefined) throw new Error('fixture lost its step');
    step.detail = 'copy changed: "x|y"';

    const doc = renderComment({ result, version: '0.6.0' });
    const row = doc.markdown.split('\n').find((line) => line.includes('copy changed'));
    expect(row).toBeDefined();
    expect(row?.split(' | ')).toHaveLength(6);
    expect(doc.markdown).toContain('x\\|y');
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

describe('renderComment with a review (D39)', () => {
  it('renders the headline, the ranked changes and the attribution between the verdict and the images', () => {
    const doc = renderComment({
      result: diffWithFindings(2),
      version: '0.9.0',
      imageBase: 'https://raw.githubusercontent.com/o/r/vdiff-reports/pr-7/',
      review: fakeReview({
        headline: 'The Pay button now reads "Pay now".',
        changes: [
          {
            step: 'pay-form',
            viewport: '1280x800',
            description: 'The primary button label changed and the button grew 26px.',
            assessment: 'expected',
          },
          {
            step: 'cart',
            viewport: null,
            description: 'The order total wraps onto two lines.',
            assessment: 'regression',
          },
        ],
        concerns: ['The cart total wrapping looks like collateral from the wider button.'],
      }),
    });
    const lines = doc.markdown.split('\n');
    const verdict = lines.findIndex((l) => l.startsWith('**2 findings**'));
    const review = lines.indexOf('#### Review');
    const images = lines.indexOf('#### What changed');
    expect(verdict).toBeGreaterThan(-1);
    expect(review).toBeGreaterThan(verdict);
    expect(images).toBeGreaterThan(review);

    expect(doc.markdown).toContain('**The Pay button now reads "Pay now".**');
    // One flagged change: the warning names the count and the change carries the mark.
    expect(doc.markdown).toContain('> ⚠️ **1 change is not accounted for by this pull request or looks like a regression**');
    expect(doc.markdown).toContain('- ✅ `pay-form` @ 1280x800 — The primary button label changed');
    expect(doc.markdown).toContain('- 🔴 `cart` — The order total wraps onto two lines. _(looks like a regression)_');
    expect(doc.markdown).toContain('**Look before merging:**');
    expect(doc.markdown).toContain('- ⚠️ The cart total wrapping looks like collateral');
    expect(doc.markdown).toContain('Review by claude-opus-5 (Anthropic) from findings.json and 3 screenshots');
  });

  it('says plainly when the model raised nothing, and never renders a review it was not given', () => {
    const quiet = renderComment({ result: diffWithFindings(1), version: '0.9.0', review: fakeReview() });
    expect(quiet.markdown).toContain('_Nothing to raise beyond the changes listed._');
    expect(quiet.markdown).not.toContain('> ⚠️ **');

    const without = renderComment({ result: diffWithFindings(1), version: '0.9.0' });
    expect(without.markdown).not.toContain('#### Review');
  });

  it('is never shrunk away when the body is over budget — the tables go first', () => {
    const input = { result: diffWithFindings(3), version: '0.9.0', review: fakeReview() };
    const full = renderComment(input);
    const doc = renderComment({ ...input, maxBytes: full.bytes - 1 });
    expect(doc.markdown).toContain('#### Review');
    expect(doc.truncated.steps).toBe(true);
  });
});

describe('the picture of the report (D51)', () => {
  const base = 'https://o.github.io/r/pr-7/vdiff/abc/checkout';

  it('opens with the capture, in the reader\'s colour scheme, linking to the report', () => {
    const doc = renderComment({
      result: diffWithFindings(2),
      version: '0.6.0',
      imageBase: base,
      reportUrl: `${base}/report.html`,
      preview: { light: 'images/preview.png', dark: 'images/preview-dark.png' },
      previewDiffFingerprint: commentFingerprint(diffWithFindings(2)),
    });
    const lines = doc.markdown.split('\n');
    const picture = lines.findIndex((l) => l.startsWith('<a href="' + base + '/report.html"><picture>'));
    expect(picture).toBeGreaterThan(0);
    expect(lines[picture]).toContain(
      `<source media="(prefers-color-scheme: dark)" srcset="${base}/images/preview-dark.png">`,
    );
    expect(lines[picture]).toContain(`<img src="${base}/images/preview.png" alt="The visual-diff report for checkout 0003..0007" width="100%">`);
    // Before the model's review and the step images: the picture is the first thing, after the verdict.
    const verdict = lines.findIndex((l) => l.includes('**2 findings**'));
    const images = lines.indexOf('#### What changed');
    expect(picture).toBeGreaterThan(verdict);
    expect(picture).toBeLessThan(images);
  });

  it('is a plain picture without a report URL, and a plain <img> without a dark capture', () => {
    const doc = renderComment({
      result: diffWithFindings(2),
      version: '0.6.0',
      imageBase: base,
      preview: { light: 'images/preview.png' },
      previewDiffFingerprint: commentFingerprint(diffWithFindings(2)),
    });
    expect(doc.markdown).toContain(`<picture><img src="${base}/images/preview.png"`);
    expect(doc.markdown).not.toContain('<a href');
    expect(doc.markdown).not.toContain('prefers-color-scheme');
  });

  it('is not rendered without an image base, like every other image (D31)', () => {
    const doc = renderComment({
      result: diffWithFindings(2),
      version: '0.6.0',
      reportUrl: 'https://example.test/report.html',
      preview: { light: 'images/preview.png', dark: 'images/preview-dark.png' },
    });
    expect(doc.markdown).not.toContain('preview.png');
    expect(doc.markdown).not.toContain('<picture>');
  });
});
