/**
 * The module-edge contract (spec §5: "every module exposes a JSON contract at its edge").
 *
 * `deps.ts` loads each edge lazily by specifier, which means a renamed export cannot fail the
 * build — it fails at the moment a user runs the command. This file is the compensating check: it
 * imports every edge statically, asserts the export exists, and assigns it to the exact function
 * type `ports.ts` declares, so a signature drift is a red typecheck and a red test rather than a
 * production surprise.
 */

import { describe, expect, it } from 'vitest';

import * as adaptersModule from '../adapters/index.js';
import * as diffModule from '../diff/index.js';
import * as flowModule from '../flow/index.js';
import * as reportModule from '../report/index.js';
import * as runnerModule from '../runner/index.js';
import * as storeModule from '../store/index.js';

import { MODULE_SPECIFIERS, createPorts, toStorePort } from './deps.js';
import type { Ports } from './ports.js';
import { fakeConfig, fakeFeedbackEntry } from './testing.js';

describe('module edges', () => {
  it('exports every function deps.ts binds', () => {
    expect(typeof storeModule.loadConfigOrThrow).toBe('function');
    expect(typeof storeModule.openStore).toBe('function');
    expect(typeof storeModule.paths.flowsDir).toBe('function');
    expect(typeof flowModule.parseFlowFile).toBe('function');
    expect(typeof runnerModule.runFlow).toBe('function');
    expect(typeof diffModule.computeDiff).toBe('function');
    expect(typeof reportModule.serveReport).toBe('function');
    expect(typeof adaptersModule.getAdapter).toBe('function');
    expect(typeof adaptersModule.installAdapter).toBe('function');
    expect(typeof adaptersModule.readInstalledVersion).toBe('function');
    expect(Array.isArray(adaptersModule.ADAPTERS)).toBe(true);
  });

  it('binds specifiers that resolve to those modules', () => {
    expect(Object.values(MODULE_SPECIFIERS)).toEqual([
      '../store/index.js',
      '../flow/index.js',
      '../mocking/index.js',
      '../variant-apply/index.js',
      '../store/index.js',
      '../runner/index.js',
      '../diff/index.js',
      '../report/index.js',
      '../adapters/index.js',
    ]);
  });

  it('matches the signatures ports.ts declares', () => {
    // Assignment is the assertion: a changed parameter list or return type fails to compile.
    const loadConfig: (cwd: string) => Promise<Awaited<ReturnType<Ports['loadConfig']>>> = (cwd) =>
      storeModule.loadConfigOrThrow({ cwd });
    const parseFlowFile: Ports['parseFlowFile'] = flowModule.parseFlowFile;
    const runFlow: Ports['runFlow'] = runnerModule.runFlow;
    const computeDiff: Ports['computeDiff'] = diffModule.computeDiff;
    const serveReport: Ports['serveReport'] = reportModule.serveReport;
    const installAdapter: Ports['installAdapter'] = adaptersModule.installAdapter;

    expect(
      [loadConfig, parseFlowFile, runFlow, computeDiff, serveReport, installAdapter].every(
        (fn) => typeof fn === 'function',
      ),
    ).toBe(true);
  });

  /**
   * `adapterFiles` is the one edge `deps.ts` reaches through a registry lookup rather than binding
   * a named export directly, so the assertion is that the lookup produces something with the
   * `files()` the port calls — a registry entry missing it would otherwise fail inside `install`.
   */
  it('resolves an adapter that can compose its own files', async () => {
    const adapter = adaptersModule.getAdapter('claude-code');
    expect(adapter, 'claude-code must stay registered').toBeDefined();
    expect(typeof adapter?.files).toBe('function');
    expect(typeof adapter?.targets).toBe('function');
    expect(adaptersModule.getAdapter('nope')).toBeUndefined();
  });

  it('adapts the store facade to the narrow StorePort the commands use', async () => {
    const config = fakeConfig('/tmp/vdiff-adapter-check');
    const port = toStorePort(storeModule, config);

    expect(port.flowsDir()).toBe(`${config.root}/.visual-diff/flows`);
    expect(port.flowFile('checkout')).toBe(`${config.root}/.visual-diff/flows/checkout.yaml`);
    expect(port.runDir('checkout', '0007')).toBe(`${config.root}/.visual-diff/runs/checkout/0007`);
    expect(port.diffFile({ flow: 'checkout', base: '0003', head: '0007' })).toBe(
      `${config.root}/.visual-diff/diffs/checkout/0003..0007/findings.json`,
    );
    // An empty store answers rather than throwing, so `vdiff runs` on a fresh project prints a table.
    await expect(port.listFlows()).resolves.toEqual([]);
    await expect(port.readPendingFeedback()).resolves.toEqual([]);
    await expect(port.readDiff({ flow: 'checkout', base: '0003', head: '0007' })).resolves.toBeNull();
    await expect(port.ackFeedback([fakeFeedbackEntry()])).resolves.toMatchObject({
      archive: null,
      acked: [],
    });
  });

  it('createPorts produces every port the CLI declares', () => {
    const ports = createPorts();
    expect(Object.keys(ports).sort()).toEqual([
      'adapterFiles',
      'adapterTargets',
      'computeDiff',
      'installAdapter',
      'listAdapters',
      'listScenarios',
      'listVariants',
      'loadConfig',
      'openStore',
      'parseFlowFile',
      'parseScenarioFile',
      'parseVariantFile',
      'readInstalledVersion',
      'runFlow',
      'scenarioFile',
      'scenariosDir',
      'serveReport',
      'variantFile',
      'variantsDir',
    ]);
  });

  /**
   * The scenario edge is checked by dynamic import rather than a static one so that a module that
   * does not exist yet fails *this* assertion — naming the missing export — instead of taking the
   * whole file's collection down with a resolution error.
   */
  it('exports the four scenario functions the CLI binds (mocking spec §5, §7)', async () => {
    const mocking = (await import('../mocking/index.js')) as Record<string, unknown>;
    for (const name of ['parseScenarioFile', 'scenariosDir', 'scenarioFile', 'listScenarios']) {
      expect(typeof mocking[name], `mocking/index.ts must export ${name}`).toBe('function');
    }

    const parseScenarioFile: Ports['parseScenarioFile'] =
      mocking['parseScenarioFile'] as Ports['parseScenarioFile'];
    const scenariosDir = mocking['scenariosDir'] as (root: string) => string;
    const scenarioFile = mocking['scenarioFile'] as (root: string, name: string) => string;
    expect(typeof parseScenarioFile).toBe('function');
    expect(scenariosDir('/project')).toBe('/project/.visual-diff/scenarios');
    expect(scenarioFile('/project', 'empty-forecast')).toBe(
      '/project/.visual-diff/scenarios/empty-forecast.yaml',
    );
  });

  /**
   * The variant edge, checked the same way and for the same reason (variants spec §4, §6). The
   * four names mirror the scenario edge exactly: a variant is the second axis of run identity and
   * has the same lifecycle as the first, so a difference between these two lists would be a bug in
   * one of them rather than a design.
   */
  it('exports the four variant functions the CLI binds (variants spec §4, §6)', async () => {
    const variant = (await import('../variant-apply/index.js')) as Record<string, unknown>;
    for (const name of ['parseVariantFile', 'variantsDir', 'variantFile', 'listVariants']) {
      expect(typeof variant[name], `variant-apply/index.ts must export ${name}`).toBe('function');
    }

    const variantsDir = variant['variantsDir'] as (root: string) => string;
    const variantFile = variant['variantFile'] as (root: string, name: string) => string;
    expect(variantsDir('/project')).toBe('/project/.visual-diff/variants');
    expect(variantFile('/project', 'denser-forecast')).toBe(
      '/project/.visual-diff/variants/denser-forecast.yaml',
    );
  });

  it('listAdapters reports the real registry, so `vdiff install` cannot list a fiction', async () => {
    const ports = createPorts();
    await expect(ports.listAdapters()).resolves.toEqual(
      adaptersModule.ADAPTERS.map((adapter) => ({
        id: adapter.id,
        label: adapter.label,
        notes: adaptersModule.HARNESS_NOTES[adapter.id],
      })),
    );
  });
});
