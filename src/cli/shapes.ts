/**
 * cli — the `data` payload of each command's `--json` envelope (spec §9, §11.6).
 *
 * `CliEnvelope<T>` in `src/types.ts` fixes the wrapper (`ok`, `command`, `version`, `data`,
 * `error`, `warnings`); these interfaces fix each `T`. They are the agent-facing API across four
 * harnesses, so they are pinned by contract tests and must not drift silently.
 *
 * Where a shape already exists in `src/types.ts` — `RunResult` for `run`, `ServeInfo` for `serve`,
 * `RunSummary` for `runs` — it is reused verbatim rather than restated.
 */

import type {
  DiffResult,
  FeedbackEntry,
  PairLabel,
  PairRef,
  RunId,
  RunSummary,
  ScenarioName,
  ValidationIssue,
  ViewportId,
} from '../types.js';
import type {
  FileOutcome,
  HarnessTargets,
  InstallScope,
  InstallTargetId,
  TargetKind,
} from '../adapters/index.js';
import type { GateVerdict } from './ci.js';
import type { SourcePair } from './e2e.js';
import type { E2eIngestPlan, E2eIngestReport } from './ports.js';
import type { VariantPair } from './variant.js';

/** `vdiff init` — what the scaffold wrote, and what it left alone. */
export interface InitData {
  root: string;
  dir: string;
  /** Project-root-relative, `/`-separated paths that were written. */
  created: string[];
  /** Paths that already existed and were left untouched. */
  skipped: string[];
  gitignore: 'created' | 'updated' | 'unchanged';
}

/** `vdiff flow new <name>` */
export interface FlowNewData {
  flow: string;
  path: string;
  created: boolean;
}

/** `vdiff flow check <name>` — only ever emitted for a valid spec; invalid ones are exit 2. */
export interface FlowCheckData {
  flow: string;
  path: string;
  valid: true;
  steps: number;
  viewports: ViewportId[];
  /** Step ids in declaration order — the keys the diff aligns on (D4). */
  stepIds: string[];
  warnings: ValidationIssue[];
}

/**
 * `vdiff e2e --from trace <path|glob>` — what ingestion did (e2e spec §6).
 *
 * `plan` is not repeated here: the report carries the archives that became runs, and an archive the
 * pattern named but ingestion refused is an error, not a row. `vdiff e2e list` is the command that
 * describes archives without acting on them.
 */
export interface E2eIngestData extends E2eIngestReport {
  /**
   * Archives whose hash was already in the store, so no second run was written (§6). Lifted out of
   * `runs[].reused` so an agent can answer "did this do anything?" without folding the array.
   */
  reused: number;
}

/** `vdiff e2e list --from trace <path|glob>` — what *would* be ingested. Writes nothing (§6). */
export type E2eListData = E2eIngestPlan;

/** `vdiff runs <flow> [--scenario <name>] [--variants] [--e2e]` — mirrors the report's `RunsResponse`. */
export interface RunsData {
  flow: string;
  /** The `--scenario` filter that was applied, absent when the whole timeline was listed. */
  scenario?: ScenarioName;
  /**
   * True when `--variants` listed the variant runs instead of the regression timeline (D24).
   * Absent rather than `false` on an ordinary listing, so the payload of `vdiff runs <flow>` is
   * unchanged from what it has always been.
   */
  variants?: true;
  /**
   * True when `--e2e` listed the ingested runs instead of the replay timeline (D27). Absent rather
   * than `false` for exactly the reason `variants` is: an ordinary listing's payload must not change
   * shape because a feature the project does not use exists.
   */
  e2e?: true;
  runs: RunSummary[];
}

/** `vdiff diff <flow> [base] [head] [--scenario <name>] [--variant <name>]` */
export interface DiffData {
  flow: string;
  pair: PairRef;
  /** Absolute path of the stored `findings.json`. */
  path: string;
  /** True when the stored diff was reused rather than recomputed (spec §8). */
  cached: boolean;
  /**
   * The pairings the tool permits but refuses to let pass as ordinary regressions (mocking spec
   * §6): `cross-scenario`, `mock-vs-recorded`. Empty for a same-scenario pair. Lifted out of
   * `result.scenarios` so an agent reads one field rather than deriving two booleans.
   */
  labels: PairLabel[];
  /**
   * What this pair is once variants are in play (variants spec §5), absent when neither side ran
   * one. Kept apart from `labels` deliberately: the common case here — `variant-proposal` — is not
   * a caveat but the question a variant run exists to answer, and folding it into the list of
   * pairings the tool refuses to let pass as regressions would say the opposite.
   */
  variantPair?: VariantPair;
  /**
   * What this pair is on the source axis (e2e spec §7, D27), absent when both sides were replayed —
   * which is every pair a project that has never ingested a trace can produce.
   *
   * Kept apart from `labels` for the same reason `variantPair` is, and with the opposite emphasis:
   * `e2e-vs-replay` genuinely is a caveat and travels as a warning too, while `e2e-pair` is the
   * normal case for e2e mode and carries only the reduced-detail explanation (§4).
   */
  sourcePair?: SourcePair;
  result: DiffResult;
}

/**
 * `vdiff comment <flow> [base] [head]` — the rendered markdown and what shaped it (CI spec §6).
 *
 * The markdown travels *inside* the envelope rather than on stdout when `--json` is given, because
 * the transport that posts it is the same kind of consumer as an agent: one object, one field to
 * read, no stream to split. `path` is set when `--out` wrote a file, so a workflow can hand the file
 * to `gh` without re-serialising the body through a shell.
 */
export interface CommentData {
  flow: string;
  pair: PairRef;
  markdown: string;
  /** The HTML comment an upserting transport searches for (D33). Always the first line of `markdown`. */
  marker: string;
  bytes: number;
  /** Image groups rendered. Zero whenever no `--image-base` was given — GitHub cannot serve one (D31). */
  images: number;
  /** What did not fit in the body, so a caller can log it rather than discover it (D33). */
  truncated: { findings: number; images: number; steps: boolean };
  /** Absolute path written by `--out`; null when the markdown went to stdout only. */
  path: string | null;
  /** The gate that was evaluated. `level: 'none'` — the default — never trips (D30). */
  gate: GateVerdict;
  labels: PairLabel[];
  /** Every pairing sentence the comment carries, in the order it carries them. */
  notices: string[];
  result: DiffResult;
}

/** `vdiff export <flow> [base] [head]` — the bundle that was written (CI spec §5). */
export interface ExportData {
  flow: string;
  pair: PairRef;
  /** Absolute path of the bundle directory. */
  outDir: string;
  /** Bundle-relative paths written, in write order. */
  files: string[];
  /** Image files copied. Counts files, not cells: one cell is up to three of them. */
  images: number;
  /**
   * Sources that were expected and absent — a pruned run has no screenshots, and a step with no
   * base side has no pixel diff. Reported rather than repaired: inventing an image would be worse.
   */
  missing: string[];
  gate: GateVerdict;
  labels: PairLabel[];
  notices: string[];
  /** The bundle's own `comment.md`, rendered with bundle-relative image paths. */
  comment: { path: string; bytes: number };
  result: DiffResult;
}

/** `vdiff feedback [--ack]` */
export interface FeedbackData {
  count: number;
  entries: FeedbackEntry[];
  acked: boolean;
  /** Absolute path of `feedback/archive/<date>.jsonl`, set only when `--ack` was passed. */
  archive: string | null;
}

/** `vdiff pin <run>` */
export interface PinData {
  flow: string;
  runId: RunId;
  pinned: boolean;
}

/** `vdiff prune <run>` */
export interface PruneData {
  flow: string;
  runId: RunId;
  pruned: boolean;
}

/** `vdiff install <harness>` — the adapter files that were (or, with `--dry-run`, would be) written. */
export interface InstallData {
  harness: InstallTargetId;
  /** Which kinds of artifact this target writes (CI spec D34): the agent-facing three, or workflows. */
  kinds: readonly TargetKind[];
  /** Human name of the harness, e.g. "Claude Code". */
  label: string;
  /** Which target layout was written: project-local by default, user-level under `--global` (D16). */
  scope: InstallScope;
  /** Absolute directory the paths below are relative to. */
  root: string;
  /** The version stamped into every written file (D17). */
  version: string;
  /**
   * The real directories this scope resolves to. A null member is a mechanism the harness does not
   * have — not an error, and named as such in the output (D15).
   */
  targets: HarnessTargets;
  /** Project-relative paths created or updated. */
  written: string[];
  /** Paths left alone: already current, or edited by a human and preserved. */
  skipped: string[];
  /** Per-file outcome, so a caller can tell `preserved` from `unchanged`. */
  files: FileOutcome[];
  /** True when nothing was actually written. */
  dryRun: boolean;
  /** What "installed" does not guarantee for this harness. Never empty in practice. */
  notes: readonly string[];
}

/** One scope of one harness in the `vdiff install --list` payload. */
export interface InstallListScope {
  scope: InstallScope;
  /** Absolute directory the paths below are relative to. */
  root: string;
  /** The real directories this scope writes; a null member is a mechanism the harness lacks. */
  targets: HarnessTargets;
  /** Root-relative paths this harness would write in this scope, in install order. */
  files: string[];
}

/** One harness in the `vdiff install --list` payload. */
export interface InstallListHarness {
  id: InstallTargetId;
  label: string;
  /** Both scopes, project first — `--list` documents targets, not just filenames (§5). */
  scopes: InstallListScope[];
  notes: readonly string[];
}

/** `vdiff install --list` — what ships, for every registered harness. Writes nothing. */
export interface InstallListData {
  harnesses: InstallListHarness[];
}

/**
 * How one installed file compares to what this build would write (§5, "Drift").
 *
 * - `current`          — byte-identical to what this version writes
 * - `stale`            — written by this tool, and different from what this version writes
 * - `missing`          — not installed at all
 * - `modified-locally` — present, and edited after this tool wrote it
 */
export type InstallDriftStatus = 'current' | 'stale' | 'missing' | 'modified-locally';

/**
 * A scope's roll-up adds one case a single file cannot have: the target could not be read at all —
 * an unreadable directory, or an `AGENTS.md` whose markers this tool refuses to guess about.
 * Reported rather than thrown, because `--check` exits 0 always.
 */
export type InstallScopeStatus = InstallDriftStatus | 'unreadable';

export interface InstallCheckFile {
  /** Root-relative path, as the adapter names it. */
  path: string;
  status: InstallDriftStatus;
  /** The version stamp read off the installed copy; null when it carries none. */
  installedVersion: string | null;
}

export interface InstallCheckScope {
  scope: InstallScope;
  /** Absolute directory the paths below are relative to. */
  root: string;
  /**
   * The worst case present among this scope's files, ranked
   * `modified-locally` > `stale` > `missing` > `current`.
   */
  status: InstallScopeStatus;
  /**
   * True on *both* scopes when both hold an install.
   *
   * Deliberately not called "shadowed": which copy a harness actually reads differs per harness —
   * Claude Code prefers the personal one, pi keeps whichever it finds first, Codex shows both — so
   * the payload reports the duplication as a fact and leaves the consequence to `notes`.
   */
  duplicate: boolean;
  /** The underlying error when `status` is `unreadable`; null otherwise. */
  error: string | null;
  files: InstallCheckFile[];
}

export interface InstallCheckHarness {
  id: InstallTargetId;
  label: string;
  /** Project first, then global. Both are always reported, installed or not (D16). */
  scopes: InstallCheckScope[];
  notes: readonly string[];
}

/** `vdiff install --check [<harness>]` — drift, never a fix. Exit 0 always. */
export interface InstallCheckData {
  /** The running CLI version every stamp was compared against. */
  version: string;
  harnesses: InstallCheckHarness[];
  /**
   * True when any scope is `stale` or `modified-locally`. A harness that is simply not installed
   * is not drift, so `vdiff install --check` on a fresh machine reports `false`.
   */
  drift: boolean;
}

/** `vdiff install-browser` */
export interface InstallBrowserData {
  browser: 'chromium';
  installed: boolean;
  /** The command that was executed, for reproducibility in a log. */
  command: string;
}

/** `vdiff --help` / `vdiff help` */
export interface HelpData {
  usage: string[];
  commands: Array<{ name: string; usage: string; summary: string }>;
}

/** `vdiff --version` */
export interface VersionData {
  version: string;
}
