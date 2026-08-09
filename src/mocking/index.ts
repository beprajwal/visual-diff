/**
 * The overlay engine (mocking spec §5): scenarios applied to requests, as pure logic.
 *
 * Nothing here touches a browser, a socket or a clock. The runner owns execution — aborting,
 * fulfilling, and deferring a fulfilment for `delay` (§11) — and this module owns the decision:
 * which rule matched, what it does, and what to record about it.
 *
 * ```ts
 * const engine = new ScenarioEngine(spec);
 * const selected = engine.select(request);
 * const recorded = engine.needsRecordedResponse(selected) ? har.find(method, url) : undefined;
 * const { action, attribution } = engine.resolve(request, selected, recorded);
 * // …execute `action`, write `attribution` into network.json…
 * for (const warning of engine.warnings()) run.warn(warning);
 * ```
 *
 * This file is also the **module edge for the whole API-mocking slice**, which is why the scenario
 * *language* — parsing, validation, scaffolding, and the file layout under `.visual-diff/scenarios`
 * — is re-exported here from `../scenario/`. The CLI binds one specifier per subsystem
 * (`cli/deps.ts#MODULE_SPECIFIERS`) and loads it on first use, so `vdiff scenario check` must reach
 * parsing and the overlay engine through one import. The dependency runs one way only: `mocking/`
 * imports `scenario/`, never the reverse, so the two can be loaded independently by the runner,
 * which does exactly that.
 */

export {
  MAX_REPORTED_MISS_URLS,
  ScenarioEngine,
  needsRecordedResponse,
  resolveDecision,
  verbOf,
  type AbortReason,
  type MockAction,
  type ResolveParams,
  type ScenarioDecision,
} from './engine.js';

export { ScenarioError, ruleLabel, type ScenarioErrorCode, type ScenarioErrorInit } from './errors.js';

export {
  GlobSyntaxError,
  compileGlob,
  globErrorMessage,
  globMatcher,
  matchesGlob,
  urlGlobError,
  type GlobCompileError,
  type GlobCompileResult,
} from './glob.js';

export {
  applyJsonPatch,
  escapeToken,
  formatJsonPointer,
  parseJsonPointer,
  unescapeToken,
  validateJsonPatch,
  validateJsonPatchOperation,
  type JsonPatchApplyResult,
  type JsonPatchErrorCode,
  type JsonPatchFailure,
  type PointerParseResult,
} from './json-patch.js';

export {
  RequestCounter,
  requestKey,
  ruleMatches,
  selectRule,
  type MockRequest,
  type SelectedRule,
} from './match.js';

export { applyMergePatch, cloneJson, isJsonObject, jsonEquals } from './merge-patch.js';

export { listScenarios, scenarioFile, scenariosDir } from './paths.js';

/*
 * The scenario language, re-exported (see the header). Deliberately a named list rather than
 * `export *`: `scenario/` also exports a glob compiler and a `verbOf`, both of which have
 * same-named siblings above, and re-exporting those wholesale would make which one a caller gets
 * depend on the order of two `export *` lines.
 */
export {
  ScenarioSpecError,
  formatIssue,
  formatIssues,
  isScenarioSpecError,
  loadScenarioFile,
  loadScenarioSource,
  parseScenarioFile,
  parseScenarioSource,
  scaffoldScenarioSource,
  scaffoldScenarioSpec,
  scenarioFileName,
  scenarioNameFromFile,
  scenarioNameIssue,
  scenarioRelPath,
  scenarioRepoPath,
  scenarioSummary,
  serializeScenario,
  structuralScenarioDiff,
  validateScenarioSpec,
  type ScaffoldOptions,
  type ScenarioDiffEntry,
  type ScenarioSpecInput,
} from '../scenario/index.js';

export {
  bodyBytes,
  bodyChangedFrom,
  isJsonMediaType,
  jsonBody,
  mediaTypeOf,
  mockFromRecorded,
  normalizeHeaders,
  responseFromSpec,
  withJsonBody,
  type JsonBodyResult,
  type MockResponse,
  type RecordedResponse,
} from './response.js';
