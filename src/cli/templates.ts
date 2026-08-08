/**
 * cli — the files `vdiff init` and `vdiff flow new` scaffold (spec §6, §9).
 *
 * Content only; no logic. Every value below is the one the spec names — the config keys and their
 * defaults come from §6 "Configuration", the flow spec from §6 "Flow spec, version 1", and the
 * gitignore block verbatim from §6 "Git boundary".
 */

/** The name of the example flow written by `vdiff init`. */
export const EXAMPLE_FLOW_NAME = 'example';

/**
 * `.gitignore` block. `flows/` and `config.yaml` **must** be committed: replaying a historical
 * revision reads the flow file out of git history at that SHA (D4), so an uncommitted flow has
 * nothing to read. Everything else — runs, diffs, cache, feedback — is local.
 */
export const GITIGNORE_BLOCK = `# visual-diff — flows and config are committed; runs, diffs, cache and feedback are local.
.visual-diff/*
!.visual-diff/config.yaml
!.visual-diff/flows/
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
