# CI Mode — Design (Subsystem 5: visual diff on a pull request)

Date: 2026-08-11
Status: Approved for planning
Builds on: slice 1 (D1–D9), API mocking (D10–D14), harness packaging (D15–D19), variants (D20–D24),
e2e mode (D25–D27)

## 1. Problem

Everything the tool does today happens on one machine, in front of one person. A flow is replayed at
two revisions, a diff is computed, and a local server shows it to whoever ran the command. A team
working through pull requests never sees any of it unless someone remembers to run it and paste the
result by hand.

The original design named this as a non-goal in as many words: *"No CI mode, hosted reports, or
baseline-approval workflow. Local only."* That was the right call for slice 1 — a CI mode built
before the store, the diff engine and the report existed would have been a guess. All three exist
now, and the missing piece is small and unglamorous: on a pull request, produce the two runs, render
the stored diff into something a reviewer reads in the pull request itself, and keep the evidence
somewhere durable.

This slice does that, and nothing more. It reverses the "no CI mode" non-goal. It does **not**
reverse the other two: there is still no hosted service, and there is still no baseline-approval
workflow — no "accept these changes" button, no stored approvals, no blessed-baseline database.

## 2. Scope

### In

- `vdiff comment <flow> [base] [head]` — render a stored diff as pull-request markdown
- `vdiff export <flow> [base] [head]` — write a portable evidence bundle (images, JSON, static HTML)
- `vdiff install github-actions` — write the workflow files a repository needs, as managed files
- A composite action (`action.yml`) that carries the actual CI behaviour, versioned with the package
- An opt-in gate (`--fail-on none|high|any`, new exit code 3)

### Explicit non-goals

- **No hosted service, no account, no upload of anything to us.** The evidence stays in the user's
  repository, their artifact storage, or a branch they nominate.
- **No baseline approval.** There is no stored "approved" state, so there is nothing to approve
  against. The base side of a pull-request diff is the merge-base revision, computed per run.
- **The CLI never talks to the GitHub API.** No token is passed to `vdiff`, no HTTP client enters
  the package, and no command posts, pushes or deletes anything (D29).
- **No other CI provider.** The rendering commands are provider-neutral markdown and files; only the
  GitHub Actions transport ships here. GitLab, Buildkite and friends can consume `vdiff comment
  --json` today and get a first-class installer later.
- **No inline images without an explicit publish target.** GitHub cannot render an image out of a
  workflow artifact; see D31 for what happens instead.
- **No new capture behaviour.** CI produces runs with the commands that already exist. Nothing about
  `vdiff run` changes.

## 3. Decisions and rationale

Continues the record: slice 1 D1–D9, mocking D10–D14, harness packaging D15–D19, variants D20–D24,
e2e D25–D27.

**D28 — CI produces runs with the existing commands; this slice only renders and transports.**
A pull-request job is `vdiff run <flow> --at <merge-base>`, `vdiff run <flow>`, `vdiff diff <flow>`
— three commands that already work, already lock, already store append-only, already resolve a pair.
The new code renders a stored diff (`comment`, `export`) and the action moves the result to where
people look. Rejected: a single `vdiff ci` command that captures, diffs, renders and posts. It would
duplicate every option of `run` and `diff`, and its failure modes would be indistinguishable from
theirs — a hung dev server would surface as "CI mode failed".

**D29 — Rendering is a pure function of a stored diff, and the CLI stays offline.**
`vdiff comment` reads `findings.json` and writes markdown; `vdiff export` reads the store and writes
files. Neither takes a token, opens a socket, or knows what a pull request is. The URLs a comment
embeds are *inputs* (`--image-base`, `--artifact-url`), supplied by whatever transports the result.
Rejected: `vdiff comment --post`, which is what most tools in this space do. It would put an API
client and a credential in a package whose report server deliberately "never executes anything"
(D6), and it would make the most security-sensitive part of the feature the least testable. The
transport is ten lines of `github-script` in the action, where the token already lives.

**D30 — Findings still do not gate, unless someone asks. The gate gets its own exit code.**
`vdiff diff` exits 0 with findings and keeps doing so. `vdiff comment --fail-on high|any` is an
opt-in evaluation that exits **3**, a new code, rather than reusing 1. Exit 1 means "the run or
replay failed" everywhere else in this CLI, and a UI change that trips a threshold is not a broken
run; collapsing the two would make every consumer's error handling wrong in one direction or the
other. Default is `none`. The workflow input has the same name and the same default, so a green
check on a changed UI is what a repository gets until it decides otherwise.

**D31 — Evidence travels as an artifact bundle. Inline images need a publish target the user names.**
GitHub markdown cannot reference a file inside a workflow artifact — there is no URL for it — so a
comment can carry numbers, tables and links, but not pictures, from artifacts alone. Three ways out
exist and they are not equivalent, so the default is the one that mutates nothing: **always** upload
the bundle as an artifact and link it; embed images **only** when the user nominates a publish
branch (`publish-branch`), in which case the diff images for that pull request are pushed to that
branch and referenced by raw URL. Rejected as the default: pushing images to a branch (it is a write
to their repository, it grows without bound, and it happens on every pull request), and GitHub Pages
(needs Pages enabled, one deployment per pull request, and a public site for what may be a private
UI). Both remain reachable — a nominated branch is supported outright, and the bundle contains a
self-contained `report.html` that a Pages job can publish as-is.

**D32 — Baseline: a stored one if it exists, a replayed merge-base if it does not.**
Replaying the base revision is correct but costs a worktree and a dependency install per pull
request; restoring a baseline captured on the default branch is fast but only exists if a previous
job produced it. The action does both: it restores a baseline keyed on the merge-base SHA, and
replays at that SHA on a miss. A missing baseline is therefore a slower job, never a failed one —
the same posture the store takes when a diff needs a run that does not exist, where "a missing point
is offered as a backfill rather than an error" (§6). `baseline: replay|cache|auto` (default `auto`)
lets a repository pin either half.

**D33 — One comment per flow, updated in place, bounded in size, and honest about what it dropped.**
The comment is identified by an HTML marker (`<!-- vdiff:<flow>:<kind> -->`) and upserted, so a
pull request with fourteen pushes has one visual-diff comment and not fourteen. GitHub rejects a
comment body over 65536 characters, so the renderer caps rows and embedded images and states the
count it omitted (`… 23 more findings — see findings.json in the artifact`). A truncation nobody
mentions is a lie about the size of the change, which is precisely what this feature exists to
prevent.

**D34 — The installed workflow is thin; the behaviour lives in a versioned composite action.**
`vdiff install github-actions` writes a workflow of about forty lines that checks out the repository
and calls `beprajwal/visual-diff@<version>`. Everything else — the browser cache, the baseline
restore, the export, the artifact upload, the comment upsert, the gate — is steps in `action.yml` in
this repository. Rejected: writing the whole pipeline into the user's workflow file, which is how a
bug fix reaches nobody: their file is theirs, it drifts the moment they edit it, and a hundred repos
pin a hundred slightly different pipelines. The written files are managed files with the same stamp
mechanism the skill installer uses, so a re-install refreshes them and a human edit is preserved and
reported (D17, D19), and the stamp is a `#` comment because YAML has no HTML comments.

**D35 — The comment is posted before the gate fails.**
When `fail-on` is set and tripped, the action still uploads the artifact and posts the comment, and
fails at the end. A gate that fails first produces the worst possible artifact of this feature: a red
check with no explanation of what changed.

## 4. What CI adds, and what it does not

A pull-request job produces exactly what a local `vdiff run`/`vdiff diff` pair produces, so
everything the diff engine knows locally it knows here: pixel regions hit-tested against the DOM,
property-level changes, console and network findings, per-viewport ratios, step alignment by id.

Two things are weaker in CI, and the tool says so rather than letting them be discovered:

- **Fonts and rendering differ from a developer's machine.** A baseline captured on a runner and a
  head captured on the same runner image are comparable; a baseline captured locally and a head
  captured in CI are not, and the bundle records `env` from both runs' `meta.json` so a reviewer can
  see when that happened.
- **A replayed merge-base is not the same as a run of the merge-base's own CI.** It replays the base
  revision's code with the base revision's flow spec (D4), which is the intended comparison, but a
  dependency resolved at a different minute can still move a pixel.

## 5. The evidence bundle

`vdiff export <flow> [base] [head] --out <dir>` writes a directory that is complete on its own — it
can be zipped, attached, served by any static host, or opened from a filesystem:

```
<out>/
  summary.json           envelope: flow, pair, summary, labels, both runs' revision + env, generatedAt
  findings.json          the stored DiffResult, verbatim
  comment.md             the rendered markdown, with the image base it was rendered for
  report.html            self-contained static page; relative image paths, no JS framework, no CDN
  images/
    <step>/<viewport>/base.png, head.png, pixel.png
    crops/<findingId>.png
```

Every path inside `report.html` and `comment.md` (when an image base is given) is relative to the
bundle root, so the same bytes work under a raw-branch URL, a Pages deployment, and `file://`.
`--images changed|all|none` bounds the size: `changed` (the default) copies shots for steps that
have findings or a non-zero pixel ratio.

## 6. The comment

One markdown document, in this order, so a reader who stops after two lines has the answer:

1. **Verdict line** — flow, pair, findings by severity, max pixel change, gate state when one is set.
2. **Any pair label** — `cross-scenario`, `mock-vs-recorded`, `e2e-vs-replay`, variant pairings, and
   the degraded-detail sentences for an ingested side. These are the same sentences `vdiff diff`
   prints; a CI reader needs them more than a local one, not less.
3. **Step table** — step, status, viewport, pixel change, findings.
4. **Findings table** — id, severity, kind, where, element, change; capped with a stated remainder.
5. **Images** — base / head / diff per changed step and viewport, only when an image base was given.
6. **Footer** — artifact link, the exact `vdiff` commands to reproduce the pair locally, the version
   that produced it, and the marker comment.

## 7. CLI

```sh
vdiff comment <flow> [base] [head] [--image-base <url>] [--artifact-url <url>]
                                   [--max-findings <n>] [--max-images <n>]
                                   [--fail-on none|high|any] [--out <file>] [--json]
vdiff export  <flow> [base] [head] [--out <dir>] [--images changed|all|none] [--json]
vdiff install github-actions [--dir <path>] [--force] [--dry-run]
```

`comment` and `export` resolve their pair exactly as `diff` does — same defaults, same
`--scenario`/`--variant`/`--e2e` narrowing, same store — because a pair that means one thing in
`vdiff diff` and another in `vdiff comment` would be a trap. Both compute the diff if it is not
stored, and reuse it if it is, again matching `diff`.

Exit codes: `0` success, `1` run or replay failure, `2` config or spec error, `3` gate tripped
(`comment --fail-on` only).

`install github-actions` is project-scope only: `.github/workflows` has no user-level equivalent, so
`--global` is a config error naming the reason rather than a directory invented under `$HOME`.

## 8. The action

`beprajwal/visual-diff@<version>` — a composite action. Inputs, with defaults:

| input | default | meaning |
| --- | --- | --- |
| `flows` | *(all flows)* | whitespace-separated flow names |
| `base-ref` | the pull request's merge-base | revision the base side is taken at |
| `baseline` | `auto` | `auto` \| `cache` \| `replay` (D32) |
| `fail-on` | `none` | `none` \| `high` \| `any` (D30) |
| `comment` | `true` | post/update the pull-request comment |
| `artifact` | `true` | upload the evidence bundle |
| `artifact-name` | `visual-diff` | artifact name |
| `publish-branch` | *(empty)* | branch to push diff images to, enabling inline images (D31) |
| `node-version` | `20` | Node used to run `vdiff` |
| `version` | *(the action's own version)* | `@beprajwal/visual-diff` version installed |
| `working-directory` | `.` | directory holding `.visual-diff/` |
| `github-token` | `${{ github.token }}` | used only by the comment and publish steps |

Outputs: `findings`, `high`, `changed-steps`, `gate`, `bundle-dir`, `comment-file`, `artifact-name`.

Required permissions: `contents: read` always, `pull-requests: write` for the comment, and
`contents: write` only when `publish-branch` is set — stated in the installed workflow, because a
missing permission surfaces as a 403 inside a step that looks like ours.

## 9. Failure modes, and what each one does

| situation | behaviour |
| --- | --- |
| base SHA not present in the shallow clone | fetched at depth 1 before use; a failed fetch is exit 2 with the SHA named |
| baseline cache miss, `baseline: cache` | exit 2 naming the key — the repository asked for cache-only |
| baseline cache miss, `auto` | replay at the merge-base, with a log line saying why the job got slower |
| head run partial or failed | the diff still runs; the comment carries the failed steps, and the job fails (exit 1) |
| no flows found | exit 2 naming `.visual-diff/flows` |
| comment over the size limit | truncated with a stated remainder (D33) |
| `pull-requests: write` missing | the comment step fails with the permission named; artifact still uploaded |
| not a pull request event | comment step skipped, everything else runs — the bundle is still produced |

## 10. Testing

- Golden tests for the markdown renderer: no findings, findings capped, images with and without an
  image base, every pair label, a partial head run, gate tripped and not.
- Bundle tests against a fixture store: file inventory, relative paths only, `--images` modes,
  `report.html` referencing files that exist.
- Installer tests: created / unchanged / preserved / `--force` / `--dry-run` on both workflow files,
  YAML-comment stamp round-trip, `--global` refused.
- A drift test parsing `action.yml` and the installed workflow together, asserting every input the
  workflow passes is an input the action declares — the failure mode D34 trades for is a workflow
  and an action that disagree, and it must be a test rather than a review.
- Gate tests: exit 3 only when tripped, exit 0 for `none` at every finding count.

## 11. Roadmap position

Subsystem 5 of five. It closes the loop the report opened: slice 1 made a diff a human could review
locally, mocking and variants made the runs worth comparing, e2e mode let an existing suite feed the
store, and this puts the result where the review already happens. What it deliberately leaves for
later is the half of "CI mode" this slice refuses to guess at: an approval state that makes a
findings count meaningful as a gate, and a hosted place for the evidence to live.
