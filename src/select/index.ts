/**
 * Module edge for `select/` (selection spec §3).
 *
 * What `vdiff select` and the action need: the selection itself, its summary, and the route and
 * graph helpers a test or an adapter for another router would build on.
 */

export {
  selectFlows,
  summarizeSelection,
  type FlowSelection,
  type SelectReason,
  type SelectRequest,
  type SelectionMode,
} from './select.js';

export {
  flowRoutes,
  nextPagesRouter,
  normalizeRoute,
  pageForRoute,
  routerFor,
  type Route,
  type Router,
  type RouterId,
} from './routes.js';

export {
  buildImportGraph,
  filesReaching,
  importsOf,
  namesInClause,
  readSources,
  resolveSpecifier,
  type ImportEntry,
  type ImportGraph,
  type SourceMap,
  type SourcePath,
} from './graph.js';
