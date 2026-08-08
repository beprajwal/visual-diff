/**
 * Module edge for `flow/` (spec §5).
 *
 * Everything another module needs from the flow layer is re-exported here: parsing and validation
 * of the YAML spec, canonical serialization, the flow hash, the stage-1 structural diff, and the
 * `vdiff flow new` scaffold. Nothing outside this module reaches past this file.
 */

export {
  loadFlowFile,
  loadFlowSource,
  parseFlowFile,
  parseFlowSource,
  keyPath,
  type ParseOptions,
} from './parse.js';

export {
  validateFlowSpec,
  type Locate,
  type ValidateOptions,
  type ValidateOutcome,
} from './validate.js';

export { canonicalFlow, canonicalStep, serializeFlow } from './serialize.js';

export { hashFlow, hashFlowSource } from './hash.js';

export {
  describeFillChanges,
  describeStepChanges,
  flowLevelChanges,
  formatStepChanges,
  isComparable,
  stepSpecChanges,
  structuralFlowDiff,
  type FlowDiffInput,
  type StepFieldChange,
} from './structural-diff.js';

export { scaffoldFlowSource, scaffoldFlowSpec, type ScaffoldOptions } from './scaffold.js';

export { SpecError, formatIssue, formatIssues, isSpecError } from './errors.js';

export {
  FORBIDDEN_KEYS,
  SAFE_NAME_RE,
  STEP_KEYS,
  VIEWPORT_RE,
  flowSpecSchema,
  type FlowSpecInput,
} from './schema.js';
