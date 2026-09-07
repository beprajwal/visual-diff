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

**D36 — `--html linked|inline|both` controls how the page addresses its images.**
`linked` (the default) is the original shape: `report.html` points at `images/` with relative paths,
smallest bundle, opens anywhere the directory travels whole. `inline` embeds every shown image as a
`data:` URI, so the one file is the whole report — the shape for hosts that take single objects (a
worker with an object store, a gist, an email) and for the workflow-artifact zip, where GitHub serves
nothing as HTML anyway. `both` writes the linked page plus `report.inline.html` beside it. Only the
page changes: `images/`, `comment.md` and the JSON are identical in every mode, and the inline page
embeds exactly the shots `--images` selected — no more. Rejected: making `inline` the default, which
would grow every bundle by a third (base64) to serve a case most workflows do not have.

**D38 — `report.html` is the live report's UI over an embedded snapshot.**
The bundle's page used to be a hand-rendered no-JS subset; reviewers got a different (and poorer)
tool depending on where they opened the diff. Now `vdiff export` inlines the same Preact app
`vdiff serve` mounts — filmstrip, side-by-side, overlay, swipe, keyboard — plus a JSON snapshot of
the one exported pair, into a single file with no external request of any kind. An `ApiClient`
implemented over the snapshot replaces fetch + SSE; feedback refuses with a sentence pointing at
`vdiff serve`, and only the exported pair is answerable. `--html linked|inline` keeps its meaning —
it decides whether the snapshot's image map holds relative paths into `images/` or `data:` URIs.
Attribution annotations are not embedded (they live outside the DiffResult); the page renders
without them exactly as the live report does when that fetch fails. A `<noscript>` block and
`findings.json` remain the no-JS story. Rejected: keeping both renderers — two pages drift, and the
static one always loses.

**D37 — the comment shows the change, not the findings list.**
The finding rows duplicated what the images already say, in the least readable form the comment had,
and they crowded the images out of the byte budget. Dropped: the findings table and `--max-findings`.
Kept: every number — the verdict line's severity counts, a findings-by-severity phrase in each image
group's heading, and the per-step counts in the collapsed steps table. The full rows still ship in
`findings.json` and render in the report page, which is where triage that needs ids and selectors
happens anyway. Shrink order flips accordingly: the steps table is dropped before an image, because
the images are now the comment's answer.

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
  report.html            the interactive report over an embedded snapshot (D38); inline JS, no CDN
  report.inline.html     under --html both: the same page with its images embedded (D36)
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
3. **What changed** — base / head / diff images per changed step and viewport, only when an image
   base was given. This is the comment's answer (D37): each group's heading carries the pixel ratio
   and a findings-by-severity phrase. There is no findings table — a reviewer triages from the
   pictures and the counts, and the full rows live in `findings.json` and the report page.
4. **Step table** — step, status, viewport, pixel change, findings; collapsed.
5. **Footer** — artifact link, the exact `vdiff` commands to reproduce the pair locally, the version
   that produced it, and the marker comment.

## 7. CLI

```sh
vdiff comment <flow> [base] [head] [--image-base <url>] [--artifact-url <url>]
                                   [--max-images <n>] [--report-url <url>]
                                   [--fail-on none|high|any] [--out <file>] [--json]
vdiff export  <flow> [base] [head] [--out <dir>] [--images changed|all|none] [--json]
vdiff review  <flow> [base] [head] [--provider anthropic|openai] [--model <id>] [--shots <n>]
                                   [--context <file>] [--out <file>] [--json]          (D39)
vdiff install github-actions [--dir <path>] [--force] [--dry-run]
```

`review` resolves its pair the same way, then asks the model whose API key the environment holds
(`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) to read the diff, and stores `review.json` beside
`findings.json`. `comment` and `export` pick a stored review up without a flag. No key is exit 2; a
provider failure is exit 1.

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
| `pages-url` | *(empty)* | URL GitHub Pages serves `publish-branch` at; with it, the comment links `report.html` as a page (D40) |
| `anthropic-api-key` | *(empty)* | a model writes the review the comment opens with; reaches the review step only (D39) |
| `openai-api-key` | *(empty)* | the same, via OpenAI; Anthropic wins when both are set (D39) |
| `review-model` | *(provider default)* | model id for the review |
| `html` | `linked` | `linked` \| `inline` \| `both` — how the bundle's page addresses its images (D36) |
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

## 12. Addendum (2026-09-07): a model in the reviewer's seat, and the report as a page

Two decisions added after v0.8.0. Both are opt-in, both leave the defaults exactly as §3 describes
them, and both were shaped by what turned out *not* to be possible.

**What was asked for, and why it is not what shipped.** The request was to use an Anthropic or
OpenAI API key in CI to publish the report the way the `visual-diff-report` skill does interactively —
as a Claude artifact, or a ChatGPT Site. Neither has a programmatic path: Claude Code's artifact
publishing requires a claude.ai session (an API-key session cannot publish, and artifacts are off by
default in GitHub Action contexts), and ChatGPT Sites deploys only from the ChatGPT app, with no API,
no CLI command and no `OPENAI_API_KEY` route. Those are the vendors' constraints, not ours, and the
skill already says so. What an API key *can* do in CI is the one thing CI mode was missing.

**D39 — With an API key present, a model writes the review; the CLI renders it, the action carries it.**
Step 4 of the agent loop — "summarize the findings; call out anything you did not intend" — had no
author in CI, so the comment was numbers. `vdiff review` puts a model in that seat: it sends the
findings (paths and environments stripped, findings capped and the cap stated — D33's rule), the
screenshots for the most important changed cells (worst finding first, then pixel movement; base,
head, pixel diff and crops, each labelled), and — from the action, always — the pull request's title
and body. The answer is a JSON schema both providers enforce strictly: a **headline** (the one change
a ten-second reader must know), a summary, every change ranked and assessed `expected` /
`unrelated` / `regression` / `unclear`, and **concerns**. `unrelated` is the point: a real change the
description does not account for is the thing that should not have moved and did, and the comment
opens with a warning block counting them. The provider is whichever key the environment holds
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`; Anthropic when both), the model defaults to each provider's
flagship and is overridable, and the call is one request over `fetch` — no SDK dependency for an
optional feature an `npx` user may never touch, and `fetch` is injected in tests so the exact request
shapes are pinned without a socket.

What it deliberately is not: it is not a gate (`--fail-on` still counts findings), it is not an agent
(one request, no tools, no retries that could double a bill), and it is not anonymous — `review.json`
records provider, model and what the model was shown, and every rendering carries that line. It is
stored beside `findings.json` under the same engine-version rule, so a review of a recomputed diff
reads as absent; `comment` and `export` pick it up without a flag, the bundle carries `review.json`,
and the page's snapshot renders it in its banner. Rejected: running a Claude Code or Codex agent in
the action to do the same (heavier, slower, and still unable to publish); a flag on `comment` that
calls the model at render time (two renderers, two bills, two possibly different reviews).

This amends D29's "no HTTP client enters the package" in exactly one respect: `vdiff review` opens a
socket to the model API the caller's key belongs to. The CLI still never talks to GitHub, and the
action hands the model key to exactly one step — the drift test pins both.

**D40 — The report becomes a site where the user already serves one.**
D31 rejected GitHub Pages as a *default*; it remains right. But a repository that has nominated a
`publish-branch` already has every pull request's `report.html` and images on a branch, and Pages
can serve a branch. `pages-url` names the URL it does, and the action derives this pull request's
prefix under it and passes `--report-url` to `comment`, so the "Open the full report" call to action
opens the interactive page. Visibility is the repository's Pages setting — private to the
organisation on Enterprise Cloud, public otherwise — which is the honest answer to "who can see it":
the same people who can see the branch. No deploy action is used, because `actions/deploy-pages`
replaces the whole site per run and would leave one pull request's report standing at a time.

**The comment wears the mark.** Its heading now carries the product logo (served from this
repository's `main`) and the name, so a pull request with several bots on it says whose comment this
is before a number is read. The bundle's own `comment.md` is the one place an external URL now
appears; the page and the images remain fully in-bundle, and the test that guarded that was made
precise rather than removed.

**D41 — A run can be told where the app is, without editing a committed file.**
A repository's `config.yaml` names the origin its developers use — behind a local proxy, on a
`.lvh.me` host, whatever their stack wants. CI fronts the same app on a different origin (a TLS
proxy that makes it same-site with a real auth domain, say), and a historical replay reads its flow
from git, so no edit to the working tree can reach the base side. `vdiff run` therefore takes
`--base-url` and `--ready-on` — and, because the composite action calls it with no flags, reads
`VDIFF_BASE_URL` and `VDIFF_READY_ON` from the environment as the fallback. Flag over environment
over file. `browser.ignoreHTTPSErrors` (config) and `VDIFF_IGNORE_HTTPS_ERRORS` (environment) accept
the proxy's self-signed certificate, in the browser and in the readiness probe alike — the probe
moved off `fetch` for exactly that, since `fetch` cannot relax TLS for one request without a
process-wide switch. Rejected: `${VAR}` templating inside `baseUrl` and `readyOn`, because it would
change the spec's hash, could not reach a flow already in history, and would collide with the
`$PORT` placeholder and the `${VAR}` fill values that already mean something else.

**D42 — The recordings travel with the baseline.**
HARs are gitignored on purpose (they are large and they are data), so a CI runner starts with none
and a first run records against a live backend on both sides — correct, but exposed to backend
drift between the two replays. The baseline cache now carries `.visual-diff/flows/*.har` beside
`.visual-diff/runs`, under the same key: a baseline job records once, and a pull request that
restores it replays the same traffic for its base and its head. A miss still records and still
works; it is slower and noisier, never failed — the D32 posture, extended to the recording.

**D43 — The review can run keyless: the runner's own identity, exchanged for a short-lived token.**
A repository secret holding an Anthropic key is the thing Workload Identity Federation exists to
remove, and a CI job is its canonical case. `vdiff review` now accepts Anthropic's three credentials
in the SDK's own precedence — `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN` (a bearer, which is
what a federated `sk-ant-oat01-…` token is), then the federation variables
(`ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`,
`ANTHROPIC_IDENTITY_TOKEN[_FILE]`, optional `ANTHROPIC_WORKSPACE_ID`) from which it mints the
bearer itself with the RFC 7523 `jwt-bearer` grant at `/v1/oauth/token`. The action takes the
federation ids as inputs (`anthropic-federation-rule-id` and friends), requests the GitHub OIDC
token with audience `https://api.anthropic.com`, exchanges it **once** in its own step, masks the
result and hands it to the review step as `ANTHROPIC_AUTH_TOKEN`. Once, because a GitHub identity
token carries `jti` and is single-use: a job reviewing three flows would otherwise fail on the
second exchange with `jti_reused`. The workflow needs `id-token: write`; the installed template says
so. The OpenAI path is unchanged — it has no federation to speak of. The key still wins when both are
configured, so a repository can migrate the way the WIF docs describe: set up federation beside the
key, then delete the key.
