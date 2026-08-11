/**
 * Adapters, generated from the harness table.
 *
 * There is one adapter implementation, parameterised by a table row. `ADAPTERS` is
 * `HARNESSES.map(createAdapter)`, so a fifth harness is a row in `harnesses.ts` and nothing else —
 * no module to add here, no registration to forget.
 *
 * Nothing here imports the CLI, the runner, or the diff engine: installing an adapter must not pull
 * the whole tool into memory. The only non-adapter import is the version constant, which the D17
 * frontmatter stamp needs.
 */

import { composeFiles, harnessTargets, type ComposeContext, type HarnessTargets } from './compose.js';
import { writeManagedFiles, type FileOutcome, type ManagedFile, type WriteOptions } from './files.js';
import {
  HARNESSES,
  HARNESS_NOTES,
  HARNESS_TARGET_KINDS,
  INSTALL_SCOPES,
  getHarness,
  type Harness,
  type HarnessId,
  type InstallScope,
  type InstallTargetId,
  type TargetKind,
} from './harnesses.js';
import {
  GITHUB_ACTIONS_ID,
  GITHUB_ACTIONS_LABEL,
  GITHUB_ACTIONS_NOTES,
  GITHUB_ACTIONS_SCOPES,
  githubActionsFiles,
  githubActionsTargets,
  installGithubActions,
} from './github-actions/index.js';
import { loadSkillBundle, type SkillBundle } from './source.js';
import { TOOL_VERSION } from '../version.js';

/** `WriteOptions` plus the two things a harness install needs to resolve its paths and its stamp. */
export interface InstallOptions extends WriteOptions {
  /** Project-local by default (D16). `global` writes the same relative paths under `$HOME`. */
  scope?: InstallScope;
  /** The version recorded in the files. Defaults to the running CLI; overridden only by tests. */
  version?: string;
  /** Pre-loaded skill sources, so one `--list` does not re-read `skills/` per harness. */
  bundle?: SkillBundle;
}

/**
 * Result of an install, widened from `AdapterInstallResult` with the per-file detail a caller needs
 * to explain a skip. The scope is deliberately not repeated here — the caller chose it, and
 * `adapter.targets(scope)` is where the resolved directories come from.
 *
 * Generic in the id so `installClaudeCode` still returns something assignable to the narrow
 * `Adapter` contract in `src/types.ts`, whose `AdapterId` this module deliberately does not widen.
 */
export interface HarnessInstallDetail<Id extends InstallTargetId = InstallTargetId> {
  id: Id;
  written: string[];
  skipped: string[];
  files: FileOutcome[];
}

/** The shape the CLI codes against. `targets` is what install output names (D18). */
export interface HarnessAdapter<Id extends InstallTargetId = InstallTargetId> {
  id: Id;
  label: string;
  /**
   * Which kinds of artifact this target is about (CI spec D34).
   *
   * An agent harness declares the three agent-facing kinds, so a harness with no command mechanism
   * is *reported* as having none rather than silently writing fewer files (D15). A CI target declares
   * `workflows` alone, so install output does not explain that GitHub Actions ships no skills.
   */
  kinds: readonly TargetKind[];
  /**
   * Scopes this target has. Every harness has both (D16); `.github/workflows` is per repository, so
   * the CI target has only `project` and asking for the other is a config error naming the reason.
   */
  scopes: readonly InstallScope[];
  /**
   * What "installed" does not guarantee for this harness — a personal copy overriding the project
   * one, a duplicate staying visible, the mechanism being switched off in configuration. Carried on
   * the adapter so install output can print it without a second lookup, and so a fifth harness
   * arrives with its caveats attached (see {@link HARNESS_NOTES}).
   */
  notes: readonly string[];
  /** What to do next, printed after a successful install. */
  next: readonly string[];
  install(root: string, options?: InstallOptions): Promise<HarnessInstallDetail<Id>>;
  /** Every file this adapter would write, fully composed. Touches no project directory. */
  files(scope?: InstallScope, options?: Omit<InstallOptions, 'scope'>): Promise<ManagedFile[]>;
  /** The real directories this adapter writes for a scope, without composing anything. */
  targets(scope?: InstallScope): HarnessTargets;
}

async function contextFor(
  harness: Harness,
  options: InstallOptions,
): Promise<ComposeContext> {
  return {
    harness,
    scope: options.scope ?? 'project',
    bundle: options.bundle ?? (await loadSkillBundle()),
    version: options.version ?? TOOL_VERSION,
  };
}

/** Every file `harness` would write for `scope`. The single composition entry point. */
export async function harnessFiles(
  harness: Harness,
  options: InstallOptions = {},
): Promise<ManagedFile[]> {
  return composeFiles(await contextFor(harness, options));
}

/** Write `harness`'s files under `root`. `root` is the project root, or `$HOME` for a global install. */
export async function installHarness<Id extends HarnessId>(
  harness: Harness & { id: Id },
  root: string,
  options: InstallOptions = {},
): Promise<HarnessInstallDetail<Id>> {
  const ctx = await contextFor(harness, options);
  const report = await writeManagedFiles(root, composeFiles(ctx), options);
  return {
    id: harness.id,
    written: report.written,
    skipped: report.skipped,
    files: report.files,
  };
}

/**
 * One adapter per table row, memoised on the row itself so `createAdapter(CLAUDE_CODE)` and the
 * entry in `ADAPTERS` are the same object — two stateless twins would work, but then
 * `getAdapter('claude-code') === claudeCodeAdapter` would quietly be false.
 */
const ADAPTER_CACHE = new WeakMap<Harness, HarnessAdapter>();

export function createAdapter<Id extends HarnessId>(
  harness: Harness & { id: Id },
): HarnessAdapter<Id> {
  const cached = ADAPTER_CACHE.get(harness);
  if (cached !== undefined) return cached as HarnessAdapter<Id>;

  const adapter: HarnessAdapter<Id> = {
    id: harness.id,
    label: harness.label,
    kinds: HARNESS_TARGET_KINDS,
    scopes: INSTALL_SCOPES,
    notes: HARNESS_NOTES[harness.id],
    next: ['`vdiff init` to scaffold .visual-diff/, then `vdiff run <flow>`.'],
    install: (root: string, options: InstallOptions = {}): Promise<HarnessInstallDetail<Id>> =>
      installHarness(harness, root, options),
    files: (
      scope: InstallScope = 'project',
      options: Omit<InstallOptions, 'scope'> = {},
    ): Promise<ManagedFile[]> => harnessFiles(harness, { ...options, scope }),
    targets: (scope: InstallScope = 'project'): HarnessTargets => harnessTargets(harness, scope),
  };

  ADAPTER_CACHE.set(harness, adapter as HarnessAdapter);
  return adapter;
}

/**
 * The GitHub Actions target, as an adapter (CI spec D34).
 *
 * Hand-written rather than generated from a table row, because it is not a harness: there is no
 * frontmatter to compose, no skill body to copy, and the files are YAML. What it shares with the
 * four generated adapters is the whole of what the CLI depends on — the same five methods, the same
 * managed-file writer underneath, the same stamp — so `install`, `--list` and `--check` treat it
 * identically and none of them branches on which kind of target it is.
 */
export const githubActionsAdapter: HarnessAdapter<'github-actions'> = {
  id: GITHUB_ACTIONS_ID,
  label: GITHUB_ACTIONS_LABEL,
  kinds: ['workflows'],
  scopes: GITHUB_ACTIONS_SCOPES,
  notes: GITHUB_ACTIONS_NOTES,
  next: [
    'Commit .github/workflows/ and open a pull request — a workflow GitHub has never seen never runs.',
    '`vdiff init` first if .visual-diff/ does not exist yet: the job needs a flow to replay.',
  ],
  install: async (root, options = {}) => {
    const detail = await installGithubActions(root, {
      ...options,
      ...(options.version === undefined ? {} : { version: options.version }),
    });
    return {
      id: GITHUB_ACTIONS_ID,
      written: detail.written,
      skipped: detail.skipped,
      files: detail.files as FileOutcome[],
    };
  },
  files: async (scope: InstallScope = 'project', options: Omit<InstallOptions, 'scope'> = {}) => {
    // A scope this target does not have writes nothing rather than throwing, so `--list` and
    // `--check` can walk both scopes for every registered target without special-casing this one.
    if (!GITHUB_ACTIONS_SCOPES.includes(scope)) return [];
    return githubActionsFiles(options.version === undefined ? {} : { version: options.version });
  },
  targets: (scope: InstallScope = 'project') => githubActionsTargets(scope),
};

/** Every registered adapter, in registration order: the four harnesses, then the CI targets. */
export const ADAPTERS: readonly HarnessAdapter[] = [
  ...HARNESSES.map((harness) => createAdapter(harness)),
  githubActionsAdapter,
];

/** Every registered target id, in registration order. */
export function listAdapters(): InstallTargetId[] {
  return ADAPTERS.map((adapter) => adapter.id);
}

/** The adapter for an id, or undefined when the id is not registered. */
export function getAdapter(id: string): HarnessAdapter | undefined {
  const harness = getHarness(id);
  if (harness !== undefined) return createAdapter(harness);
  return ADAPTERS.find((adapter) => adapter.id === id);
}

/**
 * Install one harness's files under `root`.
 * Throws on an unknown id — the caller (the CLI) maps that to exit code 2.
 */
export async function installAdapter(
  id: string,
  root: string,
  options: InstallOptions = {},
): Promise<HarnessInstallDetail> {
  const adapter = getAdapter(id);
  if (!adapter) {
    throw new Error(`unknown adapter '${id}'. Available: ${listAdapters().join(', ')}`);
  }
  return adapter.install(root, options);
}
