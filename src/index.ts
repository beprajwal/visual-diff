/**
 * `@beprajwal/visual-diff` — package entry point (`package.json#main`).
 *
 * The product is the `vdiff` binary; this module exists so the same functionality is importable,
 * which is what makes the module seams of spec §5 real rather than notional. It re-exports the
 * shared contracts and each module's edge — and nothing below an edge, so a consumer cannot reach
 * into a module's internals and freeze them into the public API by accident.
 *
 * `runner/` and `report/` are deliberately *not* re-exported eagerly: importing them pulls in
 * Playwright and an HTTP server. They are reachable as `@beprajwal/visual-diff/dist/runner/index.js` and via
 * the CLI, and as the lazily-loaded module edges in `cli/deps.ts`.
 */

export * from './types.js';
export { TOOL_VERSION, toolVersion } from './version.js';

export {
  canonicalFlow,
  describeStepChanges,
  flowLevelChanges,
  hashFlow,
  hashFlowSource,
  loadFlowFile,
  loadFlowSource,
  parseFlowFile,
  parseFlowSource,
  scaffoldFlowSource,
  serializeFlow,
  structuralFlowDiff,
  validateFlowSpec,
  SpecError,
  type FlowDiffInput,
} from './flow/index.js';

/*
 * The API-mocking edge (`mocking/index.ts`), which re-exports the scenario language from
 * `scenario/index.ts`. Curated rather than `export *` for the reason in the header, and because
 * the module also carries deliberately generic internals — a glob compiler, a `verbOf` — that
 * would read as package-level API if they appeared here.
 */
export {
  ScenarioEngine,
  ScenarioError,
  ScenarioSpecError,
  applyJsonPatch,
  applyMergePatch,
  isScenarioSpecError,
  listScenarios,
  loadScenarioFile,
  loadScenarioSource,
  parseScenarioFile,
  parseScenarioSource,
  resolveDecision,
  scaffoldScenarioSource,
  scenarioFile,
  scenarioSummary,
  scenariosDir,
  serializeScenario,
  structuralScenarioDiff,
  validateScenarioSpec,
  type MockAction,
  type ScenarioDecision,
  type ScenarioDiffEntry,
} from './mocking/index.js';

export {
  loadConfig,
  loadConfigOrThrow,
  openStore,
  paths,
  StoreError,
  isStoreError,
  type Store,
} from './store/index.js';

export {
  computeDiff,
  computeDiffRequest,
  defaultDiffOptions,
  diffRuns,
  vdiffDirOf,
  type DiffRequest,
} from './diff/index.js';

export { ADAPTERS, getAdapter, installAdapter, listAdapters } from './adapters/index.js';

export { runCli, main as runCliMain } from './cli/main.js';
