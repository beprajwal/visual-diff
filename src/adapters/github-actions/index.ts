/**
 * The GitHub Actions install target (CI spec §7, D34).
 *
 * `vdiff install github-actions` is the same *command* as `vdiff install claude-code`, and
 * deliberately not the same kind of thing: a workflow file is not a skill. It carries no
 * frontmatter, has no user-level location, and is read by a CI runner rather than an agent. So it is
 * not a row in the harness table — that table is about agents, and bending it to hold a
 * `frontmatter` function nobody calls and three null skill directories would make every future
 * reader of `harnesses.ts` wonder which parts apply.
 *
 * What it *does* share is everything that matters at install time: the managed-file writer, the body
 * hash stamp, `--force`, `--dry-run`, and the preserve-a-human-edit rule (D17). A workflow is the
 * file a team is most likely to edit — a different runner, an extra step, a schedule — and clobbering
 * that edit on a version bump would be the same betrayal it would be for a skill.
 *
 * Project scope only. `.github/workflows` has no user-level equivalent, and there is no plausible
 * `~/.github/workflows` to invent; asking for one is a config error naming the reason.
 */

import type { HarnessTargets } from '../compose.js';
import { writeManagedFiles, type ManagedFile, type WriteOptions } from '../files.js';
import { INSTALL_SCOPES, type InstallScope } from '../harnesses.js';
import { TOOL_VERSION } from '../../version.js';
import {
  ACTION_REF,
  BASELINE_WORKFLOW_PATH,
  PR_WORKFLOW_PATH,
  baselineWorkflow,
  prWorkflow,
} from './templates.js';

export const GITHUB_ACTIONS_ID = 'github-actions';
export const GITHUB_ACTIONS_LABEL = 'GitHub Actions';

/** The directory install output names, rather than the target id (D18's rule, applied here). */
export const WORKFLOWS_DIR = '.github/workflows';

/** Project only: there is no user-level `.github/workflows`, and inventing one would be a guess. */
export const GITHUB_ACTIONS_SCOPES: readonly InstallScope[] = ['project'];

/**
 * What "installed" does not guarantee. Same purpose as `HARNESS_NOTES`: in every case a correctly
 * written file can still fail to do anything, and the user cannot see why from the file alone.
 */
export const GITHUB_ACTIONS_NOTES: readonly string[] = [
  `The workflow calls ${ACTION_REF}@v${TOOL_VERSION}. A private repository must allow that action ` +
    'under Settings → Actions → General, or the job fails before any step runs.',
  'The comment needs `pull-requests: write`, which the written workflow requests. An organisation ' +
    'policy that caps the default token at read-only overrides it, and the comment step then fails ' +
    'with a 403 while the artifact still uploads.',
  'Nothing is committed for you: the workflow files are written to disk, and a workflow GitHub has ' +
    'never seen is a workflow that never runs.',
];

export interface GithubActionsFileOptions {
  /** Version pinned into `uses:`. Defaults to the running CLI. */
  version?: string;
  /** Default branch the baseline workflow watches. */
  defaultBranch?: string;
}

/** Both workflow files, fully composed. Touches no directory. */
export function githubActionsFiles(options: GithubActionsFileOptions = {}): ManagedFile[] {
  const version = options.version ?? TOOL_VERSION;
  const workflowOptions =
    options.defaultBranch === undefined
      ? { version }
      : { version, defaultBranch: options.defaultBranch };
  return [
    // YAML has no HTML comment, so the stamp wears `#` (D34).
    { path: PR_WORKFLOW_PATH, body: prWorkflow(workflowOptions), comment: 'hash' },
    { path: BASELINE_WORKFLOW_PATH, body: baselineWorkflow(workflowOptions), comment: 'hash' },
  ];
}

/**
 * The directories this target writes, in the shape install output prints.
 *
 * The three agent-facing kinds are null, and `workflows` carries the one real answer. A scope this
 * target does not have reports nothing at all rather than `.github/workflows` under `$HOME`.
 */
export function githubActionsTargets(scope: InstallScope = 'project'): HarnessTargets {
  const supported = GITHUB_ACTIONS_SCOPES.includes(scope);
  return {
    scope,
    skills: null,
    commands: null,
    instructions: null,
    workflows: supported ? WORKFLOWS_DIR : null,
  };
}

export interface GithubActionsInstallOptions extends WriteOptions, GithubActionsFileOptions {
  scope?: InstallScope;
}

/** Write both workflow files under `root`. */
export async function installGithubActions(
  root: string,
  options: GithubActionsInstallOptions = {},
): Promise<{ written: string[]; skipped: string[]; files: Array<{ path: string; status: string }> }> {
  const scope = options.scope ?? 'project';
  if (!GITHUB_ACTIONS_SCOPES.includes(scope)) {
    throw new UnsupportedScopeError(scope);
  }
  const fileOptions: GithubActionsFileOptions = {};
  if (options.version !== undefined) fileOptions.version = options.version;
  if (options.defaultBranch !== undefined) fileOptions.defaultBranch = options.defaultBranch;
  const report = await writeManagedFiles(root, githubActionsFiles(fileOptions), options);
  return { written: report.written, skipped: report.skipped, files: report.files };
}

/**
 * Asking for a scope this target does not have.
 *
 * Its own error class so the CLI can map it to exit 2 with the reason rather than to "install
 * failed", which is what a caller sees when a refusal arrives as a bare `Error`. Recognised by name
 * for the same reason `MalformedBlockError` is: the CLI imports no adapter module statically.
 */
export class UnsupportedScopeError extends Error {
  readonly scope: InstallScope;

  constructor(scope: InstallScope) {
    super(
      `${GITHUB_ACTIONS_LABEL} has no ${scope} target: workflows live in ${WORKFLOWS_DIR}, ` +
        'which exists per repository and has no user-level equivalent',
    );
    this.name = 'UnsupportedScopeError';
    this.scope = scope;
  }
}

/** Every scope, for a `--list` that walks them. Re-exported so callers need one import. */
export { INSTALL_SCOPES };
export { ACTION_REF, BASELINE_WORKFLOW_PATH, PR_WORKFLOW_PATH, baselineWorkflow, prWorkflow };
