# API Mocking — Design (Subsystem 2: scenarios over recorded traffic)

Date: 2026-08-10
Status: Approved for planning
Builds on: `2026-08-08-visual-diff-design.md` (slice 1, decisions D1–D9)

## 1. Problem

Slice 1 froze the network so diffs isolate code change: the first run of a flow records a HAR, later
runs replay it. That makes runs comparable, but it also makes them singular. Every run shows the one
state the backend happened to be in when the recording was taken.

Most UI regressions do not live in that state. They live in the empty list, the 500, the very long
name, the slow response that reveals a missing skeleton. Reaching those today means mutating a real
backend and re-recording, which is laborious and destroys the recording everything else depends on.

This slice adds **scenarios**: named, committed overlays that patch recorded responses for a run, so
the same flow can be captured against the empty state, the error state, or the slow state — and each
of those compared across revisions like any other run.

It also adds a **mock-only** mode for UI whose backend does not exist yet, which is the foundation
subsystem 3 (wireframing) is built on.

## 2. Scope

### In

- Scenario specs: declarative YAML, matched against requests, patching or replacing responses
- `overlay` mode (patch a recording) and `mock` mode (no recording at all)
- Scenario as a dimension of run identity, with scenario-aware pairing and retention
- Attribution of response changes to the rule that caused them, surfaced in the report
- A fixture application with a real recorded API, replacing the frontend-only fixture

### Explicit non-goals

- **No scenario composition or inheritance.** No `extends`, no layering. The obvious next feature and
  the obvious YAGNI; composition semantics deserve a real use case first.
- **No recording through a scenario.** `--record` with `--scenario` is a hard error. Recording
  captures reality, a scenario alters it, and a HAR blending both is neither.
- **No request assertions or contract testing.** Scenarios shape responses; they do not assert what
  the application asked for.
- **No authoring UI.** The report shows which scenario ran and what it changed. It does not edit
  scenarios, and it still executes nothing (D6).
- **No `--scenario all`.** Capturing every scenario in one command is deferred; see §10.
- **No wireframe mode.** `mock` is the foundation for subsystem 3, not subsystem 3.

## 3. Vocabulary

Extends §3 of the slice-1 spec.

| Term | Meaning |
|---|---|
| **scenario** | A named YAML spec of rules that intercept requests for a run |
| **rule** | One `match` plus one response verb, identified by a stable `id` |
| **passthrough** | A request no rule matched, served from the recording |
| **overlay mode** | Scenario patches a HAR recording; unmatched requests replay normally |
| **mock-only run** | A run with `network: mock` — no recording is involved at all |

## 4. Decisions and rationale

Continues the slice-1 decision record (D1–D9).

**D10 — Scenarios are overlays on recorded traffic, not standalone mocks.**
The recording remains the baseline; a scenario is an explicit delta from it. Rejected: standalone
mock definitions (every scenario restates a whole payload by hand, so a backend field addition
silently makes them all stale) and interceptor rules with no stored bodies (loses the fidelity the
HAR layer was bought for). The property being protected: a visual diff against a fictional API
proves nothing, so responses stay real recordings wherever possible.

**D11 — Scenarios are declarative YAML, not code.**
A scenario is data: `match` plus a response verb. Rejected: `.mjs` modules exporting a route
handler. Code has no expressive ceiling, but it costs three things that matter more here:

1. Two versions of a scenario cannot be compared structurally, so the report cannot say which rule
   changed a response without runtime instrumentation. As data, a rule id is attribution for free.
2. Executing user code loaded out of git history during historical replay is a materially larger
   surface than parsing YAML, and it reintroduces the nondeterminism D9 exists to remove — a
   scenario calling `Date.now()` would defeat the frozen clock.
3. It would split the model: flows are declarative for exactly these reasons (D8). Scenarios being
   code while flows are data is an inconsistency with no compensating gain.

This decision was taken, briefly reversed in favour of code modules, and returned to. The reversal
is recorded because the arguments for code — no ceiling, arbitrary logic — remain true and will
resurface. The answer is that a scenario needing real computation is a signal the *fixture* is
wrong, not that the format is.

**D12 — Scenario is part of run identity.**
A run is `(flow, revision, scenario)`. Diffs pair same-scenario runs by default, because the
regression question is "did the empty state break between these revisions?" and that needs
like-for-like pairs. Rejected: scenario as an axis captured inside one run (runs grow linearly with
scenario count and you cannot iterate on just one) and scenario as a view-time filter (conflates
capture with presentation, and the runner can never skip work).

**D13 — `mock` is a first-class network mode, structurally labelled.**
Alongside `record`, `replay` and `off`. No HAR required; unmatched requests abort and are reported
as misses. Rejected: requiring a recording always (cannot capture UI whose endpoint does not exist
yet, which is the common case when an agent has just built ahead of the API) and implicit fallback
to mock when no HAR exists — silent behaviour of exactly the kind that produced the live-network
fallthrough bug. Fidelity is only as good as the scenario, so the mode is recorded in `meta.json`
and badged in the report rather than trusted to be remembered.

**D14 — The fixture app replays a real public API, recorded once.**
A weather dashboard over Open-Meteo: no API key, CC-BY-4.0 data, and payloads that are genuinely
awkward — nested objects, long numeric arrays, nulls — which stress merge-patch and `patchOps` far
harder than invented data. Recorded once and committed; **never called during tests**. Rejected:
live API calls (CI depending on a third party's uptime and rate limits, non-deterministic responses
breaking the guarantee the tool sells) and fully synthetic data (the author of the fixture
unconsciously shapes it to suit the code under test).

## 5. Scenario schema

```yaml
version: 1
scenario: empty-forecast
description: No forecast data, for checking the empty state
mode: overlay                      # overlay (default) | mock
rules:
  - id: forecast-empty             # stable, required
    match: { method: GET, url: "**/v1/forecast**" }
    patch: { hourly: { temperature_2m: [] } }     # JSON merge patch on the recorded body

  - id: geocode-fails
    match: { method: GET, url: "**/v1/search**" }
    respond:
      status: 500
      headers: { content-type: application/json }
      body: { error: upstream_unavailable }

  - id: slow-air-quality
    match: { url: "**/v1/air-quality**" }
    delay: 3000                                   # modifier, composes with any verb

  - id: no-analytics
    match: { url: "**/analytics/**" }
    abort: true

  - id: first-day-removed
    match: { url: "**/v1/forecast**" }
    patchOps:                                     # RFC 6902, for what merge patch cannot express
      - { op: remove,  path: /daily/time/0 }
      - { op: replace, path: /daily/weather_code/0, value: 95 }
```

### Rules

**`id` is required and stable.** It plays the same role step ids play under D4: it lets two versions
of a scenario be compared structurally and gives the report something to name. Renaming an id severs
that rule's history; changing its `match` does not.

**Exactly one response verb per rule** — `patch`, `patchOps`, `respond`, or `abort`. `delay` is a
modifier and composes with any of them, including on its own (pass the recorded response through,
late). Two verbs on one rule is a validation error rather than an invented precedence order.

**Matching**: `method` optional, defaulting to any; `url` glob required; `nth` optional, selecting
the *n*th occurrence of an otherwise identical request. First match wins in file order. Unmatched
requests pass through.

**Patching**: JSON merge patch (RFC 7386) by default, because it reads naturally in YAML and covers
the common case of changing a field. `patchOps` (RFC 6902) is available for array indices and
removals that merge patch cannot express. Both are valid only against JSON content types.

**`respond.body`** accepts an object (serialized as JSON), a string, or `{ base64: … }` for binary.

### The two modes

| | `overlay` | `mock` |
|---|---|---|
| HAR required | yes | no |
| Unmatched request | served from the recording | aborted, reported as a miss |
| `patch` / `patchOps` | valid | **rejected at validation** |
| `respond` / `abort` / `delay` | valid | valid |

`patch` is rejected in `mock` mode at validation time, not at run time. A merge patch against a
nonexistent recorded body would otherwise produce whatever the patch alone contains, which looks
like it worked.

### Storage

`.visual-diff/scenarios/<name>.yaml`, committed alongside flows and read from git history at the
target SHA during historical replay, exactly as flow specs are under D4.

## 6. Run identity, store, and pairing

**Scenario is recorded in `meta.json`, not in the path.**

```json
{ "runId": "0007", "flow": "forecast", "scenario": "empty-forecast", "network": "replay", … }
```

`runs/<flow>/<scenario>/<nnnn>/` is tidier and was rejected on four grounds. Migration is *not* one
of them — no store exists in the wild yet, so relocating runs would cost nothing today:

1. **Scenario is an attribute of a run, not a level of hierarchy.** So are revision and viewport.
   Promoting one of them into the path privileges it permanently and fights every other grouping the
   report might want.
2. **Run ids stay monotonic per flow**, so the timeline is one honest sequence of what was captured,
   in order, regardless of scenario. Per-scenario counters would make `0007` ambiguous.
3. **Filtering at query time is trivial; grouping at path time is rigid.** Regrouping by revision, or
   listing every scenario captured at one SHA, needs no directory reshuffle.
4. **Scenario names would become path components**, inheriting case-insensitivity on macOS and
   Windows, reserved device names, and escaping rules. A validated YAML field has none of that.

Slice-1 runs remain readable either way, with scenario defaulting to `none`.

**Retention becomes scenario-aware** — the last 20 runs per `(flow, scenario)`, not per flow.
Otherwise a frequently-run scenario evicts the history of a rarely-run one, which is backwards: the
rarely-run scenario is the one whose history cannot be reconstructed from memory.

**Pairing:**

| pair | behaviour |
|---|---|
| same scenario | default; the regression question |
| different scenarios, same revision | permitted, labelled `cross-scenario` in `findings.json`, CLI output and report |
| mock-only vs recorded | permitted, flagged at high severity, both runs badged |

Cross-scenario comparison is a legitimate question — it compares two states rather than two
revisions — so the tool permits it and refuses to let the answer be mistaken for a regression.
Mock-versus-recorded compares a fiction to a measurement, and is flagged accordingly. The principle
throughout is the one behind `unstable` runs: state what the tool does not know.

## 7. CLI

```
vdiff run <flow> --scenario <name>              capture under a scenario
vdiff runs <flow> [--scenario <name>]           timeline with a scenario column
vdiff diff <flow> [base] [head] [--scenario <name>]
vdiff scenario new <name>                       scaffold a scenario spec
vdiff scenario check <name>                     validate without running
vdiff scenario list                             enumerate scenarios and their modes
```

`--record` with `--scenario` exits 2 (§2). All commands keep `--json`, and the three `scenario`
subcommands get snapshot-tested envelopes like the rest of the surface.

## 8. Validation and errors

Exit 2, with file, line and offending key:

- unknown keys; missing or duplicate rule `id`; missing `match.url`
- two response verbs on one rule
- `patch` or `patchOps` in `mock` mode
- malformed RFC 6902 op; unparseable glob; `status` outside 100–599; negative `delay`; `nth` below 1
- `scenario:` disagreeing with the filename

Run-time failures, each naming the responsible rule:

| Situation | Behaviour |
|---|---|
| `overlay` mode with no HAR | exit 2 — the slice-1 rule, unchanged |
| rule matched a request with no recorded response | run fails, naming rule and URL |
| `patch` against a non-JSON body | run fails, naming rule and content type |
| `mock` mode, unmatched request | aborted, reported as a miss |
| **rule never matched during the run** | **run warning listing the rule ids** |
| scenario absent at the target SHA | rejected cleanly, as a missing flow is under D4 |

The never-matched warning is the most important line in this section. A user looking at a screen
they believe is the empty state, when a mistyped glob matched nothing and they are in fact seeing
the recorded full response, has been actively misled by the tool.

**Attribution.** For every request, `network.json` records `{ scenario, ruleId, action, bodyChanged }`.
The report reads it to annotate the affected step with "response modified by `empty-forecast` rule
`forecast-empty`".

## 9. Fixture application

The current fixture is frontend-only with `network: off`, so nothing in the repository can exercise
overlay mode end to end. **This is the largest single item in the slice and the one most likely to
be underestimated.**

**Shape**: a small weather dashboard over Open-Meteo, as an npm workspace at `fixtures/app` with
`private: true`. Vite, no UI framework beyond Preact at most — the slow suite installs it inside a
git worktree on every historical replay, so install time is a direct cost on every test run.

**Screens worth diffing**: a location list, a forecast detail with an SVG time-series chart (where
pixel diffing earns its keep), a units toggle, and natural empty, loading and error states.

**Data**: recorded once from the live API and committed as a fixture HAR. Tests never reach the
network. `npm run fixture:record` re-records deliberately; it is never part of `npm test`.
`fixtures/app/README.md` records the source, the licence (CC-BY-4.0) and the date of recording.

**Secondary role**: this fixture is also the demo. README screenshots and any future documentation
come from it, which is a further argument for it being pleasant to look at.

## 10. Testing

In order of how much they protect the design:

1. **Determinism under scenarios.** Same flow, same scenario, twice, zero findings — including with
   `delay`. The slice-1 guarantee must survive this layer.
2. **Fixture app with a recorded API** (§9), without which scenarios are only ever unit-tested.
3. **Golden tests on the overlay engine**: fixture HAR plus scenario in, resulting responses out.
   Hermetic, no browser. Covers match ordering, `nth`, merge patch, `patchOps`, `respond`, `abort`,
   `delay`.
4. **Validator tests** — one per rejection in §8, asserting the *message*, not merely the failure.
   These messages are the feature's user interface.
5. **Integration with real Chromium**: overlay changes what renders, `mock` renders with no HAR at
   all, `delay` exercises the settle gate, `abort` produces the miss warning.
6. **Pairing flags**: cross-scenario and mock-versus-recorded pairs produce their labels at the
   right severity; same-scenario pairs produce neither.
7. **Historical parity**: the scenario used is the one committed at the target SHA (D4).
8. **CLI `--json` contracts** for the three `scenario` subcommands.

## 11. Implementation defaults

Decided, so the plan carries no ambiguity.

- **Glob matching** uses the same implementation as the existing `ignore` selectors where possible;
  if unsuitable, `picomatch`-style semantics with `**` crossing path separators. URL matching applies
  to the full URL including query string.
- **Merge patch and JSON Patch** are implemented in-repo rather than taking dependencies. Both are
  small, well-specified algorithms, and every runtime dependency is downloaded by every `npx` user.
- **`delay`** is implemented by deferring the route fulfilment, not by sleeping the runner, so
  concurrent viewports are unaffected.
- **Scenario `none`** is a reserved name and cannot be used as a filename.
- **Rule evaluation is per request**, with `nth` counted per `(method, url)` within a run.

## 12. Next slices

1. **Subsystem 1 — harness packaging.** Parked mid-design; see
   `2026-08-09-harness-packaging-notes.md`, which records four settled decisions, a verified path
   map, and three items deliberately left unverified.
2. **Subsystem 3 — wireframe and ideation mode**, built on `mock` (D13).
3. **Subsystem 4 — explicit e2e mode** driving a project's existing suite.
4. **Deferred from this slice**: `--scenario all` capturing every scenario in one command, and
   scenario composition.
