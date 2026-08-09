import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  EXIT,
  type FlowSpec,
  type NetworkMode,
  type RunOptions,
  type ShotResult,
  type Step,
  type StepResult,
  type ViewportId,
} from '../types.js';
import { paths, type Store } from '../store/index.js';
import { RunnerError } from './errors.js';
import { mergeStep, planHar, planNetwork, readPlaywrightVersion, statusOf, worstUnsettled } from './run.js';
import type { ShotBytes, StepOutcome } from './replay.js';

function outcome(overrides: Partial<StepOutcome> & { id: string }): StepOutcome {
  return {
    index: 0,
    status: 'ok',
    shoot: true,
    startedAt: '2026-08-08T10:00:00.000Z',
    finishedAt: '2026-08-08T10:00:01.000Z',
    durationMs: 1_000,
    console: [],
    network: [],
    harMisses: 0,
    ...overrides,
  };
}

function shotBytes(overrides: Partial<ShotBytes> = {}): ShotBytes {
  return {
    screenshot: new Uint8Array(),
    dom: { step: 'cart', viewport: '1280x800', nodes: [] } as unknown as ShotBytes['dom'],
    a11y: { step: 'cart', viewport: '1280x800', root: null },
    width: 1280,
    height: 800,
    ...overrides,
  };
}

function shot(viewport: ViewportId, overrides: Partial<ShotResult> = {}): ShotResult {
  return {
    viewport,
    screenshot: `steps/cart/${viewport}/screenshot.png`,
    dom: `steps/cart/${viewport}/dom.json`,
    a11y: `steps/cart/${viewport}/a11y.json`,
    width: 1280,
    height: 2400,
    nodeCount: 12,
    truncated: false,
    ...overrides,
  };
}

const step: Step = { id: 'cart', goto: '/cart', waitFor: '[data-test=cart-list]' };

describe('mergeStep', () => {
  it('folds every viewport into the one step.json the store holds', () => {
    const merged = mergeStep(
      step,
      0,
      [
        { viewport: '1280x800', outcome: outcome({ id: 'cart' }) },
        {
          viewport: '390x844',
          outcome: outcome({
            id: 'cart',
            durationMs: 2_500,
            console: [
              { step: 'cart', viewport: '390x844', level: 'error', text: 'boom', ts: '2026-08-08T10:00:00Z' },
            ],
            network: [
              {
                step: 'cart',
                viewport: '390x844',
                method: 'GET',
                url: 'http://localhost:5173/api/cart',
                status: null,
                resourceType: 'fetch',
                harMatch: 'miss',
                durationMs: 5,
              },
            ],
            harMisses: 1,
          }),
        },
      ],
      { '1280x800': shot('1280x800'), '390x844': shot('390x844', { truncated: true }) },
    );

    expect(merged).toMatchObject({
      id: 'cart',
      index: 0,
      status: 'ok',
      shoot: true,
      durationMs: 2_500,
      truncated: true,
      consoleErrors: 1,
      networkRequests: 1,
      harMisses: 1,
      resolvedSelector: '[data-test=cart-list]',
    });
    expect(Object.keys(merged.viewports)).toEqual(['1280x800', '390x844']);
  });

  it('is failed when any viewport failed, and carries that failure', () => {
    const merged = mergeStep(
      step,
      1,
      [
        { viewport: '1280x800', outcome: outcome({ id: 'cart' }) },
        {
          viewport: '390x844',
          outcome: outcome({ id: 'cart', status: 'failed', failure: { message: 'selector not found' } }),
        },
      ],
      {},
    );
    expect(merged.status).toBe('failed');
    expect(merged.failure).toEqual({ message: 'selector not found' });
  });

  it('is blocked when a viewport was blocked and none failed', () => {
    const merged = mergeStep(
      step,
      2,
      [{ viewport: '1280x800', outcome: outcome({ id: 'cart', status: 'blocked' }) }],
      {},
    );
    expect(merged.status).toBe('blocked');
  });

  it('is skipped when no viewport reached the step at all', () => {
    const merged = mergeStep(step, 3, [{ viewport: '1280x800', outcome: undefined }], {});
    expect(merged.status).toBe('skipped');
    expect(merged.viewports).toEqual({});
  });

  it('leaves `unsettled` absent when every viewport settled — a clean gate is not news', () => {
    const merged = mergeStep(
      step,
      0,
      [
        { viewport: '1280x800', outcome: outcome({ id: 'cart', shot: shotBytes() }) },
        { viewport: '390x844', outcome: outcome({ id: 'cart', shot: shotBytes() }) },
      ],
      {},
    );
    expect(merged.unsettled).toBeUndefined();
    expect('unsettled' in merged).toBe(false);
  });

  it('records the worst viewport when the settle gate lost its race in one of them', () => {
    const merged = mergeStep(
      step,
      0,
      [
        { viewport: '1280x800', outcome: outcome({ id: 'cart', shot: shotBytes() }) },
        {
          viewport: '390x844',
          outcome: outcome({
            id: 'cart',
            shot: shotBytes({ unsettled: { waitedMs: 10_000, inFlight: 3, urls: ['/api/late'] } }),
          }),
        },
      ],
      {},
    );
    expect(merged.unsettled).toEqual({ waitedMs: 10_000, inFlight: 3, urls: ['/api/late'] });
  });
});

/* ------------------------------------------------------------------ the settle gate (spec §7) */

function unsettledShot(inFlight: number, waitedMs: number, urls: string[]): { shot: ShotBytes } {
  return { shot: shotBytes({ unsettled: { waitedMs, inFlight, urls } }) };
}

describe('worstUnsettled', () => {
  it('is undefined when nothing was outstanding, so the field is never written as a zero record', () => {
    expect(worstUnsettled([{ shot: shotBytes() }, { shot: shotBytes() }])).toBeUndefined();
    expect(worstUnsettled([{}])).toBeUndefined();
    expect(worstUnsettled([])).toBeUndefined();
  });

  it('picks the largest outstanding count, not the first or the slowest', () => {
    const worst = worstUnsettled([
      unsettledShot(1, 9_000, ['/a']),
      unsettledShot(4, 200, ['/b']),
      unsettledShot(2, 9_999, ['/c']),
    ]);
    expect(worst?.inFlight).toBe(4);
    expect(worst?.waitedMs).toBe(200);
  });

  it('breaks a tie on the longest wait', () => {
    expect(worstUnsettled([unsettledShot(2, 100, []), unsettledShot(2, 800, [])])?.waitedMs).toBe(800);
  });

  it('unions the urls across viewports and de-duplicates them', () => {
    const worst = worstUnsettled([
      unsettledShot(2, 100, ['/api/a', '/api/b']),
      unsettledShot(1, 100, ['/api/b', '/api/c']),
    ]);
    expect(worst?.urls).toEqual(['/api/a', '/api/b', '/api/c']);
  });

  it('caps the url list so one chatty page cannot flood the warning', () => {
    const many = Array.from({ length: 40 }, (_, i) => `/api/${i}`);
    expect(worstUnsettled([unsettledShot(40, 100, many)])?.urls).toHaveLength(20);
  });
});

/* ------------------------------------------------------------------ planHar (spec §7, D9) */

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vdiff-planhar-'));
  tempRoots.push(dir);
  await mkdir(paths.flowsDir(dir), { recursive: true });
  return dir;
}

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

function storeAt(root: string): Store {
  return { root } as unknown as Store;
}

function spec(network: { mode: NetworkMode; har?: string }): FlowSpec {
  return {
    version: 1,
    flow: 'checkout',
    viewports: ['1280x800'],
    network: network.har === undefined ? { mode: network.mode } : { mode: network.mode, har: network.har },
    steps: [{ id: 'cart', goto: '/cart' }],
  };
}

function runOptions(network?: NetworkMode): RunOptions {
  return { flow: 'checkout', ...(network === undefined ? {} : { network }) };
}

describe('planHar', () => {
  it('plans an off run with no HAR at all', async () => {
    const root = await tempRoot();
    await expect(planHar(storeAt(root), spec({ mode: 'off' }), runOptions())).resolves.toEqual({
      mode: 'off',
      recording: false,
    });
  });

  it('records the first run of a flow and replays afterwards (spec §7)', async () => {
    const root = await tempRoot();
    const har = paths.harFile(root, 'checkout.har');

    const first = await planHar(storeAt(root), spec({ mode: 'replay', har: 'checkout.har' }), runOptions());
    expect(first).toEqual({ mode: 'record', path: har, recording: true });

    await writeFile(har, '{"log":{"entries":[]}}\n', 'utf8');
    const later = await planHar(storeAt(root), spec({ mode: 'replay', har: 'checkout.har' }), runOptions());
    expect(later).toEqual({ mode: 'replay', path: har, recording: false });
  });

  it('re-records on --record even when a HAR already exists', async () => {
    const root = await tempRoot();
    const har = paths.harFile(root, 'checkout.har');
    await writeFile(har, '{"log":{"entries":[]}}\n', 'utf8');
    await expect(
      planHar(storeAt(root), spec({ mode: 'replay', har: 'checkout.har' }), runOptions('record')),
    ).resolves.toEqual({ mode: 'record', path: har, recording: true });
  });

  it('--no-net wins over a spec that would have replayed', async () => {
    const root = await tempRoot();
    await writeFile(paths.harFile(root, 'checkout.har'), '{}', 'utf8');
    await expect(
      planHar(storeAt(root), spec({ mode: 'replay', har: 'checkout.har' }), runOptions('off')),
    ).resolves.toEqual({ mode: 'off', recording: false });
  });

  /*
   * The defect this suite exists for: `network: { mode: off }` is the one spec shape the flow
   * validator lets omit `har`, so `--record` used to produce { mode: 'record', path: undefined },
   * which set no `recordHar` and installed no route — a live-network run reporting 0 hits and
   * 0 misses under a `record` label.
   */
  it.each<[string, NetworkMode]>([
    ['--record over network.mode: off', 'record'],
    ['--replay over network.mode: off', 'replay'],
  ])('refuses %s as a config error rather than reaching the live network', async (_label, override) => {
    const root = await tempRoot();
    let thrown: unknown;
    try {
      await planHar(storeAt(root), spec({ mode: 'off' }), runOptions(override));
    } catch (error) {
      thrown = error;
    }
    expect(RunnerError.is(thrown)).toBe(true);
    const error = thrown as RunnerError;
    expect(error.code).toBe('har-path-missing');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.kind).toBe('flow-invalid');
    expect(error.message).toContain('checkout');
    expect(error.hint).toContain('.visual-diff/flows/checkout.yaml');
    expect(error.hint).toContain('--no-net');
  });

  it('refuses a blank har the same way it refuses a missing one', async () => {
    const root = await tempRoot();
    await expect(planHar(storeAt(root), spec({ mode: 'replay', har: '   ' }), runOptions())).rejects.toThrow(
      /needs a HAR file/,
    );
  });

  /*
   * Exhaustive over the reachable matrix: every (spec mode, override, HAR present) triple either
   * intercepts, records, or refuses. Nothing may resolve to a mode that talks to the network with
   * no HAR attached.
   */
  it('never resolves to record or replay without a path', async () => {
    const specModes: NetworkMode[] = ['off', 'record', 'replay'];
    const overrides: Array<NetworkMode | undefined> = [undefined, 'record', 'replay', 'off'];

    for (const specMode of specModes) {
      // `network.har` is required by the validator for record/replay, and optional only for off.
      const harNames = specMode === 'off' ? [undefined, 'checkout.har'] : ['checkout.har'];
      for (const harName of harNames) {
        for (const present of [false, true]) {
          for (const override of overrides) {
            const root = await tempRoot();
            if (harName !== undefined && present) {
              await writeFile(paths.harFile(root, harName), '{"log":{"entries":[]}}\n', 'utf8');
            }
            const flowSpec = spec(harName === undefined ? { mode: specMode } : { mode: specMode, har: harName });

            let plan: Awaited<ReturnType<typeof planHar>> | undefined;
            let error: unknown;
            try {
              plan = await planHar(storeAt(root), flowSpec, runOptions(override));
            } catch (thrown) {
              error = thrown;
            }

            const label = `spec=${specMode} har=${String(harName)} present=${present} override=${String(override)}`;
            if (plan === undefined) {
              expect(RunnerError.is(error), label).toBe(true);
              expect((error as RunnerError).exitCode, label).toBe(EXIT.CONFIG_ERROR);
              continue;
            }
            if (plan.mode === 'off') {
              expect(plan.recording, label).toBe(false);
              expect(plan.path, label).toBeUndefined();
            } else {
              expect(typeof plan.path, label).toBe('string');
              expect(plan.path, label).not.toBe('');
              expect(plan.recording, label).toBe(plan.mode === 'record');
            }
          }
        }
      }
    }
  });
});

/* ------------------------------------------------- mock mode and scenarios (mocking §5, §8, D13) */

describe('planHar with network mode mock', () => {
  it('plans a mock run with no HAR at all — D13 requires no recording', async () => {
    const root = await tempRoot();
    await expect(planHar(storeAt(root), spec({ mode: 'mock' }), runOptions())).resolves.toEqual({
      mode: 'mock',
      recording: false,
    });
  });

  it('needs no `network.har` in the spec, unlike record and replay', async () => {
    const root = await tempRoot();
    await expect(planHar(storeAt(root), spec({ mode: 'off' }), runOptions('mock'))).resolves.toEqual({
      mode: 'mock',
      recording: false,
    });
  });
});

describe('planNetwork', () => {
  const overlay = { name: 'empty-forecast', mode: 'overlay' as const };
  const mock = { name: 'no-backend', mode: 'mock' as const };

  it('is planHar, untouched, when no scenario is in force', async () => {
    const root = await tempRoot();
    await writeFile(paths.harFile(root, 'checkout.har'), '{"log":{"entries":[]}}\n', 'utf8');
    await expect(
      planNetwork(storeAt(root), spec({ mode: 'replay', har: 'checkout.har' }), runOptions()),
    ).resolves.toEqual({ mode: 'replay', path: paths.harFile(root, 'checkout.har'), recording: false });
  });

  it('replays the flow HAR under an overlay scenario', async () => {
    const root = await tempRoot();
    await writeFile(paths.harFile(root, 'checkout.har'), '{"log":{"entries":[]}}\n', 'utf8');
    await expect(
      planNetwork(storeAt(root), spec({ mode: 'replay', har: 'checkout.har' }), runOptions(), overlay),
    ).resolves.toMatchObject({ mode: 'replay', recording: false });
  });

  it('runs a mock scenario in mock mode even when the flow declares a HAR', async () => {
    const root = await tempRoot();
    await writeFile(paths.harFile(root, 'checkout.har'), '{"log":{"entries":[]}}\n', 'utf8');
    await expect(
      planNetwork(storeAt(root), spec({ mode: 'replay', har: 'checkout.har' }), runOptions(), mock),
    ).resolves.toEqual({ mode: 'mock', recording: false });
  });

  /*
   * The case slice-1 would have handled by recording. Recording through a scenario is what §2
   * forbids outright, so the missing recording is refused rather than quietly produced.
   */
  it('refuses an overlay scenario when the flow has never been recorded', async () => {
    const root = await tempRoot();
    let thrown: unknown;
    try {
      await planNetwork(storeAt(root), spec({ mode: 'replay', har: 'checkout.har' }), runOptions(), overlay);
    } catch (error) {
      thrown = error;
    }
    expect(RunnerError.is(thrown)).toBe(true);
    const error = thrown as RunnerError;
    expect(error.code).toBe('scenario-har-missing');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.kind).toBe('scenario-invalid');
    expect(error.message).toBe(
      'scenario "empty-forecast" overlays the recording for flow "checkout", but no HAR has been ' +
        `recorded yet at ${paths.harFile(root, 'checkout.har')}`,
    );
    expect(error.hint).toBe(
      'record it first with `vdiff run checkout --record`, then re-run with --scenario empty-forecast',
    );
  });

  it('refuses an overlay scenario over a flow that declares no HAR at all', async () => {
    const root = await tempRoot();
    let thrown: unknown;
    try {
      await planNetwork(storeAt(root), spec({ mode: 'off' }), runOptions(), overlay);
    } catch (error) {
      thrown = error;
    }
    const error = thrown as RunnerError;
    expect(error.code).toBe('scenario-har-missing');
    expect(error.message).toContain('the flow spec declares no `network.har`');
    expect(error.hint).toContain('.visual-diff/flows/checkout.yaml');
    expect(error.hint).toContain('mode: mock');
  });

  /* Silently overriding the mode would produce a screenshot that looks plausible and means nothing. */
  it.each<[string, 'overlay' | 'mock', NetworkMode, string]>([
    ['an overlay scenario asked to run mock', 'overlay', 'mock', "needs network mode 'replay'"],
    ['an overlay scenario asked to run with the network off', 'overlay', 'off', "asked for 'off'"],
    ['a mock scenario asked to replay', 'mock', 'replay', "needs network mode 'mock'"],
    ['a mock scenario asked to run with the network off', 'mock', 'off', "asked for 'off'"],
  ])('refuses %s', async (_label, mode, override, fragment) => {
    const root = await tempRoot();
    await writeFile(paths.harFile(root, 'checkout.har'), '{"log":{"entries":[]}}\n', 'utf8');
    let thrown: unknown;
    try {
      await planNetwork(
        storeAt(root),
        spec({ mode: 'replay', har: 'checkout.har' }),
        runOptions(override),
        { name: 's', mode },
      );
    } catch (error) {
      thrown = error;
    }
    expect(RunnerError.is(thrown)).toBe(true);
    const error = thrown as RunnerError;
    expect(error.code).toBe('scenario-mode-conflict');
    expect(error.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(error.message).toContain(fragment);
    expect(error.hint).toContain('drop the network override');
  });

  /* Exhaustive: a scenario run either replays a recording, mocks, or refuses. There is no mode in
   * which a scenario reaches the live network. */
  it('never resolves a scenario run to record, off, or a mode with no interception', async () => {
    const scenarios = [overlay, mock];
    const specModes: NetworkMode[] = ['off', 'record', 'replay', 'mock'];
    const overrides: Array<NetworkMode | undefined> = [undefined, 'record', 'replay', 'off', 'mock'];

    for (const scenario of scenarios) {
      for (const specMode of specModes) {
        const harNames = specMode === 'record' || specMode === 'replay' ? ['checkout.har'] : [undefined, 'checkout.har'];
        for (const harName of harNames) {
          for (const present of [false, true]) {
            for (const override of overrides) {
              const root = await tempRoot();
              if (harName !== undefined && present) {
                await writeFile(paths.harFile(root, harName), '{"log":{"entries":[]}}\n', 'utf8');
              }
              const flowSpec = spec(harName === undefined ? { mode: specMode } : { mode: specMode, har: harName });

              let plan: Awaited<ReturnType<typeof planNetwork>> | undefined;
              let error: unknown;
              try {
                plan = await planNetwork(storeAt(root), flowSpec, runOptions(override), scenario);
              } catch (thrown) {
                error = thrown;
              }

              const label = `${scenario.mode} spec=${specMode} har=${String(harName)} present=${present} override=${String(override)}`;
              if (plan === undefined) {
                expect(RunnerError.is(error), label).toBe(true);
                expect((error as RunnerError).exitCode, label).toBe(EXIT.CONFIG_ERROR);
                continue;
              }
              expect(plan.mode, label).toBe(scenario.mode === 'mock' ? 'mock' : 'replay');
              expect(plan.recording, label).toBe(false);
            }
          }
        }
      }
    }
  });
});

describe('statusOf', () => {
  const base: StepResult = {
    id: 'cart',
    index: 0,
    status: 'ok',
    shoot: true,
    startedAt: '2026-08-08T10:00:00Z',
    finishedAt: '2026-08-08T10:00:01Z',
    durationMs: 1,
    viewports: {},
    truncated: false,
    consoleErrors: 0,
    networkRequests: 0,
    harMisses: 0,
  };

  it('is ok when every step replayed', () => {
    expect(statusOf([base, { ...base, id: 'pay' }])).toBe('ok');
  });

  it('is partial when a step failed — the evidence survives the failure (spec §7)', () => {
    expect(statusOf([base, { ...base, id: 'pay', status: 'failed' }])).toBe('partial');
    expect(statusOf([base, { ...base, id: 'pay', status: 'blocked' }])).toBe('partial');
  });
});

/* ------------------------------------------------------------------ meta.json env (spec §6) */

/**
 * `env.playwright` used to be read from `new URL('../../node_modules/playwright-core/package.json',
 * import.meta.url)`. That path only resolves in a source checkout: installed, this module is
 * `<root>/node_modules/<pkg>/dist/runner/run.js`, npm hoists `playwright-core` to
 * `<root>/node_modules/`, and the relative path pointed at a nested `node_modules` that does not
 * exist — so every installed run recorded `"unknown"`. Both layouts are pinned here.
 */
describe('readPlaywrightVersion', () => {
  /** `<tmp>/node_modules/@beprajwal/visual-diff/dist/runner/run.js` with a hoisted playwright-core. */
  async function installedLayout(version: string): Promise<{ runJs: string; hoisted: string }> {
    const root = await mkdtemp(join(tmpdir(), 'vdiff-installed-'));
    tempRoots.push(root);
    const nodeModules = join(root, 'node_modules');
    const self = join(nodeModules, '@beprajwal', 'visual-diff', 'dist', 'runner');
    const hoisted = join(nodeModules, 'playwright-core');
    await mkdir(self, { recursive: true });
    await mkdir(hoisted, { recursive: true });
    await writeFile(
      join(hoisted, 'package.json'),
      `${JSON.stringify({ name: 'playwright-core', version, main: 'index.js' })}\n`,
      'utf8',
    );
    await writeFile(join(hoisted, 'index.js'), 'module.exports = {};\n', 'utf8');
    return { runJs: join(self, 'run.js'), hoisted };
  }

  it('reads the real version in a source checkout', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../../node_modules/playwright-core/package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    const version = await readPlaywrightVersion();
    expect(version).not.toBe('unknown');
    expect(version).toBe(pkg.version);
  });

  it('reads the hoisted version in an installed layout, where path arithmetic finds nothing', async () => {
    const { runJs } = await installedLayout('1.99.0-hoisted');

    // The shape of the old defect: the sibling `node_modules` the removed code looked in is absent.
    const sibling = new URL('../../node_modules/playwright-core/package.json', pathToFileURL(runJs));
    expect(existsSync(sibling)).toBe(false);

    await expect(readPlaywrightVersion(pathToFileURL(runJs))).resolves.toBe('1.99.0-hoisted');
  });

  it('accepts a plain path as the resolution origin, not only a file URL', async () => {
    const { runJs } = await installedLayout('1.98.0-hoisted');
    await expect(readPlaywrightVersion(runJs)).resolves.toBe('1.98.0-hoisted');
  });

  it('falls back to the package that owns the main entry when `./package.json` is not exported', async () => {
    const { runJs, hoisted } = await installedLayout('1.97.0-nested');
    // `exports` without `./package.json` makes the subpath unresolvable; the main entry still is.
    await writeFile(
      join(hoisted, 'package.json'),
      `${JSON.stringify({
        name: 'playwright-core',
        version: '1.97.0-nested',
        exports: { '.': './lib/index.js' },
      })}\n`,
      'utf8',
    );
    await mkdir(join(hoisted, 'lib'), { recursive: true });
    await writeFile(join(hoisted, 'lib', 'index.js'), 'module.exports = {};\n', 'utf8');

    await expect(readPlaywrightVersion(pathToFileURL(runJs))).resolves.toBe('1.97.0-nested');
  });

  it('is "unknown" — never a throw — when playwright-core cannot be resolved at all', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vdiff-noplaywright-'));
    tempRoots.push(root);
    await expect(readPlaywrightVersion(pathToFileURL(join(root, 'run.js')))).resolves.toBe('unknown');
  });
});
