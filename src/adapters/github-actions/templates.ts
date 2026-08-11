/**
 * The workflow files `vdiff install github-actions` writes (CI spec D34, §8).
 *
 * Both are deliberately thin. Everything that could need fixing — the browser cache, the baseline
 * restore, the export, the artifact upload, the comment upsert, the gate — lives in `action.yml` in
 * this repository, which is versioned with the package. A bug fixed there reaches every repository
 * on the next tag; a bug written into a hundred users' workflow files reaches nobody.
 *
 * So what lands in `.github/workflows/` is: the trigger, the permissions, a checkout, and a call to
 * `beprajwal/visual-diff@<version>` with inputs. That is the part which is genuinely the user's —
 * when it runs, on what, with which flows — and the part a user is most likely to edit. Which is why
 * they are managed files: an edited one is preserved and reported rather than clobbered (D17).
 *
 * The stamp is a `#` comment, because YAML has no HTML comment and `<!-- … -->` in a workflow is a
 * parse error rather than an ignored line.
 */

/** The action a workflow calls. Owner/repo of this package's own repository. */
export const ACTION_REF = 'beprajwal/visual-diff';

export const PR_WORKFLOW_PATH = '.github/workflows/visual-diff.yml';
export const BASELINE_WORKFLOW_PATH = '.github/workflows/visual-diff-baseline.yml';

export interface WorkflowOptions {
  /** Version of this package, pinned into `uses:` so a workflow is reproducible. */
  version: string;
  /** Default branch the baseline workflow watches. */
  defaultBranch?: string;
}

/**
 * The pull-request workflow.
 *
 * `fetch-depth: 0` is not optional and is commented as such: the base side of the diff is the
 * merge-base revision, and a shallow clone does not contain it. Everything else is a default the
 * action already carries, written out here anyway — a user reading this file should be able to see
 * the knobs without opening the action, and a commented-out input is how they find out one exists.
 */
export function prWorkflow(options: WorkflowOptions): string {
  return `# visual-diff on pull requests.
#
# The behaviour lives in the action (${ACTION_REF}), not here: this file is the trigger, the
# permissions and the flows. Edit it freely — \`vdiff install github-actions\` preserves a file you
# have changed and reports it instead of overwriting.
name: visual-diff

on:
  pull_request:
  workflow_dispatch:

# One run per pull request. A superseded run's comment would describe a commit nobody is looking at.
concurrency:
  group: visual-diff-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
  # The comment. Without it the comment step fails with a 403 and everything else still runs.
  pull-requests: write

jobs:
  visual-diff:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4
        with:
          # Required: the base side is replayed at the merge-base, which a shallow clone lacks.
          fetch-depth: 0

      - uses: ${ACTION_REF}@v${options.version}
        with:
          # Space-separated flow names. Omit to run every flow in .visual-diff/flows.
          # flows: checkout search

          # none | high | any. Default \`none\`: findings are reported, the check stays green.
          fail-on: none

          # auto | cache | replay. \`auto\` restores a baseline captured on the default branch and
          # replays the merge-base when there is none.
          baseline: auto

          # Nominate a branch to push diff images to, and the comment embeds them. Without one, the
          # evidence travels as a workflow artifact and the comment links it — GitHub cannot render
          # an image out of an artifact.
          # publish-branch: visual-diff-reports
`;
}

/**
 * The baseline workflow.
 *
 * Optional in the sense that the pull-request workflow works without it — it replays the merge-base
 * instead, which is correct and slower (D32). What this buys is that the common case, a pull request
 * against an up-to-date default branch, restores a baseline captured on a runner of the same image
 * rather than building the base revision again.
 */
export function baselineWorkflow(options: WorkflowOptions): string {
  const branch = options.defaultBranch ?? 'main';
  return `# visual-diff baseline capture.
#
# Captures runs on ${branch} and caches them by SHA, so a pull request whose merge-base is already
# captured restores it instead of replaying the base revision. Entirely optional: without this
# workflow the pull-request job replays the merge-base, which costs a worktree and a dependency
# install per pull request but produces the same comparison.
name: visual-diff baseline

on:
  push:
    branches: [${branch}]
  workflow_dispatch:

concurrency:
  group: visual-diff-baseline-\${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  baseline:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4

      - uses: ${ACTION_REF}@v${options.version}
        with:
          # flows: checkout search
          mode: baseline
`;
}
