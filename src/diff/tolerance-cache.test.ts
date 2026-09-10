import { describe, expect, it, vi } from 'vitest';
import { createTestPorts, createTestStore, fakeConfig, fakeDiffResult, fakeRunMeta, fakeRunSummary } from '../cli/testing.js';
import { resolveDiff } from '../cli/commands/pair.js';
import { createDiffService } from '../report/server/diff-service.js';
import type { ReportStore } from '../report/server/deps.js';
import type { DiffEngineOptions } from '../types.js';
import { sameTolerance } from './tolerance.js';

describe('tolerance across consumer caches', () => {
  it('does not reuse legacy strict comparisons under the enabled defaults', () => {
    expect(sameTolerance(undefined, {})).toBe(false);
    expect(sameTolerance(undefined, { maxChangedPixelRatio: 0, layout: { tolerancePx: 0.5 } })).toBe(true);
  });

  it('recomputes a CLI cached pair when tolerance changes in either direction', async () => {
    const config = fakeConfig();
    const store = createTestStore({
      runs: { checkout: [fakeRunSummary({ runId: '0003' }), fakeRunSummary({ runId: '0007' })] },
      diffs: { 'checkout/0003..0007': fakeDiffResult({ tolerance: undefined }) },
    });
    const computeDiff = vi.fn(async (_base: string, _head: string, options: DiffEngineOptions) =>
      fakeDiffResult({ tolerance: { maxChangedPixelRatio: options.maxChangedPixelRatio ?? 0 } }));
    const ctx = { cwd: '/project', version: 'test',
      ports: createTestPorts({ loadConfig: async () => config, openStore: async () => store, computeDiff }),
      spawn: async () => ({ code: 0, stdout: '', stderr: '' }), waitForShutdown: async () => undefined };
    config.diff.maxChangedPixelRatio = 0.003;
    expect((await resolveDiff(ctx, { flow: 'checkout', e2e: false })).cached).toBe(false);
    expect(computeDiff).toHaveBeenCalledTimes(1);
    expect((await resolveDiff(ctx, { flow: 'checkout', e2e: false })).cached).toBe(true);
    config.diff.maxChangedPixelRatio = 0;
    expect((await resolveDiff(ctx, { flow: 'checkout', e2e: false })).cached).toBe(false);
    expect(computeDiff).toHaveBeenCalledTimes(2);
  });

  it('invalidates both the live report disk and memory caches when tolerance changes', async () => {
    const config = fakeConfig();
    config.diff.maxChangedPixelRatio = 0.003;
    const store = {
      readMeta: async (_flow: string, id: string) => fakeRunMeta({ runId: id }),
      readCachedDiff: async () => fakeDiffResult({ tolerance: undefined }),
      runDir: (_flow: string, id: string) => `/project/${id}`,
    } as unknown as ReportStore;
    const computeDiff = vi.fn(async (_base: string, _head: string, options: DiffEngineOptions) =>
      fakeDiffResult({ tolerance: { maxChangedPixelRatio: options.maxChangedPixelRatio ?? 0 } }));
    const service = createDiffService({ config, store, computeDiff });
    await service.get('checkout', '0003', '0007');
    expect(computeDiff).toHaveBeenCalledTimes(1);
    await service.get('checkout', '0003', '0007');
    expect(computeDiff).toHaveBeenCalledTimes(1);
    config.diff.maxChangedPixelRatio = 0.004;
    await service.get('checkout', '0003', '0007');
    expect(computeDiff).toHaveBeenCalledTimes(2);
  });
});
