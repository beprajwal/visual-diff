/**
 * `vdiff comment` and `vdiff export` against the in-memory ports, with the real renderer and the
 * real bundle writer behind them (CI spec §10).
 *
 * What is asserted here is the *command's* contract, not the markdown's — the goldens for the body
 * live in `src/ci/comment.test.ts`. Three things belong to this layer and only this layer:
 *
 *  - the gate's exit code (3, and only when a level was named and tripped — D30);
 *  - the fact that neither command posts, pushes or uploads anything (D29);
 *  - human mode putting the markdown alone on stdout, so `vdiff comment flow > body.md` works.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT, type DiffResult } from '../../types.js';
import type { CommandContext } from '../command.js';
import { significanceFingerprint } from '../../diff/significance.js';
import { minorDiff } from '../../diff/tolerance-testkit.js';
import {
  createTestPorts,
  createTestStore,
  fakeConfig,
  fakeDiffResult,
  fakeRunSummary,
} from '../testing.js';
import { comment } from './comment.js';
import { exportCommand } from './export.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vdiff-comment-'));
  dirs.push(dir);
  return dir;
}

function diffWith(findings: number, high = 0): DiffResult {
  return fakeDiffResult({
    summary: {
      totalFindings: findings,
      bySeverity: { high, med: findings - high, low: 0 },
      byKind: {
        content: findings,
        style: 0,
        layout: 0,
        structural: 0,
        a11y: 0,
        console: 0,
        network: 0,
      },
      stepsCompared: 3,
      stepsChanged: 1,
      stepsAdded: 0,
      stepsRemoved: 0,
      stepsSpecChanged: 0,
      stepsFailed: 0,
      stepsBlocked: 0,
      maxPixelChangedRatio: 0.02,
    },
  });
}

/** A context whose store already holds a computed diff for `checkout 0003..0007`. */
function context(result: DiffResult, cwd = '/project'): CommandContext {
  const store = createTestStore({
    runs: { checkout: [fakeRunSummary({ runId: '0003' }), fakeRunSummary({ runId: '0007' })] },
    diffs: { 'checkout/0003..0007': result },
  });
  return {
    cwd,
    ports: createTestPorts({ openStore: async () => store }),
    version: '0.6.0',
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    waitForShutdown: async () => undefined,
  };
}

const invocation = {
  kind: 'comment' as const,
  flow: 'checkout',
  e2e: false,
  failOn: 'none' as const,
  json: false,
};

describe('vdiff comment', () => {
  it('puts the markdown alone on stdout and exits 0', async () => {
    const result = await comment(context(diffWith(2)), invocation);
    expect(result.exitCode ?? EXIT.OK).toBe(EXIT.OK);
    expect(result.human[0]).toBe('<!-- vdiff:checkout:pr -->');
    expect(result.human.join('\n')).toContain('**2 findings**');
    expect(result.data.marker).toBe('<!-- vdiff:checkout:pr -->');
    expect(result.data.path).toBeNull();
  });

  it('reuses the stored diff rather than recomputing it', async () => {
    const store = createTestStore({
      runs: { checkout: [fakeRunSummary({ runId: '0003' }), fakeRunSummary({ runId: '0007' })] },
      diffs: { 'checkout/0003..0007': diffWith(1) },
    });
    await comment(
      {
        cwd: '/project',
        ports: createTestPorts({ openStore: async () => store }),
        version: '0.6.0',
        spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
        waitForShutdown: async () => undefined,
      },
      invocation,
    );
    expect(store.state.calls).not.toContain('writeDiff checkout/0003..0007');
  });

  it('writes --out and reports the path instead of the body', async () => {
    const dir = await tempDir();
    const result = await comment(context(diffWith(1), dir), {
      ...invocation,
      out: 'body.md',
    });
    const written = join(dir, 'body.md');
    expect(result.data.path).toBe(written);
    expect(result.human).toEqual([written]);
    expect(await readFile(written, 'utf8')).toContain('<!-- vdiff:checkout:pr -->');
  });

  it('never gates by default, whatever the findings', async () => {
    const result = await comment(context(diffWith(40, 12)), invocation);
    expect(result.exitCode ?? EXIT.OK).toBe(EXIT.OK);
    expect(result.data.gate).toEqual({
      level: 'none',
      tripped: false,
      reason: 'no gate: findings are reported, never enforced',
    });
  });

  it('exits 3 — not 1 — when an asked-for gate trips', async () => {
    const high = await comment(context(diffWith(3, 1)), { ...invocation, failOn: 'high' });
    expect(high.exitCode).toBe(EXIT.GATE_FAILED);
    expect(high.exitCode).not.toBe(EXIT.RUN_FAILURE);
    expect(high.warnings).toContain('gate failed: 1 high-severity finding (gate: high)');
    // The body is still produced: a red check with no explanation is the worst outcome (D35).
    expect(high.data.markdown).toContain('❌ **Gate failed**');
  });

  it('says a gate cannot trip when the project turned findings off (D54)', async () => {
    const suppressed = diffWith(0);
    suppressed.emit = { findings: false, warnings: true };
    const config = fakeConfig();
    config.diff.findings = false;
    const ctx: CommandContext = {
      ...context(suppressed),
      ports: createTestPorts({
        loadConfig: async () => config,
        openStore: async () =>
          createTestStore({
            runs: {
              checkout: [fakeRunSummary({ runId: '0003' }), fakeRunSummary({ runId: '0007' })],
            },
            diffs: { 'checkout/0003..0007': suppressed },
          }),
      }),
    };

    const result = await comment(ctx, { ...invocation, failOn: 'high' });
    expect(result.exitCode ?? EXIT.OK).toBe(EXIT.OK);
    expect(result.warnings).toContain(
      '--fail-on high cannot trip: findings are off for this diff, so the gate has nothing to count',
    );

    // Nothing of the sort when no gate was asked for: `none` gates nothing either way.
    const ungated = await comment(ctx, invocation);
    expect((ungated.warnings ?? []).some((w) => w.includes('cannot trip'))).toBe(false);
  });

  it('does not trip a gate the findings do not reach', async () => {
    const result = await comment(context(diffWith(4, 0)), { ...invocation, failOn: 'high' });
    expect(result.exitCode ?? EXIT.OK).toBe(EXIT.OK);
    expect(result.data.markdown).toContain('✅ Gate passed');
  });

  it('says why a changed pair shows no screenshots when no image base was given', async () => {
    const result = await comment(context(diffWith(2)), invocation);
    expect(result.data.images).toBe(0);
    expect(result.warnings?.join(' ')).toContain('no --image-base given');
  });

  it('opens with the picture of the report only when the bundle holds it (D51)', async () => {
    const dir = await tempDir();
    // No bundle named: no picture, whatever the image base.
    const bare = await comment(context(diffWith(2), dir), {
      ...invocation,
      imageBase: 'https://example.test/base',
    });
    expect(bare.data.preview).toBe(false);
    expect(bare.data.markdown).not.toContain('preview.png');

    // A bundle without the captures: still no picture — the files are checked, not assumed.
    await mkdir(join(dir, 'bundle', 'images'), { recursive: true });
    const empty = await comment(context(diffWith(2), dir), {
      ...invocation,
      imageBase: 'https://example.test/base',
      bundle: 'bundle',
    });
    expect(empty.data.preview).toBe(false);

    // The light capture alone: a plain <img>, no dark source.
    await writeFile(join(dir, 'bundle', 'images', 'preview.png'), 'png');
    const light = await comment(context(diffWith(2), dir), {
      ...invocation,
      imageBase: 'https://example.test/base',
      bundle: 'bundle',
    });
    expect(light.data.preview).toBe(true);
    expect(light.data.markdown).toContain('<img src="https://example.test/base/images/preview.png"');
    expect(light.data.markdown).not.toContain('prefers-color-scheme');

    // Both captures: the dark one rides as a <source>.
    await writeFile(join(dir, 'bundle', 'images', 'preview-dark.png'), 'png');
    const both = await comment(context(diffWith(2), dir), {
      ...invocation,
      imageBase: 'https://example.test/base',
      bundle: 'bundle',
    });
    expect(both.data.markdown).toContain(
      '<source media="(prefers-color-scheme: dark)" srcset="https://example.test/base/images/preview-dark.png">',
    );

    // Without an image base the bundle is not even consulted (D31).
    const noBase = await comment(context(diffWith(2), dir), { ...invocation, bundle: 'bundle' });
    expect(noBase.data.preview).toBe(false);
  });

  it('carries the renderer verdicts through to the JSON payload', async () => {
    const result = await comment(context(diffWith(2)), {
      ...invocation,
      imageBase: 'https://example.test/base',
      maxImages: 0,
    });
    expect(result.data.truncated).toEqual({ images: 0, steps: false });
    expect(result.data.bytes).toBeGreaterThan(0);
  });

  it('forwards a captured preview fingerprint so a filtered preview remains usable', async () => {
    const dir = await tempDir();
    const raw = minorDiff();
    const diff = fakeDiffResult({ steps: raw.steps, summary: raw.summary });
    const fingerprint = significanceFingerprint(diff);
    await mkdir(join(dir, 'bundle', 'images'), { recursive: true });
    await writeFile(join(dir, 'bundle', 'images', 'preview.png'), 'png');
    await writeFile(join(dir, 'bundle', 'images', 'preview.json'), JSON.stringify({
      diffFingerprint: fingerprint,
    }));
    const ctx = context(diff, dir);
    const render = ctx.ports.renderComment;
    let forwarded: string | undefined;
    ctx.ports.renderComment = async (input) => {
      forwarded = input.previewDiffFingerprint;
      return render(input);
    };
    const result = await comment(ctx, {
      ...invocation, bundle: 'bundle', imageBase: 'https://example.test/base',
    });
    expect(forwarded).toBe(fingerprint);
    expect(result.data.preview).toBe(true);
    expect(result.data.markdown).toContain('https://example.test/base/images/preview.png');
  });

  it.each([
    ['missing', undefined],
    ['malformed', '{'],
    ['null', 'null'],
    ['wrong shape', JSON.stringify({ diffFingerprint: 7 })],
    ['empty', JSON.stringify({ diffFingerprint: '' })],
    ['stale', JSON.stringify({ diffFingerprint: 'b'.repeat(64) })],
  ])('omits a tolerant diff preview when its capture stamp is %s', async (_label, manifest) => {
    const dir = await tempDir();
    const raw = minorDiff();
    const diff = fakeDiffResult({ steps: raw.steps, summary: raw.summary });
    await mkdir(join(dir, 'bundle', 'images'), { recursive: true });
    await writeFile(join(dir, 'bundle', 'images', 'preview.png'), 'png');
    if (manifest !== undefined) {
      await writeFile(join(dir, 'bundle', 'images', 'preview.json'), manifest);
    }
    const result = await comment(context(diff, dir), {
      ...invocation, bundle: 'bundle', imageBase: 'https://example.test/base',
    });
    expect(result.data.preview).toBe(false);
    expect(result.data.markdown).not.toContain('preview.png');
  });
});

describe('vdiff export', () => {
  const exportInvocation = {
    kind: 'export' as const,
    flow: 'checkout',
    e2e: false,
    failOn: 'none' as const,
    images: 'changed' as const,
    html: 'linked' as const,
    preview: false,
    json: false,
  };

  it('writes a bundle of documents into --out', async () => {
    const dir = await tempDir();
    const result = await exportCommand(context(diffWith(1), dir), {
      ...exportInvocation,
      out: 'bundle',
    });
    expect(result.data.outDir).toBe(join(dir, 'bundle'));
    expect((await readdir(join(dir, 'bundle'))).sort()).toEqual([
      'comment.md',
      'findings.json',
      'report.html',
      'summary.json',
    ]);
    expect(result.data.files).toContain('summary.json');
    expect(result.data.comment.path).toBe(join(dir, 'bundle', 'comment.md'));
  });

  it('asks the preview port for the captures under --preview and lists them (D51)', async () => {
    const dir = await tempDir();
    const asked: string[] = [];
    const ctx = context(diffWith(1), dir);
    ctx.ports.capturePreview = async (request) => {
      asked.push(request.outDir);
      return { files: ['images/preview.png', 'images/preview-dark.png'] };
    };
    const result = await exportCommand(ctx, { ...exportInvocation, out: 'bundle', preview: true });
    expect(asked).toEqual([join(dir, 'bundle')]);
    expect(result.data.preview).toEqual(['images/preview.png', 'images/preview-dark.png']);
    // The card the picture is taken of was written first, into the bundle.
    expect(result.data.files).toContain('preview.html');
    const card = await readFile(join(dir, 'bundle', 'preview.html'), 'utf8');
    expect(card).toContain('class="preview-card"');

    // Nothing is written or photographed unless asked.
    const quiet = await exportCommand(ctx, { ...exportInvocation, out: 'other' });
    expect(asked).toHaveLength(1);
    expect(quiet.data.preview).toEqual([]);
    expect(quiet.data.files).not.toContain('preview.html');
  });

  it('exports without a picture, and says so, when no browser can be launched', async () => {
    const dir = await tempDir();
    const ctx = context(diffWith(1), dir);
    ctx.ports.capturePreview = async () => {
      throw new Error("Chromium is not installed; run `vdiff install-browser`");
    };
    const result = await exportCommand(ctx, { ...exportInvocation, out: 'bundle', preview: true });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.data.preview).toEqual([]);
    expect(result.warnings?.join(' ')).toContain('no preview captured: Chromium is not installed');
    expect((await readdir(join(dir, 'bundle'))).sort()).toContain('report.html');
  });

  it('defaults the bundle directory to the store, per pair', async () => {
    // The writer is stubbed here and only here: the assertion is about which directory the command
    // *chooses* when `--out` names none, and the real writer would have to create it.
    const store = createTestStore({
      runs: { checkout: [fakeRunSummary({ runId: '0003' }), fakeRunSummary({ runId: '0007' })] },
      diffs: { 'checkout/0003..0007': diffWith(1) },
    });
    let requested: string | null = null;
    const ctx: CommandContext = {
      cwd: '/project',
      ports: createTestPorts({
        openStore: async () => store,
        exportBundle: async (request) => {
          requested = request.outDir;
          return {
            outDir: request.outDir,
            files: [],
            images: 0,
            missing: [],
            comment: {
              markdown: '',
              marker: '<!-- vdiff:checkout:pr -->',
              bytes: 0,
              images: 0,
              truncated: { images: 0, steps: false },
            },
          };
        },
      }),
      version: '0.6.0',
      spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
      waitForShutdown: async () => undefined,
    };
    const result = await exportCommand(ctx, exportInvocation);
    expect(requested).toBe('/project/.visual-diff/exports/checkout/0003..0007');
    expect(result.data.outDir).toBe('/project/.visual-diff/exports/checkout/0003..0007');
  });

  it('records a gate verdict but never enforces it', async () => {
    const dir = await tempDir();
    const result = await exportCommand(context(diffWith(5, 2), dir), {
      ...exportInvocation,
      out: 'bundle',
      failOn: 'any',
    });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.data.gate.tripped).toBe(true);
    expect(result.warnings?.join(' ')).toContain('gate would fail');
    const summary = JSON.parse(
      await readFile(join(dir, 'bundle', 'summary.json'), 'utf8'),
    ) as { gate: { tripped: boolean } };
    expect(summary.gate.tripped).toBe(true);
  });

  it('images=none writes the documents and no pictures', async () => {
    const dir = await tempDir();
    const result = await exportCommand(context(diffWith(1), dir), {
      ...exportInvocation,
      out: 'bundle',
      images: 'none',
    });
    expect(result.data.images).toBe(0);
  });
});
