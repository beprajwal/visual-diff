# Visual Diff

Verify UI you just built by replaying it, not by reading it. `vdiff` replays a recorded workflow
against the current code, compares it to a previous iteration, and publishes an annotated report.

Use this skill after changing anything a user can see: a component, a layout, a style, a route, a
piece of copy. Use it before claiming a UI change works.

Every command accepts `--json`. Pass it whenever you intend to read the result — parse the envelope,
never scrape the human table.

## The loop

```
1. does a flow cover the feature?   → if not, author one (see visual-diff-flows)
2. vdiff run <flow> --json          → capture this iteration
3. vdiff diff <flow> --json         → what changed vs the previous run
4. summarize the findings in chat   → the tool emits data; you write the sentence
5. vdiff serve --json               → hand the user the report URL
```

## Step 1 — find or author the flow

```bash
vdiff flow check <name> --json     # validates a spec without running it
```

Flows live in `.visual-diff/flows/<name>.yaml` and are committed to git. One flow per user-facing
workflow, not per component. If the feature you changed is covered by an existing flow, reuse it —
adding a second flow over the same screens splits the timeline and halves the signal.

If no flow covers it, load the **visual-diff-flows** skill and author one. Do not hand-write a spec
from memory; the step vocabulary is closed and the validator is strict.

## Step 2 — capture

```bash
vdiff run <flow> --json                     # working tree, attaches to a running dev server
vdiff run <flow> --at <ref> --json          # historical revision: worktree + install + spawn (slow)
vdiff run <flow> --viewport 1280x800 --json # subset of the flow's viewports
```

The fast path attaches to a dev server the user is already running: with no `--at`, `vdiff` probes
`config.app.readyOn` and reuses whatever answers. If nothing answers, it starts one from
`config.app.dev` and the run is recorded as `spawn` mode instead of `attach`. The first run of a flow
records network traffic to a HAR; later runs replay it, so diffs isolate code change rather than
backend drift.

A run appends to the timeline — it never overwrites. Ten WIP runs on the same dirty commit are ten
distinguishable iterations: the revision carries a hash of the working-tree diff, not just the SHA.

## Step 3 — diff

```bash
vdiff diff <flow> --json             # defaults to previous run vs newest
vdiff diff <flow> 0003 0007 --json   # any two runs
```

`findings.json` gives you, per step per viewport: changed regions, the element responsible for each,
and the property-level change. Read the structured output. Do not infer what changed from the
screenshots alone.

**`vdiff diff` exits 0 even when findings exist.** Findings are information, not a gate. A non-empty
result is the normal case after a UI change — it does not mean something is broken.

## Step 4 — summarize

This is your job, not the tool's. `vdiff` deliberately ships no model and no API key: it emits
structured findings, and you turn them into a sentence, because you know *why* the change was made.

Good: "The Pay button label changed to 'Pay now' and grew 26px, and a trust badge now sits below it —
both intended. Step 3 also shifted the heading colour, which I did not intend."

Bad: "3 findings in step 2."

Call out anything you did **not** intend. An unexplained finding is the entire point of the tool.

## Step 5 — hand over the report

```bash
vdiff serve --json          # add --open to launch a browser, --port <n> to pin the port
```

The report is a live local page: filmstrip of the workflow, side-by-side per step, annotations docked
right. It follows new runs automatically, so the user can leave it open while you keep working.

`vdiff serve` prints the URL and then **blocks until interrupted** — it is a server, not a one-shot
command. Start it in the background, or hand over the URL and leave it running rather than
restarting it after every iteration.

Tell the user the URL. Then load **visual-diff-review** to pull back whatever they comment on.

## Reading run status

A run's `status` is one of three values:

| status | meaning |
|---|---|
| `ok` | every step ran |
| `partial` | a step failed; downstream steps are `blocked` |
| `failed` | the run never got far enough to produce steps — see `failure.kind` |

`unstable` is a separate boolean on the run, not a status: it is set when git state moved mid-run in
attach mode, and it shows up in the `FLAGS` column of `vdiff runs`. Re-run before trusting a run
flagged `unstable`.

Step status is `ok`, `failed`, `blocked` or `skipped`. A step that fails takes everything after it
with it — the rest come back `blocked`, because a flow is stateful and their preconditions no longer
hold. `--continue-on-error` keeps going instead of blocking the tail; use it only when the tail does
not depend on what failed.

A `partial` run is still worth diffing: a step that stopped working *is* a finding, and the report
renders it as a red cell rather than hiding it.

## Warnings that matter

Run warnings arrive on the `run` envelope, each with a `kind`:

- **`har-miss`** — a request had no recorded response and was aborted. The screen may be missing
  data. Re-record with `vdiff run <flow> --record` if the app legitimately changed its network calls.
- **`settle-timeout`** — the page still had requests in flight when captured. Treat that step's
  findings as unreliable.
- **`unstable-git`** — the tree moved between run start and run end. Re-run.
- **`console-error`**, **`dom-truncated`**, **`step-blocked`** — a console error was seen, the DOM
  snapshot hit its node cap, or a step was skipped because an earlier one failed.

`diff` carries its own warnings, as plain strings. The one that bites: a `diff.ignore` entry in
`config.yaml` that the matcher cannot evaluate is reported as *not supported and matches nothing* —
only simple compound selectors (tag, `#id`, `.class`, `[attr=value]`, and comma-separated lists of
those) are understood. Fix the rule; a silently dead ignore makes you read noise as regression.

## Exit codes

`0` success · `1` run or replay failure · `2` config or spec error · `3` an opt-in gate tripped

On `2`, the error names the file, line, and offending key. Fix the spec; do not retry the command.
Exit `3` is reachable only from `vdiff comment --fail-on high|any`, which nothing sets by default.

## Handing a diff to a pull request

Two commands turn a stored diff into something a reviewer reads without your terminal:

```sh
vdiff comment <flow> [base] [head]   # the diff as pull-request markdown, on stdout or --out <file>
vdiff export  <flow> [base] [head]   # a portable bundle: findings.json, comment.md, report.html, images
```

Both resolve the same pair `vdiff diff` does, and both only render — neither posts, pushes, or
uploads anything, and neither takes a credential. Useful facts when you use them:

- **No `--image-base`, no screenshots.** A comment can only embed an image that already has a URL, so
  without one it carries the tables and links to the bundle. That is expected, not a failure.
- **`--out <file>`** is how you hand the body to something else without passing kilobytes of markdown
  through a shell, where a backtick in a selector becomes a command substitution.
- **`vdiff export --images changed|all|none`** bounds the bundle. `changed` is the default: the shots
  that moved. `report.html` in the bundle is a static page that opens from disk with no server.
- The comment is capped to fit a pull-request body and *states* what it dropped. If you need the
  whole set, read `findings.json` from the bundle rather than the comment.

For GitHub specifically, `vdiff install github-actions` writes the two workflow files that do all of
the above on every pull request. Do not hand-roll a workflow that shells out to these commands unless
the user asks for it.

## What this skill is not for

- Wireframing or exploring UI that is not in the repo yet
- Running the project's e2e suite
- Deciding *whether* visual change should block a merge

The first two are separate concerns and not supported. The third is the user's call: findings never
gate unless someone sets `--fail-on`.
