/**
 * cli — the CI vocabulary, as argv speaks it (CI spec §7).
 *
 * The same shape as `cli/e2e.ts` and `cli/variant.ts`, and for the same reason: the values live in
 * the module that acts on them (`ci/gate.ts`, `ci/layout.ts`), and the CLI re-exports them so the
 * parser validates against the *implementation's* vocabulary rather than a copy of it that drifts.
 *
 * Both re-exported modules are leaves — pure functions over a `DiffSummary` and a `DiffResult` — so
 * importing them from the parser costs nothing at startup. `ci/index.ts`, which pulls in the bundle
 * writer and therefore `node:fs`, stays behind the lazy module edge in `deps.ts`.
 */

export { GATE_LEVELS, GATE_NONE, evaluateGate, isGateLevel } from '../ci/gate.js';
export type { GateLevel, GateVerdict } from '../ci/gate.js';

export { HTML_MODES, IMAGE_SELECTIONS, isHtmlMode, isImageSelection } from '../ci/layout.js';
export type { HtmlMode, ImageSelection } from '../ci/layout.js';

// The review's provider vocabulary (D39) — a leaf too: env-variable names and defaults, no client.
export {
  DEFAULT_REVIEW_MODEL,
  REVIEW_KEY_ENV,
  isReviewProvider,
  resolveReviewProvider,
} from '../ci/review-provider.js';
export type { ReviewCredentials } from '../ci/review-provider.js';
// And its renderer — the same lines the comment carries, printed by `vdiff review` in human mode.
export { flaggedChanges, reviewLines } from '../ci/review-render.js';

/** What `--images` defaults to: the shots that moved (CI spec §5). */
export const DEFAULT_IMAGE_SELECTION = 'changed';

/** What `--html` defaults to: the relative-path page, which keeps the bundle at today's size. */
export const DEFAULT_HTML_MODE = 'linked';
