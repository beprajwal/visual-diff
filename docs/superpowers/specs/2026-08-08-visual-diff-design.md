# Visual Diff — Design (Slice 1: capture, store, diff, live report)

Date: 2026-08-08
Status: Approved for planning

## 1. Problem

A coding agent changes UI. Verifying the result means reading code, or manually starting the app,
clicking to the right screen, and remembering what it looked like before. Nothing captures the
workflow, nothing compares iterations, and nothing tells you *what* changed rather than *that*
something changed.

This tool replays an agent-authored workflow against one or more revisions of a frontend, captures
full evidence per step, computes annotated visual and semantic diffs between any two runs, and
serves a live local report where a human reviews changes and leaves feedback the agent reads back.

## 2. Scope

### The larger product (not all in this spec)

The eventual product is six subsystems:

1. Harness packaging — Claude Code, Codex, opencode, pi; `npx` installer
2. Static render with API mocking — render an isolated feature with faked network
3. Wireframe / ideation mode — render UI that is not in the repo
4. E2E mode — drive the project's existing e2e suite, explicitly opt-in
5. Diff engine — screen and workflow level, across N iterations
6. Live report — local HTML, side-by-side, annotated, connected to the agent session

**This spec covers 5 and 6, plus the minimum capture needed to feed them.** They are the center of
gravity: render modes and packaging are plumbing around the diff. Each remaining subsystem gets its
own spec → plan → implementation cycle.

### Explicit non-goals for slice 1

- **No mock authoring.** HAR record/replay exists only to freeze the network for deterministic
  replay. No fixture DSL, no scenario editor. (→ subsystem 2)
- **No wireframe mode.** Nothing renders that is not in the repository. (→ subsystem 3)
- **No e2e suite integration.** Playwright/Cypress/Cucumber suites are not read. (→ subsystem 4)
- **No multi-harness packaging.** Claude Code only, via a skill plus slash commands that shell out
  to the CLI. The CLI is harness-agnostic so later adapters stay thin. (→ subsystem 1)
- **No CI mode, hosted reports, or baseline-approval workflow.** Local only.
- **No cross-browser.** Chromium only.

### Accepted limitation

Without subsystem 2, determinism comes from replaying *recorded* traffic. The first recording still
requires a working backend. Frontend-only apps and apps with a seeded local dev backend work on day
one; apps requiring live auth against a remote service will be rough until mocking lands. This is
accepted rather than pulling mock authoring forward into this slice.

## 3. Vocabulary

Used consistently across code, storage, CLI output, and report UI.

| Term | Meaning |
|---|---|
| **flow** | Named YAML spec of a workflow: steps, viewports, base URL |
| **step** | One addressable point in a flow, identified by a stable author-assigned `id` |
| **shot** | One captured artifact bundle for one step at one viewport |
| **run** | One full replay of one flow at one revision → N shots plus metadata |
| **revision** | What was replayed: a git SHA, or the dirty working tree |
| **pair** | Two runs selected for comparison |
| **finding** | One annotated change within a pair, scoped to a step and an element |

## 4. Decisions and rationale

Nine decisions fix the design. Each records the rejected alternative, because the rejections are
what keep later work from silently re-litigating them.

**D1 — Slice 1 is capture → store → diff → live report.**
The diff and the report are the product. If an annotated side-by-side in a live local page is not
compelling, no amount of render-mode sophistication rescues it.

**D2 — Flows are agent-authored specs, replayed headless.**
Rejected: agent shooting screenshots ad hoc as it drives a browser. That cannot replay a past
iteration's workflow against present code, which is precisely what "diff across iterations"
requires. Rejected: auto route enumeration — no interaction, no workflow, and it captures the whole
app instead of the feature under work.

**D3 — Git-anchored replay *and* an append-only run store.**
Every `vdiff run` appends a run. `vdiff run --at <ref>` materializes a worktree, rebuilds, replays,
and appends the result as a backfill. Any two runs in the store are comparable; a missing point is
offered as a backfill rather than an error.

**D4 — Each revision replays with its contemporaneous flow spec.**
Flow files are read out of git history at the target SHA. Rejected: always using the current spec,
which turns every selector rename into a step failure.
**This is only safe because of stable step ids** — the diff aligns runs by `id`, never by index, so
steps that exist in one flow version and not the other render as added/removed rows instead of
silently comparing unrelated screens. Step ids are load-bearing for D4, not a convenience.

**D5 — Layered diff: pixels for *where*, DOM for *what*.**
Pixel diff finds changed regions; regions are hit-tested against the DOM snapshot to name the
responsible element; those elements are tree-diffed for the specific change. Rejected: pixel-only
(annotations are geometric, meaningless) and DOM-only (misses canvas, images, background rendering,
and reports changes with no visual effect).

**D6 — Two-way report: live push out, feedback in.**
The page receives updates over SSE and can append structured feedback that the agent reads.
Rejected: one-way push (a screenshot viewer, not a tool) and full RPC (a local web page that can
execute the build system, requiring an auth story nobody wants).
**The page never executes anything** — it appends JSON to a file; an agent decides what to do with
it. Feedback delivery is pull-based (`vdiff feedback`) since that is the only mechanism all four
target harnesses share; hook-based push is a per-harness bonus in subsystem 1.

**D7 — Report shell is a filmstrip plus a focused pair.**
Timeline of steps with change badges across the top, one step's before/after in detail below,
annotations docked right. Onion-skin/scrubber and swipe are view modes inside this shell rather than
a separate layout. Rejected as default: stacked diff-file rows (too little pixel area per screen)
and scrubber-first (weakest for seeing a whole workflow at a glance).

**D8 — Flow specs are declarative YAML with a closed step vocabulary.**
Because specs are data, two flow versions can be diffed *structurally* without executing either —
which is what renders "step added" and "step drifted" rows. Rejected: TS/JS flow modules, where the
step list is only knowable by execution, so an early throw loses the whole tail and structural drift
reporting degrades to guesswork. A flow that outgrows the vocabulary can graduate to a code flow in
a later slice.

**D9 — Spawn per revision, with HAR record/replay.**
Rejected: attach-only (cannot serve an old SHA, killing D3) and spawn with a live backend (every
diff polluted by current backend data). HAR freezes the network so diffs isolate code change. This
layer is also the foundation of subsystem 2, so slice 1 pays for slice 2.

## 5. Architecture

One npm package, `visual-diff`, one binary, `vdiff`, with hard internal module seams.

```
flow/      parse and validate YAML; structural diff of two flow versions
runner/    worktree + dep cache; serve (attach|spawn); Playwright driver; HAR
store/     run directories, metadata, retention, pair resolution
diff/      pixel regions, DOM attribution, tree diff, annotation model
report/    prebuilt UI bundle, local server, SSE push, feedback sink
adapters/  per-harness install (writes skill and command files that call vdiff).
           Slice 1 contains exactly one adapter, for Claude Code; the module exists
           so later harnesses drop in without restructuring.
```

Rejected: a four-package monorepo (publishing overhead before the boundaries are known to be
correct) and MCP-server-first (uneven MCP support across the four target harnesses, a harder install
story than one `npx` line, and tool schemas designed before the CLI surface stabilizes). MCP becomes
an adapter once `vdiff`'s commands stop moving.

Every module exposes a JSON contract at its edge, so extracting packages later is mechanical.
The on-disk store *is* the interface between modules — this is what makes the seams real rather than
notional.

### Data flow

```
flow spec ──► runner ──► run dir (shots + meta) ──┐
                                                  ├──► diff ──► findings.json ──► report ──► browser
flow spec @ base SHA ──► runner ──► run dir ──────┘                                   │
                                                                                      ▼
                                                              feedback/pending.jsonl ──► agent
```

## 6. Data model

Everything is files. No database, no persistent daemon state.

```
.visual-diff/
  config.yaml                    committed — project-level settings
  flows/
    checkout.yaml                committed — flow spec, source of truth
    checkout.har                 committed — frozen network, scrubbed
  runs/
    checkout/
      0007/
        meta.json
        flow.snapshot.yaml       exact spec this run executed
        steps/
          pay-form/              directory named by step id, never by ordinal
            step.json            status, timings, resolved selector, failure
            1280x800/{screenshot.png, dom.json, a11y.json}
            390x844/{screenshot.png, dom.json, a11y.json}
            console.json
            network.json         requests, plus HAR match/miss per request
  diffs/
    checkout/0003..0007/
      findings.json
      crops/f1.png
      steps/pay-form/1280x800/{pixel.png, regions.json}
  feedback/
    pending.jsonl
    archive/2026-08-08.jsonl
  cache/
    deps/<lockfile-sha>/         shared node_modules per lockfile
    worktrees/<sha>/             ephemeral detached checkouts, reaped
  .locks/<flow>.lock
```

**Step directories are keyed by `id`, not by ordinal.** Inserting a step must not rename every
directory after it, which would make every historical run appear changed. Ordering lives only in
`flow.snapshot.yaml`.

### `meta.json`

```json
{
  "runId": "0007", "flow": "checkout", "flowHash": "sha256:...",
  "revision": { "sha": "9f8e7d6", "ref": "feat/pay", "dirty": true,
                "dirtyHash": "sha256:..." },
  "mode": "attach", "network": "replay", "harHits": 41, "harMisses": 2,
  "viewports": ["1280x800", "390x844"],
  "status": "partial", "failedSteps": ["pay-click"],
  "env": { "tool": "0.1.0", "playwright": "1.5x", "chromium": "...",
           "os": "darwin-arm64", "deviceScaleFactor": 2 },
  "startedAt": "2026-08-08T10:00:00Z", "finishedAt": "2026-08-08T10:00:41Z"
}
```

`dirtyHash` hashes `git diff HEAD` plus the untracked file list. Without it, ten consecutive WIP runs
are all "9f8e7d6 dirty" and indistinguishable — which destroys the ability to tell iteration 3 from
iteration 4, the core use case.

### Flow spec, version 1

```yaml
version: 1
flow: checkout
baseUrl: http://localhost:5173      # overridable by config and CLI
viewports: [1280x800, 390x844]
network: { mode: replay, har: checkout.har }
steps:
  - id: cart
    goto: /cart
    waitFor: "[data-test=cart-list]"
    mask: ["[data-test=order-date]"]
    shoot: true
  - id: pay-form
    click: "[data-test=pay]"
    waitFor: "text=Payment"
    shoot: true
  - id: fill-card
    fill: { "[name=card]": "4242424242424242" }
    shoot: false
```

Closed step vocabulary: `goto click fill press hover scroll waitFor viewport mask shoot expect`.
There is no fixed `sleep`; the validator rejects it, because a sleep is how a half-rendered frame
gets captured. `mask` is required functionality, not polish — clocks, order ids, and relative
timestamps otherwise produce a finding on every run and destroy the signal.

### Configuration

```yaml
# .visual-diff/config.yaml
app:
  install: pnpm install --frozen-lockfile
  dev:     pnpm dev --port $PORT
  readyOn: http://localhost:$PORT/
  readyTimeout: 90s
diff:
  minRegionArea: 64
  maxRegions: 40
  antialiasTolerance: 0.1
  ignore: ["[data-test=session-id]"]
network:
  redact: ["x-api-key"]
retention:
  keepRuns: 20
```

### Git boundary

`flows/` and `config.yaml` **must** be committed — D4 reads flow files out of git history, so an
uncommitted flow has nothing to read at a historical SHA. Runs, diffs, cache, and feedback are
ignored.

```gitignore
.visual-diff/*
!.visual-diff/config.yaml
!.visual-diff/flows/
```

HAR files are committed for cross-machine determinism, and are scrubbed on record: `Authorization`,
`Cookie`, and `Set-Cookie` are dropped, along with any header or field in `network.redact`. Writing
an unscrubbed HAR requires an explicit `--no-scrub`.

### Retention

Keep the last 20 runs per flow. Pruning deletes blobs but preserves `meta.json` and
`flow.snapshot.yaml` permanently, so the timeline stays intact and a pruned point remains
backfillable by replay. `vdiff pin <run>` exempts a run; runs referenced by a stored diff are never
pruned.

## 7. Runner

### Two paths, chosen automatically

**Fast path (attach)** — target is HEAD or the dirty working tree. Probe `readyOn`; if the user's dev
server is up, drive it directly. No worktree, no install, no build. This is the common case and must
feel instant.

**Slow path (spawn)** — target is a historical ref. Materialize `cache/worktrees/<sha>` with
`git worktree add --detach`, symlink `node_modules` from `cache/deps/<lockfile-sha>` (installing only
on cache miss), read the flow spec from that revision via
`git show <sha>:.visual-diff/flows/<flow>.yaml`, run the configured `dev` command on an allocated
port, poll `readyOn` until healthy, replay, then tear down the worktree while keeping the dep cache.

### Determinism

Applied to every browser context. These are not polish: without them, every run produces findings and
the tool is worthless.

- Fixed viewport and `deviceScaleFactor: 2`, headless Chromium
- Injected `*{animation:none!important;transition:none!important;caret-color:transparent!important}`
  and `prefers-reduced-motion: reduce`
- `TZ=UTC`, locale `en-US`, clock frozen to a fixed epoch, `Math.random` seeded — via an init script
  that runs before any application code
- Overlay scrollbars disabled, so scrollbar width never shifts layout
- Pre-shoot settle gate: `document.fonts.ready`, two idle animation frames, and no in-flight
  HAR-served requests. Not a timer.
- `mask` selectors painted over before capture

### Capture

Per step, per viewport, in one pass: full-page `screenshot.png`; `dom.json` containing visible nodes
with stable path, tag, role, accessible name, text, bounding rect, and a **fixed subset** of computed
styles (color, background, font, border, radius, shadow, display, position, opacity, z-index, box
spacing); `a11y.json` from the accessibility snapshot; and `console.json` plus `network.json` for the
step's time window. The style subset is a closed list deliberately — snapshotting all computed styles
is enormous and almost none of it ever changes.

Viewports are independent full replays in separate browser contexts, run concurrently up to a worker
cap. Reusing one context across viewports carries scroll position, focus, and storage, making mobile
results depend on desktop having run first.

### Network

The first run of a flow records via `recordHar`. Later runs serve via `routeFromHAR` with
`notFound: 'abort'`. Aborts are recorded as HAR misses in `network.json` and surfaced as a run-level
warning listing the offending URLs. Silent fallthrough to the live network is the failure mode that
quietly destroys determinism, so it is never allowed.

### Step failure

Steps are stateful and sequential, so a failure invalidates everything downstream. On failure: record
the error, the DOM at failure, and a screenshot; mark remaining steps `skipped(blocked)`; set run
`status: partial`. The report still renders a full rectangular grid with explicit blocked cells
rather than a truncated flow. `--continue-on-error` re-anchors at the next `goto` step for cases
where the tail is independent.

### Two guards

Attach mode trusts a dev server that may be mid-HMR or serving stale code, so git state is captured
at run start and end; if it moved, the run is flagged `unstable` with a re-run suggestion.

The dep cache is keyed by lockfile hash, so a revision whose lockfile matches an existing entry
installs nothing. A revision with an unresolvable lockfile fails the run cleanly, with its install
log retained, rather than replaying against wrong dependency versions.

## 8. Diff engine

A pure function: two run directories in, one `findings.json` out. No network, no browser. Cached by
`(baseRunId, headRunId, engineVersion)`, so reopening the report never recomputes.

**Stage 1 — structural flow diff.** Align both `flow.snapshot.yaml` files by step `id`. Every step
lands in exactly one bucket: `matched`, `added`, `removed`, `spec-changed` (same id, different
selector or action — the D4 drift signal), `failed`, `blocked`. Runs before any pixel work.

**Stage 2 — pixel diff**, per matched step per viewport. Perceptual comparison with antialias
tolerance and a YIQ threshold. Differing image dimensions become a finding in their own right (the
page grew or shrank), after which comparison proceeds on the common area rather than reporting 100%
changed. Output is a change mask.

**Stage 3 — region clustering.** Connected components over the mask, merged by proximity, emitted as
rectangles sorted by area. Regions below `minRegionArea` are dropped, masked regions are excluded,
and the count is capped at `maxRegions`, with the remainder collapsed into a single "N smaller
changes" entry. Uncapped, a font-metric shift produces hundreds of boxes and the report becomes
unreadable.

**Stage 4 — DOM attribution.** For each region, hit-test `dom.json` on both sides. Select the
smallest node fully containing the region, preferring nodes whose own rect changed. This is the step
that turns "pixels at 340,220" into "the Pay button".

**Stage 5 — node diff.** Match nodes across sides by a stable key (test-id, then role plus accessible
name, then DOM path), then classify as `added`, `removed`, `moved` (rect delta), `resized`, `text`,
`style` (per property), or `attr`. Merge with the region to emit findings.

### Finding kinds and severity

Kinds: `content`, `style`, `layout`, `structural`, `a11y`, `console`, `network`.

Severity is heuristic, not learned. High: a lost accessible name, a new console error, a contrast
ratio dropping below 4.5, a layout shift past threshold. Low: a 1px radius change. **Severity only
orders the list and colors badges — it never hides anything.**

```json
{ "pair": { "base": "0003", "head": "0007" },
  "flowDiff": [ { "id": "receipt", "status": "added" },
                { "id": "pay-click", "status": "spec-changed",
                  "detail": "selector '#pay' -> '[data-test=pay]'" } ],
  "steps": [ { "id": "pay-form", "status": "matched",
      "viewports": { "1280x800": { "pixelChangedRatio": 0.021, "findings": [
        { "id": "f1", "kind": "content", "severity": "med",
          "element": { "selector": "[data-test=pay]", "role": "button", "name": "Pay now" },
          "region": { "x": 6, "y": 56, "w": 86, "h": 19 },
          "changes": [ { "prop": "text",  "from": "Pay", "to": "Pay now" },
                       { "prop": "width", "from": 52,    "to": 78 } ] } ] } } } ] }
```

### Noise control

A first-class feature, not a config afterthought: minimum region area, antialias tolerance, flow
`mask`, and a config `ignore` selector list. A tool that cries wolf on every run gets turned off
within a week.

### Prose summaries belong to the agent

`vdiff` emits structured findings only. The Claude Code skill reads `findings.json` and writes the
human sentence. This keeps the CLI free of any API key, model dependency, or network call, and means
summaries are written by something that knows *why* the change was made.

## 9. Report, live channel, feedback, CLI

### Server

`vdiff serve` binds `127.0.0.1` on an ephemeral port, writes `serve.json` containing the URL and a
random session token, and serves a prebuilt static UI shipped inside the package — no build step at
install, no CDN, nothing external.

API: `GET /api/flows`, `GET /api/runs/:flow`, `GET /api/diff/:base..:head`, blobs served from the
store, `GET /api/events` (SSE), `POST /api/feedback`.

### Shell (D7)

- **Header** — flow selector, base and head run pickers showing SHA, ref, dirty badge, timestamp;
  live indicator
- **Filmstrip** — every step as a thumbnail with a change-count badge; red for failed, green `+` for
  added, dashed for removed, gray `=` for identical
- **Focus pane** — side-by-side by default, toggleable to **overlay** (onion-skin with slider) and
  **swipe** (draggable divider); region boxes drawn over the head image, clickable to select
- **Right rail** — findings for the selected step, grouped by severity, expandable to the
  property-level change list
- **Viewport tabs**, and keyboard navigation: `j`/`k` steps, `[`/`]` iterations, `o` overlay,
  `f` findings-only

### Live channel

A watcher on `runs/` fires an SSE event when a run completes. If the user is viewing the newest head,
the page follows to the new run and recomputes automatically; if the user has deliberately pinned an
older pair, an unobtrusive "run 0008 available" badge appears instead of yanking them away
mid-review. Diff recomputation completes server-side before the event fires, so the page never
renders a half-computed pair.

### Feedback

Clicking a region or finding opens a comment box; the result is appended to `feedback/pending.jsonl`:

```json
{ "id": "fb_01", "ts": "2026-08-08T10:12:00Z", "flow": "checkout",
  "pair": "0003..0007", "step": "pay-form", "viewport": "1280x800",
  "findingId": "f1", "element": "[data-test=pay]",
  "region": { "x": 6, "y": 56, "w": 86, "h": 19 },
  "crop": "diffs/checkout/0003..0007/crops/f1.png",
  "text": "padding is too tight, and this should match the cart CTA",
  "status": "pending" }
```

The agent consumes it with `vdiff feedback --json --ack`, which archives what it read. The crop path
lets the agent look at exactly the thing the human pointed at.

**The page never executes anything.** No endpoint spawns a process, runs a build, or touches git. It
appends JSON to one file, and an agent decides what to do with it. Localhost binding plus a session
token keeps other local processes and browser tabs out. This constraint is why D6 chose two-way
feedback over full RPC, and it must remain true as the tool grows.

### CLI surface

Every command accepts `--json`.

```
vdiff init                        scaffold config, gitignore, example flow
vdiff flow new|check <name>       scaffold / validate a spec without running
vdiff run <flow> [--at <ref>] [--viewport ...] [--record|--no-net] [--continue-on-error]
vdiff runs <flow>                 timeline: SHA, dirty, status, findings count
vdiff diff <flow> [base] [head]   compute and print summary (defaults: N-1 vs N)
vdiff serve [--open] [--port]
vdiff feedback [--json] [--ack]
vdiff pin|prune <run>
vdiff install-browser
```

Exit codes: `0` success, `1` run or replay failure, `2` config or spec error. **`diff` exits 0 even
when findings exist** — findings are information, not a gate. Pass/fail thresholds are a CI concern
belonging to a later slice with a baseline-approval workflow.

### Claude Code integration

Deliberately thin. A `visual-diff` skill describing the loop — ensure a flow exists for the feature,
`vdiff run`, `vdiff diff --json`, summarize findings in chat, hand over the report URL — plus
`/vdiff` and `/vdiff-review` commands, and `vdiff feedback --json --ack` to pull human comments back.
All logic lives in the CLI, so the Codex, opencode, and pi adapters in subsystem 1 are near-copies of
a markdown file.

## 10. Error handling

| Failure | Behavior |
|---|---|
| Config or spec invalid | Exit 2 with file, line, and offending key. Unknown verb, missing or duplicate `id`, and `sleep` all fail validation |
| Dev server never ready | Exit 1 with the last 50 lines of server log, saved to the run directory |
| Install fails at old revision | Run marked `failed(install)`; `install.log` retained; timeline entry preserved so the gap is visible |
| Flow absent at target SHA | Rejected cleanly — "flow did not exist at `<sha>`" — not an empty run |
| Step fails | Partial run; downstream `skipped(blocked)`; failure DOM and screenshot captured |
| HAR miss | Request aborted, recorded, surfaced as a run warning listing URLs. Never silently hits the network |
| Diff references pruned run | Report offers the exact backfill command instead of erroring |
| Concurrent runs on one flow | Per-flow lockfile with stale-PID detection |
| Crash mid-run | Run directory written to a temp path and atomically renamed on completion, so a partial run is never visible to the store or report. Orphan worktrees reaped at next startup |
| Chromium missing | One-line message pointing at `vdiff install-browser` |

**Non-negotiable:** worktrees are created detached under `cache/`, and the tool never touches the
user's working tree, index, stashes, or HEAD. A visual diff tool that can lose uncommitted work is
worse than no tool. This is enforced by a test asserting `git status --porcelain` is byte-identical
before and after every historical replay.

## 11. Testing

In order of how much they protect the design:

1. **Determinism test.** Replay the same revision twice; assert zero findings. Then five times;
   assert zero flakes. If this cannot hold green, nothing above it means anything. Every knob in
   section 7 exists to keep it green.
2. **Fixture app plus scripted git history.** A small Vite app in the repository with roughly six
   commits containing known UI changes: label edit, restyle, layout shift, added step, renamed
   selector, introduced console error. Integration tests replay across that history and assert on
   findings. Doubles as the demo and as manual QA.
3. **Golden tests on the diff engine.** Committed pairs of small run directories, snapshotting
   `findings.json`. Fast, hermetic, no browser; catches attribution and clustering regressions.
4. **Unit tests on pure functions** — spec parser and validator, structural flow diff, region
   clustering, DOM attribution, node matching, severity.
5. **Network isolation test.** Record a HAR, replay with real network blocked at the context level;
   assert zero outbound requests and identical output.
6. **CLI `--json` contract tests.** These shapes are the agent-facing API across four harnesses;
   breaking them silently breaks every adapter, so they get snapshot tests.
7. **Report tests** — API contract, SSE delivery on new run, feedback append; UI smoke driven by
   Playwright against the report itself.
8. **Working-tree safety test** — see section 10.

Development is test-driven for the pure core (items 3 and 4) and the flow parser. The runner is
tested against the fixture app rather than against a mocked Playwright, since mocking the browser
would test nothing real.

## 12. Implementation defaults

Decided, so the plan has no ambiguity. Each names the condition that would justify revisiting it.

- **Package `visual-diff`, binary `vdiff`.** Revisit only if the npm name is taken at publish time.
- **Pixel comparison: `pixelmatch`** (pure JS). Portability beats speed given `npx` distribution — a
  native binary turns a one-line install into a platform matrix. Revisit if the determinism test
  exceeds a 30s wall-clock budget on the fixture app.
- **Report UI: Preact**, bundled to a single self-contained asset with no external requests. The
  filmstrip, three view modes, and live updates carry enough state that hand-rolled DOM updates
  would cost more than the dependency.
- **`dom.json` capped at 5,000 nodes per shot.** Past the cap, capture retains nodes in document
  order, sets `truncated: true` in `step.json`, and the report shows a per-step warning. DOM
  attribution degrades to the nearest retained ancestor rather than failing.
- **Language and runtime: TypeScript on Node 20+**, ESM, since `npx` distribution and the Playwright
  dependency both point there.

## 13. Next slices

Ordered by dependency, not priority:

1. **Subsystem 1** — harness packaging: Codex, opencode, pi adapters; `npx` installer; optional MCP
   adapter once the CLI surface has stabilized.
2. **Subsystem 2** — API mocking, built on the HAR layer from D9: editable mocks, scenarios, and
   isolated feature rendering.
3. **Subsystem 3** — wireframe and ideation mode, which depends on subsystem 2's mocking to render
   UI with no backend at all.
4. **Subsystem 4** — explicit e2e mode driving the project's existing suite.
