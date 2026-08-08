/**
 * `visual-diff` — package entry point (`package.json#main`).
 *
 * The product is the `vdiff` binary; this module exists so the same functionality is importable,
 * which is what makes the module seams of spec §5 real rather than notional. It re-exports the
 * shared contracts and each module's edge — and nothing below an edge, so a consumer cannot reach
 * into a module's internals and freeze them into the public API by accident.
 *
 * `runner/` and `report/` are deliberately *not* re-exported eagerly: importing them pulls in
 * Playwright and an HTTP server. They are reachable as `visual-diff/dist/runner/index.js` and via
 * the CLI, and as the lazily-loaded module edges in `cli/deps.ts`.
 */

export * from './types.js';
export { TOOL_VERSION, toolVersion } from './version.js';

export {
  canonicalFlow,
  diffFlows,
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
} from './flow/index.js';

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
