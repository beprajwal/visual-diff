/**
 * The report stylesheet, carried as a string so the whole UI ships as one self-contained asset
 * (spec §9: prebuilt, no build at install, nothing external). `main.tsx` injects it at mount.
 *
 * Dense and terminal-adjacent: system monospace throughout, hairline rules instead of shadows,
 * colour reserved for diff semantics. Light and dark are both first-class; the palette is defined
 * on `:root` and re-declared under `prefers-color-scheme: dark` and an explicit `[data-theme]`
 * override, so an OS-level preference and a manual toggle both work.
 */

export const STYLES = `
:root {
  color-scheme: light dark;

  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace;

  --bg: #fbfbfa;
  --bg-panel: #ffffff;
  --bg-sunken: #f2f2ef;
  --bg-hover: #ebebe7;
  --bg-active: #e2e2dc;
  --fg: #1b1b19;
  --fg-dim: #63635d;
  --fg-faint: #8c8c85;
  --line: #d9d9d3;
  --line-strong: #b6b6ae;
  --accent: #1d5fd0;
  --accent-fg: #ffffff;

  --sev-high: #c02626;
  --sev-med: #b06a00;
  --sev-low: #63635d;
  --added: #1a7f43;
  --removed: #8c8c85;
  --failed: #c02626;
  --identical: #8c8c85;
  --region: #d0217a;

  --sev-high-bg: #fbe9e9;
  --sev-med-bg: #fbf1e0;
  --sev-low-bg: #f0f0ec;
  --added-bg: #e6f4ec;

  --shot-bg: #ffffff;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #101211;
    --bg-panel: #171a19;
    --bg-sunken: #0b0d0c;
    --bg-hover: #212523;
    --bg-active: #2b302e;
    --fg: #e4e6e4;
    --fg-dim: #9aa09c;
    --fg-faint: #6e756f;
    --line: #2a2f2c;
    --line-strong: #3d4441;
    --accent: #6ea8ff;
    --accent-fg: #06121f;

    --sev-high: #ff7b72;
    --sev-med: #e3b341;
    --sev-low: #9aa09c;
    --added: #56d364;
    --removed: #6e756f;
    --failed: #ff7b72;
    --identical: #6e756f;
    --region: #ff6ab2;

    --sev-high-bg: #2a1614;
    --sev-med-bg: #2a2212;
    --sev-low-bg: #1c1f1e;
    --added-bg: #10241a;

    --shot-bg: #0b0d0c;
  }
}

:root[data-theme="dark"] {
  --bg: #101211;
  --bg-panel: #171a19;
  --bg-sunken: #0b0d0c;
  --bg-hover: #212523;
  --bg-active: #2b302e;
  --fg: #e4e6e4;
  --fg-dim: #9aa09c;
  --fg-faint: #6e756f;
  --line: #2a2f2c;
  --line-strong: #3d4441;
  --accent: #6ea8ff;
  --accent-fg: #06121f;

  --sev-high: #ff7b72;
  --sev-med: #e3b341;
  --sev-low: #9aa09c;
  --added: #56d364;
  --removed: #6e756f;
  --failed: #ff7b72;
  --identical: #6e756f;
  --region: #ff6ab2;

  --sev-high-bg: #2a1614;
  --sev-med-bg: #2a2212;
  --sev-low-bg: #1c1f1e;
  --added-bg: #10241a;

  --shot-bg: #0b0d0c;
}

* { box-sizing: border-box; }

html, body, #vdiff-root {
  height: 100%;
  margin: 0;
}

body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}

button, select, textarea, input {
  font: inherit;
  color: inherit;
}

button {
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 2px 7px;
  cursor: pointer;
}
button:hover { background: var(--bg-hover); }
button:active { background: var(--bg-active); }
button[aria-pressed="true"], button.is-on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-fg);
}
button:focus-visible, select:focus-visible, textarea:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

select {
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 2px 4px;
  max-width: 26ch;
}

.app {
  display: grid;
  grid-template-rows: auto auto 1fr;
  height: 100%;
  min-height: 0;
}

/* ---------------------------------------------------------------- header */

.header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-panel);
}
.header .brand {
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--fg-dim);
}
.spacer { flex: 1 1 auto; }
.field { display: flex; align-items: center; gap: 5px; }
.field > label { color: var(--fg-dim); }

.run-pick { display: flex; align-items: center; gap: 5px; }
.run-meta { color: var(--fg-dim); white-space: nowrap; }
.sha { color: var(--fg); }
.badge {
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  padding: 0 4px;
  font-size: 11px;
  color: var(--fg-dim);
  white-space: nowrap;
}
.badge.dirty { color: var(--sev-med); border-color: var(--sev-med); }
.badge.unstable { color: var(--sev-high); border-color: var(--sev-high); }
.badge.pruned { color: var(--fg-faint); }
.badge.pinned { color: var(--accent); border-color: var(--accent); }
/* A mock-only run has no recording behind it, so it is badged as loudly as an unstable one. */
.badge.mock { color: var(--sev-high); border-color: var(--sev-high); }
.badge.scenario { color: var(--accent); border-color: var(--accent); }
/*
 * A variant run is a proposal, not a regression capture. It is badged as plainly as a scenario —
 * loud enough that nobody mistakes it for the shipped UI, calm enough that it does not read as a
 * fault, because producing one is the ordinary use of the feature (D24).
 */
.badge.variant { color: var(--accent); border-color: var(--accent); }
.badge.kept { color: var(--fg-dim); }

.live { display: flex; align-items: center; gap: 5px; color: var(--fg-dim); }
.live .dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--fg-faint);
}
.live.on .dot { background: var(--added); }
.live.off .dot { background: var(--sev-high); }

.pending {
  border-color: var(--accent);
  color: var(--accent);
  background: transparent;
}

/* ---------------------------------------------------------------- filmstrip */

.filmstrip {
  display: flex;
  gap: 6px;
  padding: 6px 10px;
  overflow-x: auto;
  border-bottom: 1px solid var(--line);
  background: var(--bg-sunken);
  scrollbar-width: thin;
}

.cell {
  position: relative;
  flex: 0 0 auto;
  width: 116px;
  padding: 3px;
  text-align: left;
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: 3px;
}
.cell:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.cell[aria-current="true"] {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.cell.v-removed { border-style: dashed; opacity: 0.72; }
.cell.v-failed { border-color: var(--failed); }
.cell.v-added { border-color: var(--added); }
.cell.v-identical { opacity: 0.66; }
.cell.v-blocked { opacity: 0.5; }

.cell .thumb {
  display: block;
  width: 100%;
  height: 68px;
  object-fit: cover;
  object-position: top center;
  background: var(--shot-bg);
  border: 1px solid var(--line);
  border-radius: 2px;
}
.cell .thumb.empty {
  display: grid;
  place-items: center;
  color: var(--fg-faint);
  font-size: 16px;
}
.cell .name {
  display: block;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cell .sub { color: var(--fg-faint); font-size: 11px; }

.cell-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  min-width: 17px;
  padding: 0 4px;
  text-align: center;
  border-radius: 9px;
  border: 1px solid var(--line-strong);
  background: var(--bg-panel);
  color: var(--fg-dim);
  font-size: 11px;
  line-height: 15px;
}
.cell-badge.b-changed { border-color: var(--sev-med); color: var(--sev-med); }
.cell-badge.b-changed.s-high { border-color: var(--sev-high); color: var(--sev-high); }
.cell-badge.b-failed { border-color: var(--failed); color: var(--failed); }
.cell-badge.b-added { border-color: var(--added); color: var(--added); }
.cell-badge.b-removed { border-style: dashed; }
.cell-badge.b-identical { color: var(--identical); }

/* ---------------------------------------------------------------- body layout */

.main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 330px;
  min-height: 0;
}
@media (max-width: 900px) {
  .main { grid-template-columns: minmax(0, 1fr); }
  .rail { border-left: 0; border-top: 1px solid var(--line); }
}

.focus {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 5px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-panel);
}
.toolbar .group { display: flex; gap: 4px; align-items: center; }
.toolbar .note { color: var(--fg-dim); }
.toolbar input[type="range"] { width: 120px; accent-color: var(--accent); }

.stage {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 10px;
  background: var(--bg-sunken);
}

.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  align-items: start;
}
.pair.single { grid-template-columns: 1fr; }

.shot { min-width: 0; }
.shot > figcaption {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--fg-dim);
  padding-bottom: 3px;
}
.canvas {
  position: relative;
  background: var(--shot-bg);
  border: 1px solid var(--line);
  border-radius: 3px;
  overflow: hidden;
}
.canvas img { display: block; width: 100%; height: auto; }
.canvas.empty {
  display: grid;
  place-items: center;
  min-height: 160px;
  color: var(--fg-faint);
}

/* region boxes over the head image */
.regions { position: absolute; inset: 0; }
.region {
  position: absolute;
  padding: 0;
  background: transparent;
  border: 1px solid var(--region);
  border-radius: 0;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
  cursor: pointer;
}
.region:hover { background: color-mix(in srgb, var(--region) 18%, transparent); }
.region.selected {
  border-width: 2px;
  background: color-mix(in srgb, var(--region) 22%, transparent);
}
.region > .tag {
  position: absolute;
  top: -1px;
  left: -1px;
  transform: translateY(-100%);
  background: var(--region);
  color: #fff;
  font-size: 10px;
  line-height: 13px;
  padding: 0 3px;
  white-space: nowrap;
}

/* overlay + swipe */
.overlay-stack { position: relative; }
.overlay-stack .over {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.overlay-stack .over img { width: 100%; height: auto; display: block; }

.swipe { position: relative; user-select: none; touch-action: none; cursor: ew-resize; }
/* The head image stays full width and is clipped, so the divider never squashes it. */
.swipe .clip { position: absolute; inset: 0; }
.swipe .clip img { width: 100%; height: auto; display: block; }
.swipe .divider {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--region);
}
.swipe .divider::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 13px;
  height: 26px;
  transform: translate(-50%, -50%);
  border: 1px solid var(--region);
  border-radius: 3px;
  background: var(--bg-panel);
}

/* ---------------------------------------------------------------- right rail */

.rail {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-left: 1px solid var(--line);
  background: var(--bg-panel);
  overflow: auto;
}
.rail section { border-bottom: 1px solid var(--line); }
.rail h2 {
  margin: 0;
  padding: 5px 10px;
  font-size: 11px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--fg-dim);
  background: var(--bg-sunken);
  position: sticky;
  top: 0;
  z-index: 1;
}
.rail .empty { padding: 10px; color: var(--fg-faint); }

.sev-group > h3 {
  margin: 0;
  padding: 3px 10px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.sev-group.high > h3 { color: var(--sev-high); background: var(--sev-high-bg); }
.sev-group.med > h3 { color: var(--sev-med); background: var(--sev-med-bg); }
.sev-group.low > h3 { color: var(--sev-low); background: var(--sev-low-bg); }

.finding {
  border-top: 1px solid var(--line);
  padding: 5px 10px;
}
.finding:first-child { border-top: 0; }
.finding.selected { background: var(--bg-hover); }
.finding .row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  background: transparent;
  border: 0;
  padding: 0;
  text-align: left;
}
.finding .kind {
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  padding: 0 3px;
  font-size: 10px;
  color: var(--fg-dim);
  text-transform: uppercase;
}
.finding .sel {
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.finding .label { flex: 1 1 auto; }
.finding .caret { color: var(--fg-faint); }

.changes {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
  border-left: 2px solid var(--line);
}
.changes li {
  display: grid;
  grid-template-columns: minmax(0, 10ch) minmax(0, 1fr);
  gap: 6px;
  padding: 1px 0 1px 6px;
}
.changes .prop { color: var(--fg-dim); overflow: hidden; text-overflow: ellipsis; }
.changes .from { color: var(--sev-high); }
.changes .to { color: var(--added); }
.changes .arrow { color: var(--fg-faint); padding: 0 3px; }

.finding .actions { display: flex; gap: 6px; margin-top: 4px; }
.finding .crop { max-width: 100%; border: 1px solid var(--line); margin-top: 4px; display: block; }

/* ---------------------------------------------------------------- warnings, feedback, misc */

.warnings { padding: 6px 10px; display: grid; gap: 4px; }
.warn {
  display: flex;
  gap: 6px;
  align-items: baseline;
  border-left: 2px solid var(--sev-med);
  padding-left: 6px;
  color: var(--fg-dim);
}
.warn.high { border-color: var(--sev-high); }
.warn code { color: var(--fg); word-break: break-all; }
.warn code.rules { color: var(--accent); }

/* ------------------------------------------------------------- scenarios (mocking §6, §8) */

/*
 * Banners sit above the images, not beside them: they change what every finding below them means,
 * so a reader who never glances at the right rail must still have seen them.
 */
.pair-banners { display: grid; gap: 4px; margin: 10px 10px 0; }
.pair-banner {
  display: flex;
  gap: 6px;
  align-items: baseline;
  border: 1px solid var(--line-strong);
  border-left-width: 3px;
  border-radius: 3px;
  padding: 6px 8px;
  background: var(--bg-panel);
}
.pair-banner.med { border-left-color: var(--sev-med); }
.pair-banner.med .badge { color: var(--sev-med); border-color: var(--sev-med); }
.pair-banner.high { border-left-color: var(--sev-high); }
.pair-banner.high .badge { color: var(--sev-high); border-color: var(--sev-high); }

/* Attribution is step-local, so it renders with the step rather than in the warnings rail. */
.scenario-notes { display: grid; gap: 3px; margin: 8px 10px 0; }
.scenario-note {
  display: flex;
  gap: 6px;
  align-items: baseline;
  border-left: 2px solid var(--accent);
  padding-left: 6px;
  color: var(--fg-dim);
}
.scenario-note.high { border-left-color: var(--sev-high); }
.scenario-note code { color: var(--fg); word-break: break-all; }

/* ------------------------------------------------------------- variants (§5, §7) */

/*
 * The proposal banner. "note" is a severity of its own rather than a reuse of "med", because the
 * pairing it describes is the normal result of running a variant: it states what was compared,
 * without the stripe that means "the findings below are not what they look like".
 */
.pair-banner.note { border-left-color: var(--accent); }
.pair-banner.note .badge { color: var(--accent); border-color: var(--accent); }

/* Variant attribution is step-local, exactly as scenario attribution is, and renders beside it. */
.variant-notes { display: grid; gap: 3px; margin: 8px 10px 0; }
.variant-note {
  display: flex;
  gap: 6px;
  align-items: baseline;
  border-left: 2px solid var(--accent);
  padding-left: 6px;
  color: var(--fg-dim);
}
.variant-note code { color: var(--fg); word-break: break-all; }
.variant-note .badge.verb { color: var(--accent); border-color: var(--accent); }

.feedback {
  position: fixed;
  right: 12px;
  bottom: 12px;
  width: 340px;
  max-width: calc(100vw - 24px);
  background: var(--bg-panel);
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  padding: 8px;
  display: grid;
  gap: 6px;
  z-index: 10;
}
.feedback header { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.feedback textarea {
  width: 100%;
  min-height: 74px;
  resize: vertical;
  background: var(--bg-sunken);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 5px;
}
.feedback .target { color: var(--fg-dim); word-break: break-all; }
.feedback .row { display: flex; gap: 6px; justify-content: flex-end; align-items: center; }
.feedback img { max-width: 100%; border: 1px solid var(--line); }

.notice {
  margin: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line-strong);
  border-left-width: 3px;
  border-radius: 3px;
  background: var(--bg-panel);
}
.notice.error { border-left-color: var(--sev-high); }
.notice pre {
  margin: 6px 0 0;
  padding: 6px;
  background: var(--bg-sunken);
  border-radius: 3px;
  overflow-x: auto;
}

.tabs { display: flex; gap: 4px; }
.legend { display: flex; gap: 8px; color: var(--fg-faint); flex-wrap: wrap; }
.legend kbd {
  border: 1px solid var(--line-strong);
  border-bottom-width: 2px;
  border-radius: 3px;
  padding: 0 3px;
  color: var(--fg-dim);
}
.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* ------------------------------------------------------------- e2e (§4, §7, D27) */

/*
 * An ingested run is badged as loudly as a mock-only one, and for the same reason: what is on the
 * screen was produced by machinery this tool did not control, so "the page looks like this" is a
 * weaker claim than it is anywhere else. It is not, however, a *fault* — ingesting is the ordinary
 * use of the feature — so it takes the accent rather than the high-severity colour.
 */
.badge.e2e { color: var(--accent); border-color: var(--accent); }

/*
 * The revision an ingested run could not be attributed to. Faint on purpose: nothing is wrong, the
 * trace simply carries no git metadata, and this is the honest statement of that (§7, §8).
 */
.badge.unknown-revision { color: var(--fg-faint); }

/*
 * The reduced-detail explanation, rendered as a list under the source banner rather than as one
 * long sentence. §4 requires the degradation to be explained rather than met as a disappointment,
 * and three separate things a reader would otherwise mis-read as a defect do not fit in one line.
 */
.pair-banner-details {
  display: grid;
  gap: 2px;
  margin: 4px 0 0;
  padding-left: 16px;
  color: var(--fg-dim);
}
.pair-banner-details li { list-style: disc; }

/*
 * The "this layer could not run" note, shown where a findings section would otherwise be silently
 * empty. It sits in the empty space it explains, so an empty style section on an e2e pair reads as
 * a capability limit rather than as a clean bill of health.
 */
.unavailable-kind {
  border-left: 2px solid var(--line-strong);
  padding-left: 6px;
  color: var(--fg-faint);
}
`;
