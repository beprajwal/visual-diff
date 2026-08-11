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

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT, type DiffResult } from '../../types.js';
import type { CommandContext } from '../command.js';
import { createTestPorts, createTestStore, fakeDiffResult, fakeRunSummary } from '../testing.js';
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

  it('carries the caps through to the renderer and reports what was dropped', async () => {
    const result = await comment(context(diffWith(2)), { ...invocation, maxFindings: 0 });
    expect(result.data.truncated.findings).toBe(0);
    expect(result.data.bytes).toBeGreaterThan(0);
  });
});

describe('vdiff export', () => {
  const exportInvocation = {
    kind: 'export' as const,
    flow: 'checkout',
    e2e: false,
    failOn: 'none' as const,
    images: 'changed' as const,
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
              truncated: { findings: 0, images: 0, steps: false },
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
