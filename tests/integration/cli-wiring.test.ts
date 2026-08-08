/**
 * The CLI against the *real* modules (spec §5, §11.6).
 *
 * `src/cli/main.test.ts` pins the `--json` shapes against in-memory doubles; this file runs the
 * same commands through `createPorts()`, so config loading, the store facade adapter, the flow
 * parser and the diff engine are all the real thing on a real directory. A rename behind any of
 * those edges fails here, which is the failure mode `deps.ts`'s lazy loading would otherwise hide
 * until a user hit the command.
 *
 * The browser is deliberately never launched: `vdiff run` is exercised only on the paths that fail
 * before Playwright is reached, because a Chromium download is not a precondition for the wiring
 * to be correct.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT, type CliEnvelope, type DiffResult, type RunSummary } from '../../src/types.js';
import { runCli, type CliRuntime } from '../../src/cli/main.js';
import { createPorts } from '../../src/cli/deps.js';
import { createBufferWriter, type BufferWriter } from '../../src/cli/output.js';
import { EXAMPLE_FLOW_NAME } from '../../src/cli/templates.js';
import { openStore, loadConfigOrThrow, paths } from '../../src/store/index.js';
import { writeFixtureRun } from '../../src/store/fixtures.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(
          () => undefined,
        ),
      ),
  );
});

interface Harness extends CliRuntime {
  writer: BufferWriter;
}

async function project(): Promise<{ cwd: string; runtime: Harness }> {
  const cwd = await mkdtemp(join(tmpdir(), 'vdiff-cli-e2e-'));
  roots.push(cwd);
  const writer = createBufferWriter();
  return {
    cwd,
    runtime: {
      cwd,
      ports: createPorts(),
      version: '0.1.0',
      spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
      waitForShutdown: async () => undefined,
      writer,
    },
  };
}

function envelope<T>(runtime: Harness): CliEnvelope<T> {
  const stdout = runtime.writer.stdout();
  expect(stdout.trimEnd().split('\n'), 'stdout must hold exactly one JSON object').toHaveLength(1);
  return JSON.parse(stdout) as CliEnvelope<T>;
}

describe('vdiff init, then flow check', () => {
  it('scaffolds a project the real config loader and flow parser both accept', async () => {
    const { cwd, runtime } = await project();

    expect(await runCli(['init', '--json'], runtime)).toBe(EXIT.OK);
    expect(envelope(runtime).ok).toBe(true);

    const config = await loadConfigOrThrow({ cwd });
    expect(config.root).toBe(cwd);
    expect(config.retention.keepRuns).toBeGreaterThan(0);

    const check = await project();
    await rm(check.cwd, { recursive: true, force: true });

    const second = { ...runtime, writer: createBufferWriter() };
    expect(await runCli(['flow', 'check', EXAMPLE_FLOW_NAME, '--json'], second)).toBe(EXIT.OK);
    expect(envelope(second as Harness).ok).toBe(true);
  });

  it('reports a spec error as exit 2 with the file and the offending key (spec §10)', async () => {
    const { cwd, runtime } = await project();
    await runCli(['init'], runtime);

    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      paths.flowFile(cwd, EXAMPLE_FLOW_NAME),
      'version: 1\nflow: example\nviewports: [1280x800]\nnetwork: { mode: off }\nsteps:\n  - id: a\n    sleep: 100\n',
      'utf8',
    );

    const second = { ...runtime, writer: createBufferWriter() };
    expect(await runCli(['flow', 'check', EXAMPLE_FLOW_NAME, '--json'], second)).toBe(
      EXIT.CONFIG_ERROR,
    );
    const failure = envelope(second as Harness);
    expect(failure.ok).toBe(false);
    expect(JSON.stringify(failure)).toContain('sleep');
  });
});

describe('vdiff runs / diff against a real store', () => {
  it('lists the timeline and computes, stores and then reuses the pair', async () => {
    const { cwd, runtime } = await project();
    await runCli(['init'], runtime);

    await writeFixtureRun({ root: cwd, flow: 'checkout', steps: [{ id: 'cart' }] });
    await writeFixtureRun({ root: cwd, flow: 'checkout', steps: [{ id: 'cart' }] });

    const listing = { ...runtime, writer: createBufferWriter() };
    expect(await runCli(['runs', 'checkout', '--json'], listing)).toBe(EXIT.OK);
    const runs = envelope<{ runs: RunSummary[] }>(listing as Harness);
    expect(runs.ok).toBe(true);
    expect(runs.data?.runs.map((run) => run.runId)).toEqual(['0000', '0001']);

    const first = { ...runtime, writer: createBufferWriter() };
    expect(await runCli(['diff', 'checkout', '--json'], first)).toBe(EXIT.OK);
    const computed = envelope<{ cached: boolean; path: string; result: DiffResult }>(first as Harness);
    expect(computed.ok).toBe(true);
    const diffData = computed.data;
    if (diffData === undefined) throw new Error('diff envelope carried no data');
    expect(diffData.cached).toBe(false);
    expect(diffData.result.pair).toEqual({ base: '0000', head: '0001' });
    expect(JSON.parse(await readFile(diffData.path, 'utf8'))).toMatchObject({
      pair: { base: '0000', head: '0001' },
    });

    const again = { ...runtime, writer: createBufferWriter() };
    expect(await runCli(['diff', 'checkout', '--json'], again)).toBe(EXIT.OK);
    const cached = envelope<{ cached: boolean }>(again as Harness);
    expect(cached.data?.cached).toBe(true);
  });
});

describe('vdiff feedback', () => {
  it('reads what the report appended and archives it on --ack', async () => {
    const { cwd, runtime } = await project();
    await runCli(['init'], runtime);
    const store = openStore(await loadConfigOrThrow({ cwd }));
    await store.appendFeedback({
      flow: 'checkout',
      pair: '0000..0001',
      step: 'cart',
      text: 'the CTA moved',
    });

    const listed = { ...runtime, writer: createBufferWriter() };
    expect(await runCli(['feedback', '--json', '--ack'], listed)).toBe(EXIT.OK);
    const result = envelope<{ entries: Array<{ text: string }>; archive: string | null }>(
      listed as Harness,
    );
    expect(result.ok).toBe(true);
    expect(result.data?.entries.map((entry) => entry.text)).toEqual(['the CTA moved']);
    expect(result.data?.archive).not.toBeNull();

    await expect(store.readPendingFeedback()).resolves.toEqual([]);
  });
});

describe('vdiff run', () => {
  it('refuses a flow that has no spec, without touching a browser (spec §10)', async () => {
    const { runtime } = await project();
    await runCli(['init'], runtime);

    const missing = { ...runtime, writer: createBufferWriter() };
    const code = await runCli(['run', 'no-such-flow', '--json'], missing);
    expect([EXIT.RUN_FAILURE, EXIT.CONFIG_ERROR]).toContain(code);
    const failure = envelope(missing as Harness);
    expect(failure.ok).toBe(false);
    expect(JSON.stringify(failure)).toContain('no-such-flow');
  });
});
