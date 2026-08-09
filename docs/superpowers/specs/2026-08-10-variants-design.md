# Variants — Design (Subsystem 3: previewing proposed UI changes)

Date: 2026-08-10
Status: Approved for planning
Builds on: slice 1 (D1–D9), API mocking (D10–D14)

## 1. Problem

An agent proposes a UI change: tighter cards, a section moved, the upsell promoted to the sidebar.
Seeing whether that proposal is any good currently means implementing it — editing real components,
running the app, looking, then unwinding the edit if the answer is no. The cost of looking is the
same as the cost of building, so proposals get evaluated by reading diffs of code instead of by
looking at the result.

**Variants** let a proposed change be rendered and compared without touching the codebase. A variant
is a declarative set of rules applied to the rendered page just before capture, producing a run that
diffs against the unmodified page — real components, real CSS, real fonts, only the proposal
different.

### What this is not

This was originally scoped as "wireframing / ideation". It is not, and the name is retired. A variant
**cannot invent UI**. Every element it shows must already be rendered by the application somewhere.
The tool answers "how would this rearrangement look", not "design me a new screen". That constraint
falls out of the mechanism rather than being policed: rules operate on nodes the app produced.

## 2. Scope

### In

- `variants/<name>.yaml`: declarative rules restyling, retexting, hiding, reordering and cloning
  existing elements
- Cloning from another page of the same application, at the same revision
- Variant runs, kept apart from the regression timeline, diffed against their unmodified baseline
- Verification that each rule still holds at capture time, with warnings when it does not

### Explicit non-goals

- **No arbitrary HTML injection.** No `html:` verb, no markup pasted into a slot. That is the
  wireframing this feature deliberately is not.
- **No cross-revision compositing.** A clone source is always the same revision as its target.
  Compositing two revisions into one image and calling it a preview would undermine the tool.
- **No code generation.** A variant is not turned into a patch, a component, or a suggested diff.
  Deciding a proposal is good and implementing it are separate acts, and the second belongs to the
  agent, not to `vdiff`.
- **No variant authoring UI.** The report displays variants and what they changed; the page still
  executes nothing (D6).
- **No interaction with variants.** Rules apply once before capture; a variant is a still, not a
  prototype you can click through.

## 3. Decisions and rationale

Continues the record: slice 1 is D1–D9, mocking D10–D14, harness packaging D15–D19.

**D20 — Variants modify rendered output; they never introduce components.**
The catchment is what the application already renders. Rejected: a declarative wireframe format
rendered by a generic renderer (produces rectangles nobody can make a decision from, and predicts
nothing about the real app) and generating throwaway components into a scratch workspace (highest
fidelity, but it is building the change, which is the cost this feature exists to avoid).

**D21 — A closed rule vocabulary: `style`, `text`, `hide`, `order`, `clone`.**
Enough for the proposals people actually make — density, copy, visibility, arrangement, repetition.
Rejected: arbitrary HTML injection, which is where a variant stops predicting the app and starts
inventing UI (§2). `clone` is included because a great many real proposals are "what if there were
three of these", and a clone descends from a rendered element, so it cannot fabricate a component.

**D22 — Rules apply once, after the settle gate, before masking and capture.**
Rejected: injected-CSS-first with `MutationObserver` re-application, and a persistent observer
enforcing every rule. Both are more robust against frameworks that re-render after mutation, and
both are a fight with the reconciler that risks the page never settling — which would undermine the
determinism the runner exists to provide.

The failure this creates is specific and dangerous: an app re-rendering between mutation and capture
silently reverts the variant, producing a screenshot of the *unvaried* UI labelled as a variant. So
application is followed by a **verification pass** — re-query every rule's target and confirm its
effect is still present. A rule whose effect has been reverted produces a run warning naming it.
That converts a silent wrong answer into a loud one for the cost of one assertion pass. If
verification proves to fail often in practice, injected CSS for `style`/`hide` is the escalation —
the warning tells us whether that is a real problem rather than a theoretical one.

**D23 — Clone sources come from a step in the same run, or from a URL visited during it.**
`from: { step: … }` for sources the flow already captures — deterministic, one session, guaranteed
same revision. `from: { url: … }` as an escape hatch for routes the flow never visits, extracted in
a second context during the run. Both resolved before capture, so a missing source fails fast rather
than mid-run. Rejected: sourcing from any stored run, which permits compositing revisions (§2).

**D24 — Variant runs are ephemeral, in their own retention bucket.**
Proposals are exploratory: you try five arrangements and keep zero or one. Letting them share the
20-run bucket would evict the capture history regressions depend on — a quiet data loss at exactly
the wrong moment. Variant runs are therefore excluded from the regression timeline, retained
separately, and `--keep` promotes one into the permanent timeline when it is worth tracking.

Their default comparison also differs from scenarios'. For a scenario the question is regression —
same scenario, two revisions. For a variant it is the proposal itself: **same revision, variant
versus none**. Applying scenario pairing semantics unchanged would flag that as a cross-variant
comparison and warn about precisely the thing the user is trying to do.

## 4. Variant schema

```yaml
version: 1
variant: denser-forecast
description: Tighter cards, air quality hidden, upsell promoted
rules:
  - id: tighter-cards
    match: "[data-test=forecast-card]"
    style: { padding: 8px, gap: 4px }

  - id: cta-copy
    match: "[data-test=save-cta]"
    text: "Save this location"

  - id: hide-air-quality
    match: "[data-test=air-quality]"
    hide: true

  - id: chart-first
    match: "[data-test=forecast-chart]"
    order: first                       # first | last | { before: <selector> } | { after: <selector> }

  - id: promote-upsell
    clone:
      from: { step: pricing, match: "[data-test=plan-card]:first-child" }
      into: "[data-test=sidebar]"
      position: prepend                # prepend | append | { before: … } | { after: … }
      times: 1
```

**Rule ids are required and stable**, as with flow steps (D4) and scenario rules (D11): they carry
attribution into the report and let two versions of a variant be compared structurally.

**Exactly one verb per rule** — `style`, `text`, `hide`, `order` or `clone`. Two verbs is a
validation error rather than an invented precedence.

**`match` selects zero or more elements.** A rule matching nothing is a run warning listing the rule
id, exactly as with never-matched scenario rules — a user believing they are looking at a denser
layout, when a mistyped selector matched nothing, has been actively misled.

**`clone.from`** accepts `{ step, match }` or `{ url, match }` (D23). Extraction captures the
element's `outerHTML` together with the source page's injected `<style>` elements, because
CSS-in-JS libraries inject rules at mount time and a component cloned onto a page where it never
mounts would otherwise render unstyled. **An unstyled clone is a misleading preview, not a failed
one**, so the runner compares the clone's computed styles at source and target and warns when they
differ materially.

### Storage

`.visual-diff/variants/<name>.yaml`, committed alongside flows and scenarios, read from git history
at the target SHA on historical replay (D4).

## 5. Run identity, retention, pairing

`meta.json` gains `variant`, defaulting to `none`, exactly as `scenario` does (D12) and for the same
reasons — scenario and variant are attributes of a run, not levels of a hierarchy.

| aspect | behaviour |
|---|---|
| timeline | variant runs are excluded from the regression timeline by default; `vdiff runs <flow> --variants` lists them |
| retention | separate bucket, default 10, so proposals never evict capture history |
| default diff | variant vs the nearest non-variant run **at the same revision** — the proposal question |
| across revisions | permitted for a promoted variant; behaves like any other same-identity pair |
| promotion | `--keep` moves a variant run into the permanent timeline |

Combining a variant with a scenario is permitted — "the denser layout, in the empty state" is a
reasonable question. Run identity is `(flow, revision, scenario, variant)`, and the report states
both.

## 6. CLI

```
vdiff run <flow> --variant <name> [--scenario <name>] [--keep]
vdiff runs <flow> [--variants]
vdiff diff <flow> [base] [head] [--variant <name>]
vdiff variant new|check|list [<name>]
```

`--json` throughout, with the three `variant` subcommands snapshot-tested like the rest of the
surface.

## 7. Validation and errors

Exit 2, with file, line and offending key: unknown keys; missing or duplicate rule `id`; missing
`match`; two verbs on one rule; `clone.from` specifying neither `step` nor `url`, or both; unparseable
selector; `order`/`position` referencing a selector that is itself invalid; `times` below 1; `variant:`
disagreeing with the filename. `none` is reserved.

| Situation | Behaviour |
|---|---|
| rule matched nothing | run warning naming the rule |
| **rule reverted before capture** | **run warning naming the rule** (D22) |
| clone source step not in the flow | exit 2, before the run starts |
| clone source URL unreachable under the active network mode | run fails, naming the rule and URL |
| cloned element's computed styles differ materially from source | run warning naming the rule |
| variant absent at the target SHA | rejected cleanly, as a missing flow is under D4 |

Attribution: each modified element records `{ variant, ruleId, verb }`, and the report annotates the
step with "element modified by `denser-forecast` rule `tighter-cards`".

## 8. Testing

1. **Determinism under variants** — same flow, same variant, twice, zero findings.
2. **Verification catches reverts.** A fixture screen that deliberately re-renders after the settle
   gate must produce the D22 warning rather than a silently unvaried screenshot. This test is the
   entire justification for choosing apply-once, and without it that decision is unguarded.
3. **Golden tests on rule application** — a fixture DOM plus a variant in, resulting DOM out, for
   every verb including `order` and `clone` positioning.
4. **Cross-page cloning**, both `step:` and `url:` sources, including the unstyled-clone warning.
5. **Validator messages**, one per rejection in §7, asserting the text.
6. **Retention isolation** — variant runs never evict non-variant runs, in either direction.
7. **Pairing** — the default variant diff is against the same-revision baseline, and does not warn.
8. **Historical parity** — the variant applied is the one committed at the target SHA.
9. **CLI `--json` contracts.**

## 9. Implementation notes

- Rule application runs in-page, after the settle gate and before masking, so masked regions still
  mask and a variant cannot defeat the determinism knobs.
- The verification pass re-queries in the same in-page call, immediately before the screenshot, to
  minimise the window in which a re-render can intervene.
- Clone extraction reuses the runner's existing context-creation path so the source page is subject
  to the same determinism knobs, scenario and network mode as the target.
- Selector matching reuses the diff engine's selector support; anything it cannot evaluate is a
  validation error, not a silent no-match (the failure mode already fixed once for `diff.ignore`).

## 10. Next

Subsystem 4 — explicit e2e mode driving a project's existing suite — is the last planned slice and
is not yet designed.
