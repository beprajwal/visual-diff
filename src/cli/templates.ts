/**
 * cli — the files `vdiff init`, `vdiff flow new` and `vdiff scenario new` scaffold (spec §6, §9;
 * mocking spec §5, §7).
 *
 * Content only; no logic. Every value below is the one the spec names — the config keys and their
 * defaults come from §6 "Configuration", the flow spec from §6 "Flow spec, version 1", and the
 * gitignore block verbatim from §6 "Git boundary".
 */

/** The name of the example flow written by `vdiff init`. */
export const EXAMPLE_FLOW_NAME = 'example';

/**
 * `.gitignore` block. `flows/`, `scenarios/`, `variants/` and `config.yaml` **must** be committed:
 * replaying a historical revision reads them out of git history at that SHA (D4 for flows, mocking
 * spec §5 "Storage" for scenarios, variants spec §4 for variants), so an uncommitted one has
 * nothing to read — and the failure is a confusing "variant absent at the target SHA" on a file
 * that is plainly sitting on disk. Everything else — runs, diffs, cache, feedback — is local.
 */
export const GITIGNORE_BLOCK = `# visual-diff — flows, scenarios, variants and config are committed; runs, diffs, cache and feedback are local.
.visual-diff/*
!.visual-diff/config.yaml
!.visual-diff/flows/
!.visual-diff/scenarios/
!.visual-diff/variants/
`;

/** Presence of this line means the block has already been installed. */
export const GITIGNORE_MARKER = '.visual-diff/*';

export const CONFIG_YAML = `# .visual-diff/config.yaml — committed, project-level settings.

app:
  # How to install dependencies when replaying a historical revision. Cached by lockfile hash,
  # so a revision whose lockfile matches an existing entry installs nothing.
  install: pnpm install --frozen-lockfile
  # How to start the dev server. $PORT is substituted with an allocated free port.
  dev:     pnpm dev --port $PORT
  # Probed until it answers. If your own dev server is already up on this URL, vdiff drives it
  # directly and skips the worktree, the install and the build entirely.
  readyOn: http://localhost:$PORT/
  readyTimeout: 90s

diff:
  # Noise control is a feature, not an afterthought: a tool that cries wolf gets turned off.
  minRegionArea: 64        # ignore changed regions smaller than this many pixels
  maxRegions: 40           # cap boxes per shot; the remainder collapses to "N smaller changes"
  antialiasTolerance: 0.1
  ignore: ["[data-test=session-id]"]   # selectors excluded from regions and findings

network:
  # Dropped from recorded HARs in addition to Authorization, Cookie and Set-Cookie, which are
  # always dropped. Writing an unscrubbed HAR requires an explicit --no-scrub.
  redact: ["x-api-key"]

retention:
  # Older runs keep meta.json and flow.snapshot.yaml forever, so the timeline stays intact and a
  # pruned point can be backfilled by replaying it.
  keepRuns: 20
`;

/** A minimal, valid flow spec. Kept to one step so it replays against any app unchanged. */
export function flowYaml(name: string): string {
  return `# .visual-diff/flows/${name}.yaml — an agent-authored workflow, replayed headless.
#
# Step ids are stable and load-bearing: a diff aligns two runs by \`id\`, never by index, so a step
# added in the middle does not shift everything after it. Rename an id and the diff reports one
# step removed and another added.
#
# Closed step vocabulary: goto click fill press hover scroll waitFor viewport mask shoot expect.
# There is deliberately no \`sleep\` — a fixed wait is how a half-rendered frame gets captured.
# Use \`waitFor\`; capture already gates on fonts, animation frames and in-flight requests.

version: 1
flow: ${name}
baseUrl: http://localhost:5173
viewports: [1280x800, 390x844]

# The first run records the network to this HAR; later runs replay it, so a diff isolates the code
# change instead of whatever the backend happened to return.
network: { mode: replay, har: ${name}.har }

steps:
  - id: home
    goto: /
    waitFor: "body"
    # mask: ["[data-test=order-date]"]   # clocks, ids and relative timestamps: paint them over,
    #                                    # or they produce a finding on every single run.
    shoot: true
`;
}

/**
 * A minimal, valid scenario spec (mocking spec §5). One rule, `overlay` mode, so it is a working
 * file the moment it is written — the glob is the only thing the author has to change.
 *
 * The commentary carries the two facts that cost the most when they are learnt the hard way: the
 * rule `id` is what the report names when it attributes a changed response, and a rule that matches
 * nothing produces a run warning rather than a silently unpatched screen.
 */
export function scenarioYaml(name: string): string {
  return `# .visual-diff/scenarios/${name}.yaml — a named overlay on recorded traffic.
#
# A scenario patches the responses a flow replays, so the same flow can be captured against the
# empty state, the error state or the slow state, and each compared across revisions like any
# other run: \`vdiff run <flow> --scenario ${name}\`.
#
# Rule ids are stable and load-bearing: the report attributes a changed response to the rule that
# changed it by id, so renaming one severs that rule's history. Changing its \`match\` does not.
#
# Exactly one response verb per rule — patch, patchOps, respond or abort. \`delay\` is a modifier
# and composes with any of them, including on its own. A rule that never matches during a run is
# reported as a warning, because a mistyped glob otherwise leaves you looking at the recording and
# believing it is the patched state.

version: 1
scenario: ${name}
description: describe the state this scenario puts the UI in

# overlay: patch the recording, pass unmatched requests through to it.
# mock:    no recording at all; unmatched requests are aborted and reported as misses.
#          patch and patchOps are rejected in mock mode — there is nothing to patch.
mode: overlay

rules:
  - id: example-empty
    match: { method: GET, url: "**/api/**" }
    # JSON merge patch (RFC 7386): null deletes a key, an object merges, anything else replaces.
    patch: { items: [] }

  # - id: example-error
  #   match: { url: "**/api/checkout**" }
  #   respond:
  #     status: 500
  #     headers: { content-type: application/json }
  #     body: { error: upstream_unavailable }

  # - id: example-slow
  #   match: { url: "**/api/search**" }
  #   delay: 3000
`;
}

/**
 * A minimal, valid variant spec (variants spec §4). One `style` rule, so it is a working file the
 * moment it is written — the selector is the only thing the author has to change.
 *
 * The commentary carries the three facts that cost the most when they are learnt the hard way: a
 * variant cannot invent UI, a rule that matches nothing produces a run warning rather than a
 * silently unchanged screenshot, and the rule `id` is what the report names when it attributes a
 * modified element.
 */
export function variantYaml(name: string): string {
  return `# .visual-diff/variants/${name}.yaml — a proposed UI change, applied just before capture.
#
# Rules act on the page the application *already rendered*: they restyle, retext, hide, reorder and
# clone elements that exist. A variant cannot invent UI — there is no HTML verb and there never will
# be one — so what you see is a real prediction of the real app, not a wireframe of it.
#
# Preview it with \`vdiff run <flow> --variant ${name}\`, which diffs against the unmodified page at
# the same revision. Variant runs live in their own retention bucket and stay out of the regression
# timeline; \`--keep\` promotes one that turned out to be worth tracking.
#
# Rule ids are stable and load-bearing: the report attributes every modified element to the rule
# that modified it by id. Exactly one verb per rule — style, text, hide, order or clone. A rule that
# matches nothing, or whose effect the app re-rendered away before capture, is reported as a run
# warning; without that you would be looking at the unmodified UI believing it is the proposal.

version: 1
variant: ${name}
description: describe the change this variant proposes

rules:
  - id: example-tighter
    match: "[data-test=card]"
    style: { padding: 8px, gap: 4px }

  # - id: example-copy
  #   match: "[data-test=save-cta]"
  #   text: "Save this location"

  # - id: example-hide
  #   match: "[data-test=air-quality]"
  #   hide: true

  # - id: example-order
  #   match: "[data-test=forecast-chart]"
  #   order: first            # first | last | { before: <selector> } | { after: <selector> }

  # - id: example-clone
  #   clone:
  #     from: { step: pricing, match: "[data-test=plan-card]:first-child" }
  #     into: "[data-test=sidebar]"
  #     position: prepend     # prepend | append | { before: … } | { after: … }
  #     times: 1
`;
}
