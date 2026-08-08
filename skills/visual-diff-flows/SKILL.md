# Authoring Visual Diff Flows

A flow is a declarative spec of one user-facing workflow. `vdiff` replays it to capture evidence, and
diffs two replays to show what changed. Load this skill when you need to write or edit a flow spec.

Flows are **data, not code** — that is what lets the tool diff two versions of a flow structurally and
tell the user "step 3 was added" or "this selector was renamed" without running anything.

## Create one

```bash
vdiff flow new checkout --json      # scaffolds .visual-diff/flows/checkout.yaml
vdiff flow check checkout --json    # validates without running — always run this before vdiff run
```

## Anatomy

```yaml
version: 1
flow: checkout
baseUrl: http://localhost:5173
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
    expect:
      - selector: "[data-test=total]"
        text: "$42.00"
    shoot: true

  - id: fill-card
    fill: { "[name=card]": "4242424242424242" }
    shoot: false
```

`version: 1`, `flow` and `steps` are required; `baseUrl`, `viewports` and `network` fall back to
`config.yaml`. `flow` should match the filename — a mismatch is a warning, not an error.

## The five rules that matter

**1. `id` is permanent. Treat it as an identifier, not a label.**

Diffs align by `id`, never by position, and each step owns a directory named after its id. Renaming
an id breaks the link to every historical run — the step reads as one removed and one added, and its
history is gone. Rename the *selector* freely; never rename the `id`.

Choose ids for what the step accomplishes, not what it looks like: `pay-form`, not `second-screen`.

Ids and flow names are used as directory names, so they must start with a letter or digit and contain
only letters, digits, dot, dash or underscore. Ids must be unique within a flow.

**2. Every step must be reachable from the one before it.**

Steps are stateful and sequential. When a step fails, everything after it comes back `blocked` —
because its preconditions no longer hold. Keep flows short enough that one failure does not blind you
to the rest of the app; prefer three focused flows over one twenty-step epic.

**3. `mask` anything that legitimately changes every run.**

Clocks, relative timestamps ("2 minutes ago"), order ids, session ids, randomized content. Masked
regions are painted over before the screenshot is taken, and changes that land inside them are
dropped from the region list, so they cannot produce a finding.

Skipping this is the fastest way to make the tool useless: an unmasked clock produces a finding on
every single run, and real changes drown in it.

**4. There is no `sleep`, and the validator rejects it by name.**

Wait for a condition, never for a duration:

```yaml
waitFor: "[data-test=cart-list]"   # element appears
waitFor: "text=Payment"            # text appears
```

`waitFor` waits for the first match to become *visible*, and takes any selector the browser driver
understands — CSS, `text=…`, `role=…`. A fixed wait is how a screenshot of a half-rendered frame gets
captured. The runner already gates every capture on fonts loaded, idle frames, and no in-flight
requests.

**5. `shoot: false` for intermediate steps.**

Typing into a field is a means, not a screen worth comparing. Shoot the states a human would
actually look at. Fewer, more meaningful shots make a better report and a faster run.

## Step vocabulary — closed set

A step is `id` plus any of these keys. Nothing else is accepted.

| verb | shape | purpose |
|---|---|---|
| `goto` | string | navigate to a path, resolved against `baseUrl` |
| `click` | selector | click the first match |
| `press` | string | press a keyboard key |
| `hover` | selector | hover the first match |
| `fill` | `{selector: value, …}` | fill each field in order |
| `scroll` | `{selector}` or `{x, y}` or `{to: top\|bottom}` | scroll into view, to an offset, or to an edge |
| `waitFor` | selector | wait for the first match to become visible |
| `viewport` | `WIDTHxHEIGHT` | resize from this step onward |
| `mask` | list of selectors | painted over before capture |
| `shoot` | boolean | capture this step (default true) |
| `expect` | list of assertions | assert page state; failure fails the step |

An `expect` entry is an object: `selector` (required) plus any of `visible`, `hidden`, `text`
(substring match) and `count` (exact number of matches).

```yaml
expect:
  - selector: "[data-test=receipt]"
  - selector: "[data-test=error]"
    hidden: true
  - selector: ".line-item"
    count: 3
```

Anything outside this list fails validation with the file, line, and offending key. That is
deliberate — an open vocabulary would make flows unanalyzable, and the structural diff is what
produces the "step added" and "selector drifted" rows in the report.

## Selectors: prefer stable hooks

Order of preference: `[data-test=…]` → role + accessible name → text → CSS path.

A CSS path like `div > div:nth-child(3) > button` breaks on the next refactor, and the report will
tell the user their workflow drifted when only the markup moved. If the app has no test hooks, adding
them is usually the right change to make first.

## Viewports

Each viewport is an independent full replay in a clean browser context. Two viewports means two
complete passes — so list the ones that carry real design decisions, not every device you support.
Desktop plus one mobile width is the usual right answer; the default pair is `1280x800` and `390x844`.

Viewports are `WIDTHxHEIGHT`, must be unique within the list, and `vdiff run --viewport <WxH>` runs a
subset of them without editing the spec.

## Network modes

| mode | behavior |
|---|---|
| `replay` | serve responses from the HAR; unmatched requests abort and are reported as `har-miss` |
| `record` | record traffic to the HAR |
| `off` | no HAR; non-local requests blocked |

`network.har` is **required** when the mode is `replay` or `record`, and is a filename relative to
`.visual-diff/flows/`. In `replay` mode with no HAR file on disk yet, the first run records one
automatically and later runs replay it. Setting `har` with mode `off` is a warning: it is ignored.

Re-record with `vdiff run <flow> --record` when the app's real network calls change. Recorded HARs
are scrubbed of `Authorization`, `Cookie` and `Set-Cookie` before being written, plus anything named
in `config.network.redact` — add your app's custom auth headers there. `--no-scrub` skips that pass;
do not use it on a HAR you intend to commit.

## Commit the spec

`.visual-diff/flows/` and `.visual-diff/config.yaml` are committed. Historical replay reads the flow
spec out of git history at the target revision, so an uncommitted flow cannot be replayed against the
past — which is most of the tool's value.
