/**
 * cli — binds the `Ports` interface to the real modules.
 *
 * This is the only file in `src/cli` that names another module. Each edge is loaded on first use,
 * so `vdiff init` never pulls in Playwright and `vdiff runs` never pulls in the diff engine or the
 * report server — which is what keeps the common commands fast to start.
 *
 * The specifiers are held in a table rather than written as static `import` statements for exactly
 * that reason (lazy, per-command loading), and because a missing or renamed module edge then
 * surfaces as one clear CLI error naming the module and the export, instead of an unhandled
 * resolution failure before `main()` ever runs.
 *
 * It is also the adapter layer. `StorePort` is the *narrow* view the CLI needs — thirteen methods,
 * every path built by the store — while `store/index.ts#Store` is the full store surface used by
 * the runner and the report. Adapting here keeps both honest: the store does not grow CLI-shaped
 * methods, and the CLI does not learn the store's internals.
 */

import type {
  Config,
  DiffEngineOptions,
  DiffResult,
  FeedbackEntry,
  FlowSpec,
  PairRef,
  RunId,
  RunOptions,
  RunResult,
  RunSummary,
  ServeOptions,
  ValidationResult,
} from '../types.js';

import type { AdapterInstallDetail, WriteOptions } from '../adapters/index.js';

import { runFailure } from './error.js';
import type { HarnessInfo, Ports, ServeHandle, StorePort } from './ports.js';

/** Module edges, relative to this file. Mirrors the `index.ts` of each module (plan §1). */
export const MODULE_SPECIFIERS = {
  /** Config loading lives in `store/`: the config *is* where the store's root comes from. */
  config: '../store/index.js',
  flow: '../flow/index.js',
  store: '../store/index.js',
  runner: '../runner/index.js',
  diff: '../diff/index.js',
  report: '../report/index.js',
  adapters: '../adapters/index.js',
} as const;

type AnyFn = (...args: never[]) => unknown;

async function loadModule(specifier: string): Promise<Record<string, unknown>> {
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch (cause) {
    throw runFailure(
      'module-missing',
      `internal module '${specifier}' could not be loaded`,
      { hint: 'reinstall @beprajwal/visual-diff, or run `npm run build` in a source checkout', cause },
    );
  }
}

function pick<T extends AnyFn>(module: Record<string, unknown>, specifier: string, name: string): T {
  const value = module[name];
  if (typeof value !== 'function') {
    throw runFailure(
      'module-contract',
      `internal module '${specifier}' does not export '${name}'`,
    );
  }
  return value as unknown as T;
}

async function loadExport<T extends AnyFn>(specifier: string, name: string): Promise<T> {
  return pick<T>(await loadModule(specifier), specifier, name);
}

/* ------------------------------------------------------------------ the store adapter */

/**
 * The store module's real type. `import type` is erased at emit, so this costs nothing at runtime
 * and the edge stays lazy — but a rename in `store/index.ts` now fails the typecheck here instead
 * of at 3am inside a `vdiff diff`.
 */
type StoreModule = typeof import('../store/index.js');

/**
 * Wrap the store facade in `StorePort`.
 *
 * The two shapes differ in three places, each on purpose:
 *  - `pin`/`prune` return the store's own result types; the CLI prints a timeline row, so the
 *    updated `RunSummary` is re-read from `listRuns` rather than reconstructed here.
 *  - `writeDiff` takes the pair explicitly in the CLI because the command already resolved it;
 *    the store reads it back off the `DiffResult`, which is the file's own identity.
 *  - `ackFeedback` takes whole entries in the CLI (it just printed them) and ids in the store.
 */
export function toStorePort(module: StoreModule, config: Config): StorePort {
  const store = module.openStore(config);
  const root = store.root;

  const summaryOf = async (flow: string, runId: RunId): Promise<RunSummary> => {
    const runs = await store.listRuns(flow);
    const found = runs.find((summary) => summary.runId === runId);
    if (found === undefined) {
      throw runFailure('unknown-run', `run ${runId} is not in flow "${flow}"`);
    }
    return found;
  };

  return {
    flowsDir: () => module.paths.flowsDir(root),
    flowFile: (flow) => module.paths.flowFile(root, flow),
    listFlows: () => store.listFlows(),
    listRuns: (flow) => store.listRuns(flow),
    resolvePair: (flow, base, head) => store.resolvePair(flow, base, head),
    runDir: (flow, runId) => store.runDir(flow, runId),
    diffFile: (pair) => module.paths.diffFindingsFile(root, pair.flow, pair.base, pair.head),
    readDiff: (pair) => store.readDiff(pair),
    writeDiff: (_pair, result) => store.writeDiff(result),
    pinRun: async (flow, runId) => {
      await store.pin(flow, runId, true);
      return summaryOf(flow, runId);
    },
    pruneRun: async (flow, runId) => {
      await store.prune(flow, runId);
      return summaryOf(flow, runId);
    },
    readPendingFeedback: (flow) =>
      store.readPendingFeedback(flow === undefined ? undefined : { flow }),
    ackFeedback: (entries) => store.ackFeedback(entries.map((entry) => entry.id)),
  };
}

/* ------------------------------------------------------------------ the ports */

/** Ports bound to the real modules. Used by the binary; tests pass their own implementation. */
export function createPorts(): Ports {
  return {
    async loadConfig(cwd: string): Promise<Config> {
      const fn = await loadExport<(options: { cwd: string }) => Promise<Config>>(
        MODULE_SPECIFIERS.config,
        'loadConfigOrThrow',
      );
      return await fn({ cwd });
    },

    async parseFlowFile(file: string): Promise<ValidationResult<FlowSpec>> {
      const fn = await loadExport<
        (file: string) => Promise<ValidationResult<FlowSpec>> | ValidationResult<FlowSpec>
      >(MODULE_SPECIFIERS.flow, 'parseFlowFile');
      return await fn(file);
    },

    async openStore(config: Config): Promise<StorePort> {
      const module = await loadModule(MODULE_SPECIFIERS.store);
      pick(module, MODULE_SPECIFIERS.store, 'openStore');
      return toStorePort(module as unknown as StoreModule, config);
    },

    async runFlow(options: RunOptions): Promise<RunResult> {
      const fn = await loadExport<(options: RunOptions) => Promise<RunResult>>(
        MODULE_SPECIFIERS.runner,
        'runFlow',
      );
      return await fn(options);
    },

    async computeDiff(
      baseDir: string,
      headDir: string,
      options: DiffEngineOptions,
    ): Promise<DiffResult> {
      const fn = await loadExport<
        (baseDir: string, headDir: string, options: DiffEngineOptions) => Promise<DiffResult>
      >(MODULE_SPECIFIERS.diff, 'computeDiff');
      return await fn(baseDir, headDir, options);
    },

    async serveReport(config: Config, options: ServeOptions): Promise<ServeHandle> {
      const fn = await loadExport<
        (config: Config, options: ServeOptions) => Promise<ServeHandle>
      >(MODULE_SPECIFIERS.report, 'serveReport');
      return await fn(config, options);
    },

    async listAdapters(): Promise<HarnessInfo[]> {
      const module = await loadModule(MODULE_SPECIFIERS.adapters);
      const adapters = module['ADAPTERS'];
      if (!Array.isArray(adapters)) {
        throw runFailure(
          'module-contract',
          `internal module '${MODULE_SPECIFIERS.adapters}' does not export 'ADAPTERS'`,
        );
      }
      return (adapters as HarnessInfo[]).map((adapter) => ({
        id: adapter.id,
        label: adapter.label,
      }));
    },

    async installAdapter(
      id: string,
      root: string,
      options: WriteOptions,
    ): Promise<AdapterInstallDetail> {
      const fn = await loadExport<
        (id: string, root: string, options: WriteOptions) => Promise<AdapterInstallDetail>
      >(MODULE_SPECIFIERS.adapters, 'installAdapter');
      return await fn(id, root, options);
    },
  };
}
