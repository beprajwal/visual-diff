/**
 * Module edge for `runner/` (spec §5).
 *
 * `runFlow` is the whole public surface the CLI needs: one flow name plus flags in, one appended
 * run out. Everything else exported here exists so tests and the fixture suite can drive the parts
 * (determinism knobs, worktrees, the dep cache, the dev server probe) without a browser.
 */

export { runFlow, mergeStep, statusOf, type RunContext } from './run.js';

export {
  CHROMIUM_LAUNCH_ARGS,
  DETERMINISM_CSS,
  DETERMINISM_STYLE_ID,
  FROZEN_EPOCH_MS,
  LOCALE,
  RANDOM_SEED,
  TIMEZONE,
  buildInitScript,
  deterministicEnv,
  mulberry32,
  type InitScriptOptions,
} from './determinism.js';

export {
  contextOptions,
  launchChromium,
  loadPlaywright,
  newContext,
  settle,
  type ContextOptions,
} from './browser.js';

export {
  collectArgs,
  collectDom,
  emptyStyles,
  toA11ySnapshot,
  toDomSnapshot,
  type CollectArgs,
  type CollectResult,
} from './capture.js';

export {
  nextAnchor,
  pngSize,
  replayViewport,
  selectorOf,
  verbOf,
  type ReplayOptions,
  type StepOutcome,
  type ViewportReplay,
} from './replay.js';

export {
  LogTail,
  allocatePort,
  portOfUrl,
  probe,
  startDevServer,
  substitutePort,
  waitForReady,
  type DevServerHandle,
  type StartDevServerOptions,
} from './devserver.js';

export { REDACTED, scrubHar, scrubHarFile, scrubHarObject, type ScrubOptions } from './har.js';

export {
  depsCacheEntry,
  defaultInstallCommand,
  ensureDeps,
  findLockfile,
  hashLockfile,
  linkNodeModules,
  runCommand,
  LOCKFILES,
  type DepsResult,
  type EnsureDepsOptions,
} from './deps.js';

export {
  addWorktree,
  assertInside,
  listWorktrees,
  reapWorktrees,
  removeWorktreeAt,
  withWorktree,
  worktreePathFor,
  type Worktree,
} from './worktree.js';

export {
  dirtyHash,
  git,
  isAllowedGitCommand,
  isGitRepo,
  porcelainStatus,
  readGitState,
  readGitStateSafe,
  repoRoot,
  resolveRef,
  sameGitState,
  showFileAtRev,
  toRevision,
  type GitState,
} from './git.js';

export {
  formatViewport,
  normalizeViewports,
  parseViewport,
  runPool,
  tryParseViewport,
  type PoolOutcome,
} from './viewport.js';

export { RunnerError, errorMessage, errorStack, type RunnerErrorInit } from './errors.js';
