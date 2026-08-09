/**
 * Module edge for `scenario/` (mocking spec §5, §7, §8).
 *
 * Everything another module needs from the scenario layer is re-exported here: parsing and
 * validation of the YAML spec, canonical serialization, the URL-glob compiler the overlay engine
 * matches with, the rule-id structural diff, the `vdiff scenario new` scaffold and the
 * `vdiff scenario list` summary. Nothing outside this module reaches past this file.
 *
 * The layer is pure and dependency-light on purpose, exactly as `flow/` is: no filesystem beyond
 * `readFile`, no Playwright, no store. Historical replay reads a scenario out of git at the target
 * SHA (D4) and hands it here as text.
 */

export {
  loadScenarioFile,
  loadScenarioSource,
  parseScenarioFile,
  parseScenarioSource,
  scenarioNameFromFile,
  type ParseOptions,
} from './parse.js';

export {
  validateScenarioSpec,
  findNonJson,
  type ValidateOptions,
  type ValidateOutcome,
} from './validate.js';

export { keyPath, locateInDoc, locateOffset, type Locate } from './locate.js';

export {
  canonicalPatchOp,
  canonicalRule,
  canonicalScenario,
  serializeScenario,
} from './serialize.js';

export {
  compileGlob,
  globMatches,
  parseGlob,
  GlobError,
  type GlobFailure,
  type GlobParseResult,
  type GlobSuccess,
} from './glob.js';

export {
  describeRuleChanges,
  formatRuleChanges,
  ruleFieldChanges,
  scenarioLevelChanges,
  structuralScenarioDiff,
  verbOf,
  type RuleFieldChange,
  type ScenarioDiffEntry,
  type ScenarioDiffInput,
  type ScenarioDiffStatus,
} from './structural-diff.js';

export {
  scaffoldScenarioSource,
  scaffoldScenarioSpec,
  type ScaffoldOptions,
} from './scaffold.js';

export {
  assertScenarioName,
  isValidScenarioName,
  scenarioFileName,
  scenarioNameIssue,
  scenarioRelPath,
  scenarioRepoPath,
  scenarioSummary,
} from './name.js';

export {
  ScenarioSpecError,
  formatIssue,
  formatIssues,
  isScenarioSpecError,
} from './errors.js';

export {
  MATCH_KEYS,
  PATCH_OP_KEYS,
  RESPOND_KEYS,
  RULE_KEYS,
  SAFE_SCENARIO_NAME_RE,
  SCENARIOS_DIRNAME,
  SCENARIO_KEYS,
  scenarioSpecSchema,
  type ScenarioRuleInput,
  type ScenarioSpecInput,
} from './schema.js';
