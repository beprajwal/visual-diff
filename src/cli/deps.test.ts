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
    expect(typeof adaptersModule.installAdapter).toBe('function');
    expect(Array.isArray(adaptersModule.ADAPTERS)).toBe(true);
  });

  it('binds specifiers that resolve to those modules', () => {
    expect(Object.values(MODULE_SPECIFIERS)).toEqual([
      '../store/index.js',
      '../flow/index.js',
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
      'computeDiff',
      'installAdapter',
      'listAdapters',
      'loadConfig',
      'openStore',
      'parseFlowFile',
      'runFlow',
      'serveReport',
    ]);
  });

  it('listAdapters reports the real registry, so `vdiff install` cannot list a fiction', async () => {
    const ports = createPorts();
    await expect(ports.listAdapters()).resolves.toEqual(
      adaptersModule.ADAPTERS.map((adapter) => ({ id: adapter.id, label: adapter.label })),
    );
  });
});
