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
  ScenarioSpec,
  ServeOptions,
  ValidationResult,
} from '../types.js';

import type {
  HarnessAdapter,
  HarnessId,
  HarnessInstallDetail,
  HarnessTargets,
  InstallOptions,
  InstallScope,
  ManagedFile,
} from '../adapters/index.js';

import { runFailure } from './error.js';
import type {
  E2eIngestPlan,
  E2eIngestReport,
  E2eIngestRequest,
  HarnessInfo,
  Ports,
  RunFilter,
  ServeHandle,
  StorePort,
} from './ports.js';
import type { VariantSpec } from './variant.js';

/** Module edges, relative to this file. Mirrors the `index.ts` of each module (plan §1). */
export const MODULE_SPECIFIERS = {
  /** Config loading lives in `store/`: the config *is* where the store's root comes from. */
  config: '../store/index.js',
  flow: '../flow/index.js',
  /** Scenario parsing and validation (mocking spec §5, §8) — the flow module's sibling. */
  scenario: '../mocking/index.js',
  /**
   * The variant slice's edge (variants spec §4, §6, §7), bound exactly as `mocking` is: one module
   * for the whole slice, re-exporting the language layer's parser alongside the file layout, so
   * the CLI keeps constructing no path of its own.
   */
  variant: '../variant-apply/index.js',
  /**
   * The e2e ingestion slice (e2e spec §6). One module for the whole slice, exactly as `mocking` and
   * `variant` are: the trace reader, the title→flow mapping (D26) and the run writer behind a single
   * edge, so the CLI parses a trace archive no more than it parses a HAR.
   *
   * Loaded on first use like every other edge here, which matters more for this one than for most:
   * a trace reader pulls in a zip reader and a JPEG header parser, and `vdiff runs` must not.
   */
  e2e: '../e2e/index.js',
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
/**
 * A filter with nothing in it is the absence of a filter. Passed on as `undefined` so the store
 * never has to distinguish "narrow by nothing" from "do not narrow", which are the same request.
 */
function emptyToUndefined<T extends object>(filter: T | undefined): T | undefined {
  if (filter === undefined) return undefined;
  return Object.values(filter).some((value) => value !== undefined) ? filter : undefined;
}

/**
 * The store's own `ResolvePairOptions`, taken off the method rather than restated, so a field
 * renamed in the store is a red typecheck here instead of an option silently dropped on the floor.
 */
type ResolvePairFilter = NonNullable<
  Parameters<ReturnType<StoreModule['openStore']>['resolvePair']>[3]
>;

/**
 * The one place `RunFilter` is not a pass-through: the source axis is named differently on the two
 * sides of this edge, and on purpose.
 *
 * A *timeline listing* asks a three-valued question — show the replay timeline, show the ingested
 * one, show both — so `vdiff runs` and the store's `listRunSummaries` both speak
 * `exclude | include | only`. **Resolving a pair is a different question**: `resolvePair` restricts
 * both ends to one timeline (D27), so it takes the timeline itself, `source: 'replay' | 'e2e'`, and
 * reads `undefined` as "the caller named no timeline" — which is what lets a run named outright be
 * taken at its word and an explicit cross-source pair happen at all.
 *
 * Passing the listing vocabulary straight through, as every other field of `RunFilter` is passed,
 * type-checks (excess properties survive on a non-literal) and is silently ignored by the store,
 * which then defaults to `replay`: `vdiff diff <flow> --e2e` would resolve over the replay timeline
 * and answer a question nobody asked. Hence the explicit translation, and hence a test on it.
 *
 * `include` maps to `undefined` rather than to a source, because "both timelines are allowed" is
 * exactly the absence of a restriction — the same value the default carries.
 */
export function toResolvePairOptions(
  filter: RunFilter | undefined,
): ResolvePairFilter | undefined {
  if (filter === undefined) return undefined;
  const options: ResolvePairFilter = {};
  if (filter.scenario !== undefined) options.scenario = filter.scenario;
  if (filter.variant !== undefined) options.variant = filter.variant;
  if (filter.e2e === 'only') options.source = 'e2e';
  else if (filter.e2e === 'exclude') options.source = 'replay';
  return emptyToUndefined(options);
}

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
    // The filter object is passed through untouched: `scenario` and `variant` are both attributes
    // of a run, and narrowing on them is store work — findingsCount is measured against the
    // previous run of the same identity, which a caller filtering the returned array cannot undo.
    listRuns: (flow, filter) => store.listRuns(flow, emptyToUndefined(filter)),
    resolvePair: (flow, base, head, filter) =>
      store.resolvePair(flow, base, head, toResolvePairOptions(filter)),
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

/* ------------------------------------------------------------------ the adapter registry */

/**
 * The one edge reached through a registry lookup rather than a named export.
 *
 * `getAdapter` returns undefined for an id the registry does not hold; the CLI validates the id
 * against `listAdapters()` before it gets here, so reaching this failure means the registry
 * changed under us and it is reported as a module-contract error rather than a user mistake.
 */
async function resolveAdapter(id: string): Promise<HarnessAdapter<HarnessId>> {
  const get = await loadExport<(id: string) => HarnessAdapter<HarnessId> | undefined>(
    MODULE_SPECIFIERS.adapters,
    'getAdapter',
  );
  const adapter = get(id);
  if (adapter === undefined) {
    throw runFailure(
      'module-contract',
      `internal module '${MODULE_SPECIFIERS.adapters}' has no adapter '${id}'`,
    );
  }
  return adapter;
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

    async parseScenarioFile(file: string): Promise<ValidationResult<ScenarioSpec>> {
      const fn = await loadExport<
        (file: string) => Promise<ValidationResult<ScenarioSpec>> | ValidationResult<ScenarioSpec>
      >(MODULE_SPECIFIERS.scenario, 'parseScenarioFile');
      return await fn(file);
    },

    // The three below are synchronous in the scenario module but asynchronous here, because the
    // module edge is loaded on first use (see the header). `scenariosDir` and `scenarioFile` are
    // therefore the only ports in this file that are `async` purely for the import.
    async scenariosDir(config: Config): Promise<string> {
      const fn = await loadExport<(root: string) => string>(
        MODULE_SPECIFIERS.scenario,
        'scenariosDir',
      );
      return fn(config.root);
    },

    async scenarioFile(config: Config, name: string): Promise<string> {
      const fn = await loadExport<(root: string, name: string) => string>(
        MODULE_SPECIFIERS.scenario,
        'scenarioFile',
      );
      return fn(config.root, name);
    },

    async listScenarios(config: Config): Promise<string[]> {
      const fn = await loadExport<(root: string) => Promise<string[]>>(
        MODULE_SPECIFIERS.scenario,
        'listScenarios',
      );
      return await fn(config.root);
    },

    // The variant edge, bound exactly as the scenario one above.
    async parseVariantFile(file: string): Promise<ValidationResult<VariantSpec>> {
      const fn = await loadExport<
        (file: string) => Promise<ValidationResult<VariantSpec>> | ValidationResult<VariantSpec>
      >(MODULE_SPECIFIERS.variant, 'parseVariantFile');
      return await fn(file);
    },

    async variantsDir(config: Config): Promise<string> {
      const fn = await loadExport<(root: string) => string>(
        MODULE_SPECIFIERS.variant,
        'variantsDir',
      );
      return fn(config.root);
    },

    async variantFile(config: Config, name: string): Promise<string> {
      const fn = await loadExport<(root: string, name: string) => string>(
        MODULE_SPECIFIERS.variant,
        'variantFile',
      );
      return fn(config.root, name);
    },

    async listVariants(config: Config): Promise<string[]> {
      const fn = await loadExport<(root: string) => Promise<string[]>>(
        MODULE_SPECIFIERS.variant,
        'listVariants',
      );
      return await fn(config.root);
    },

    // The e2e edge (e2e spec §6). Both calls take the loaded config because ingestion writes into
    // the store at `config.dir` — `vdiff e2e` outside a project must fail as a config error, not as
    // an ingestion that silently created a store somewhere else.
    async planE2eIngest(config: Config, request: E2eIngestRequest): Promise<E2eIngestPlan> {
      const fn = await loadExport<
        (config: Config, request: E2eIngestRequest) => Promise<E2eIngestPlan>
      >(MODULE_SPECIFIERS.e2e, 'planIngest');
      return await fn(config, request);
    },

    async ingestE2eTraces(config: Config, request: E2eIngestRequest): Promise<E2eIngestReport> {
      const fn = await loadExport<
        (config: Config, request: E2eIngestRequest) => Promise<E2eIngestReport>
      >(MODULE_SPECIFIERS.e2e, 'ingestTraces');
      return await fn(config, request);
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
      const notes = (module['HARNESS_NOTES'] ?? {}) as Partial<Record<string, readonly string[]>>;
      return (adapters as HarnessAdapter[]).map((adapter) => ({
        id: adapter.id,
        label: adapter.label,
        notes: notes[adapter.id] ?? [],
      }));
    },

    async adapterFiles(id: string, scope: InstallScope): Promise<ManagedFile[]> {
      return await (await resolveAdapter(id)).files(scope);
    },

    async adapterTargets(id: string, scope: InstallScope): Promise<HarnessTargets> {
      return (await resolveAdapter(id)).targets(scope);
    },

    async installAdapter(
      id: string,
      root: string,
      options: InstallOptions,
    ): Promise<HarnessInstallDetail> {
      const fn = await loadExport<
        (id: string, root: string, options: InstallOptions) => Promise<HarnessInstallDetail>
      >(MODULE_SPECIFIERS.adapters, 'installAdapter');
      return await fn(id, root, options);
    },

    async readInstalledVersion(content: string): Promise<string | null> {
      const fn = await loadExport<(content: string) => string | null>(
        MODULE_SPECIFIERS.adapters,
        'readInstalledVersion',
      );
      return fn(content);
    },
  };
}
