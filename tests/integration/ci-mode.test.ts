/**
 * `vdiff comment` and `vdiff export` end to end, through the real CLI, against a real store
 * (CI spec §10).
 *
 * The unit tests cover the markdown and the bundle in isolation; what this covers is the wiring
 * nothing else does — the CLI resolving the same pair `diff` resolves, the diff engine computing it
 * from real run directories on disk, the exporter copying the images that computation produced, and
 * the `--json` envelope a workflow actually parses.
 *
 * The two properties worth an integration test in particular:
 *
 *  1. **The bundle's images are the ones the engine wrote**, not paths the renderer hoped for. A
 *     bundle full of broken `<img>` tags is the failure mode this feature cannot have, and it is
 *     invisible to a test that stubs the store.
 *  2. **Exit 3 arrives only when asked for.** The gate is the one thing here that can turn somebody
 *     else's pull request red, so its default is asserted against the real command, not a double.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT, type DiffResult } from '../../src/types.js';
import { createPorts } from '../../src/cli/deps.js';
import { runCli, type CliRuntime } from '../../src/cli/main.js';
import { createBufferWriter, type BufferWriter } from '../../src/cli/output.js';
import type { CommentData, ExportData } from '../../src/cli/shapes.js';
import { makeDomNode, solidPng, writeFixtureRun } from '../../src/store/fixtures.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(
        () => undefined,
      ),
    ),
  );
});

interface Harness extends CliRuntime {
  writer: BufferWriter;
}

function harnessAt(cwd: string): Harness {
  return {
    cwd,
    ports: createPorts(),
    version: '0.6.0',
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    waitForShutdown: async () => undefined,
    writer: createBufferWriter(),
  };
}

function envelopeOf<T>(harness: Harness): { ok: boolean; data?: T; warnings?: string[] } {
  const lines = harness.writer.stdout().trimEnd().split('\n');
  expect(lines, 'stdout must hold exactly one JSON object').toHaveLength(1);
  return JSON.parse(lines[0] as string) as { ok: boolean; data?: T; warnings?: string[] };
}

/**
 * A project with two runs of one flow that genuinely differ: the second run's node carries different
 * text, so the diff engine produces a real finding with a real crop rather than an empty pair.
 */
async function projectWithPair(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'vdiff-ci-e2e-'));
  roots.push(cwd);
  await runCli(['init'], harnessAt(cwd));

  // Real pixels, not the 1x1 fixture PNG: the engine drops any region below `minRegionArea`, so a
  // pair of 1x1 images has nothing to attribute a DOM change to and produces no findings.
  const size = { width: 32, height: 32 };
  await writeFixtureRun({
    root: cwd,
    flow: 'checkout',
    steps: [
      {
        id: 'cart',
        nodes: [makeDomNode({ text: 'Pay' })],
        screenshot: solidPng(size.width, size.height, [10, 20, 30]),
        size,
      },
    ],
  });
  await writeFixtureRun({
    root: cwd,
    flow: 'checkout',
    steps: [
      {
        id: 'cart',
        nodes: [makeDomNode({ text: 'Pay now' })],
        screenshot: solidPng(size.width, size.height, [200, 40, 60]),
        size,
      },
    ],
  });
  return cwd;
}

describe('vdiff comment against a real store', () => {
  it('renders the pair `vdiff diff` resolves, and exits 0 with findings', async () => {
    const cwd = await projectWithPair();

    const diffed = harnessAt(cwd);
    expect(await runCli(['diff', 'checkout', '--json'], diffed)).toBe(EXIT.OK);
    const diffData = envelopeOf<{ result: DiffResult }>(diffed).data;
    if (diffData === undefined) throw new Error('diff envelope carried no data');
    expect(diffData.result.summary.totalFindings).toBeGreaterThan(0);

    const commented = harnessAt(cwd);
    expect(await runCli(['comment', 'checkout', '--json'], commented)).toBe(EXIT.OK);
    const comment = envelopeOf<CommentData>(commented).data;
    if (comment === undefined) throw new Error('comment envelope carried no data');

    expect(comment.pair).toEqual({ flow: 'checkout', base: '0000', head: '0001' });
    expect(comment.marker).toBe('<!-- vdiff:checkout:pr -->');
    expect(comment.markdown.split('\n')[0]).toBe(comment.marker);
    expect(comment.markdown).toContain('#### Findings');
    // No image base was given, so no screenshots are embedded — and the command says why (D31).
    expect(comment.images).toBe(0);
    expect(comment.gate).toEqual({
      level: 'none',
      tripped: false,
      reason: 'no gate: findings are reported, never enforced',
    });
  });

  it('writes the body to --out, byte-identical to the envelope', async () => {
    const cwd = await projectWithPair();
    const runtime = harnessAt(cwd);
    expect(await runCli(['comment', 'checkout', '--out', 'body.md', '--json'], runtime)).toBe(
      EXIT.OK,
    );
    const data = envelopeOf<CommentData>(runtime).data;
    if (data?.path === undefined || data.path === null) throw new Error('no --out path reported');
    expect(await readFile(data.path, 'utf8')).toBe(data.markdown);
  });

  it('embeds images when given a base, addressing the bundle layout', async () => {
    const cwd = await projectWithPair();
    const runtime = harnessAt(cwd);
    expect(
      await runCli(
        ['comment', 'checkout', '--image-base', 'https://example.test/pr-7/checkout', '--json'],
        runtime,
      ),
    ).toBe(EXIT.OK);
    const data = envelopeOf<CommentData>(runtime).data;
    expect(data?.images).toBeGreaterThan(0);
    expect(data?.markdown).toContain(
      '<img src="https://example.test/pr-7/checkout/images/cart/1280x800/',
    );
  });

  it('exits 3 — and only 3 — when an asked-for gate trips', async () => {
    const cwd = await projectWithPair();

    const gated = harnessAt(cwd);
    expect(await runCli(['comment', 'checkout', '--fail-on', 'any', '--json'], gated)).toBe(
      EXIT.GATE_FAILED,
    );
    const envelope = envelopeOf<CommentData>(gated);
    // The body is still produced and still marked ok: the gate is a verdict about the UI, not a
    // failure of the command (D30, D35).
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.gate.tripped).toBe(true);
    expect(envelope.data?.markdown).toContain('❌ **Gate failed**');

    const ungated = harnessAt(cwd);
    expect(await runCli(['comment', 'checkout', '--json'], ungated)).toBe(EXIT.OK);
  });

  it('rejects an unknown gate level as a config error, not a silently ignored flag', async () => {
    const cwd = await projectWithPair();
    const runtime = harnessAt(cwd);
    expect(await runCli(['comment', 'checkout', '--fail-on', 'warn', '--json'], runtime)).toBe(
      EXIT.CONFIG_ERROR,
    );
    expect(runtime.writer.stdout()).toContain('invalid-fail-on');
  });
});

describe('vdiff export against a real store', () => {
  it('writes a bundle whose images exist on disk', async () => {
    const cwd = await projectWithPair();
    const runtime = harnessAt(cwd);
    expect(await runCli(['export', 'checkout', '--out', 'bundle', '--json'], runtime)).toBe(EXIT.OK);
    const data = envelopeOf<ExportData>(runtime).data;
    if (data === undefined) throw new Error('export envelope carried no data');

    expect(data.missing, 'every image the engine wrote must be in the bundle').toEqual([]);
    expect(data.files).toContain('report.html');
    expect(data.files).toContain('findings.json');
    expect(data.images).toBeGreaterThan(0);

    // Every path the page addresses resolves to a file that is actually there — the failure this
    // feature cannot have is a bundle of broken images.
    const page = await readFile(join(data.outDir, 'report.html'), 'utf8');
    const sources = [...page.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1] as string);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.startsWith('http'), source).toBe(false);
      await expect(readFile(join(data.outDir, source)), source).resolves.toBeDefined();
    }
  });

  it('defaults its directory into the store, one per pair', async () => {
    const cwd = await projectWithPair();
    const runtime = harnessAt(cwd);
    expect(await runCli(['export', 'checkout', '--json'], runtime)).toBe(EXIT.OK);
    const data = envelopeOf<ExportData>(runtime).data;
    expect(data?.outDir).toBe(join(cwd, '.visual-diff', 'exports', 'checkout', '0000..0001'));
    expect((await readdir(data?.outDir ?? cwd)).sort()).toContain('summary.json');
  });

  it('images=none writes the documents and copies nothing', async () => {
    const cwd = await projectWithPair();
    const runtime = harnessAt(cwd);
    expect(
      await runCli(['export', 'checkout', '--images', 'none', '--out', 'bare', '--json'], runtime),
    ).toBe(EXIT.OK);
    const data = envelopeOf<ExportData>(runtime).data;
    expect(data?.images).toBe(0);
    expect((await readdir(join(cwd, 'bare'))).sort()).toEqual([
      'comment.md',
      'findings.json',
      'report.html',
      'summary.json',
    ]);
  });

  it('never gates, whatever --fail-on says: the evidence is already written', async () => {
    const cwd = await projectWithPair();
    const runtime = harnessAt(cwd);
    expect(
      await runCli(['export', 'checkout', '--fail-on', 'any', '--out', 'b', '--json'], runtime),
    ).toBe(EXIT.OK);
    const data = envelopeOf<ExportData>(runtime).data;
    expect(data?.gate.tripped).toBe(true);
  });
});
