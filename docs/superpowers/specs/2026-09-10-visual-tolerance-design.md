# Visual tolerance and selective PR comments

Status: implemented and verified.

The user approved separate pixel and layout tolerances, with minor changes retained in the HTML
report and omitted from the PR comment, its counts, previews, and AI summary.

## Contract

`diff.maxChangedPixelRatio` is a fraction from 0 through 1. A value of `0.003` tolerates up to and
including 0.3% unexplained changed pixels outside masks and ignores. `diff.layout.enabled` controls
whether geometry changes warrant attention; `diff.layout.tolerancePx` tolerates movement and resize
on every axis up to and including the specified CSS-pixel distance. The user approved enabling
the defaults: 0.003 and 2px, with layout enabled. Explicit 0 and 0.5px restore previous sensitivity.

Keep the raw percentage, regions, images, and findings. Mark tolerated findings and viewports with
`withinTolerance: true`. Confirmed content, style, structural and accessibility findings still
warrant attention below the pixel allowance. Geometry explained solely by tolerated layout must
not reappear as an unexplained pixel flag. Compare remaining pixels after excluding those layout
regions to the pixel allowance. Confirm unchanged relative image content before excluding geometry
regions; unexplained repaints remain significant. Store significant pixel/dimension measurements
alongside the raw values so a mixed viewport does not inflate the PR percentage. Page dimensions use the layout control, too. Imported traces cannot
classify layout without geometry and continue to use pixel evidence.

All PR-facing renderers use a shared, immutable projection of significant findings and viewports.
That projection recomputes counts and percentages, drops tolerated steps from comment tables and
previews, and limits AI evidence and prompt content. Stale AI reviews must not reintroduce omitted
changes. Only-tolerated comparisons say “No changes above the configured thresholds” and link to
the full report. Failed, blocked, added, removed, and spec-changed steps remain visible. CI gates
evaluate significant findings; full stored evidence remains available in the HTML/JSON report.

The HTML report labels tolerated changes “within tolerance” and offers a show-minor-changes toggle.
It must distinguish tolerated from identical, and changing visibility must leave navigation usable.

Strictly validate config, pass it through CLI/live server, and include effective settings in cache
keys. Existing stored results without tolerance metadata retain their existing behavior when
viewed directly, but are recomputed when requested under the enabled defaults.

Capture readiness is separate: this change does not infer skeleton/loading states from percentages.
Existing explicit readiness conditions and capture warnings continue to supply that evidence.

## Verification

Test inclusive boundaries, masks, small real text edits, significant and tolerated geometry,
mixed geometry/pixel changes, disabled findings, dimension-only changes, old results, cache changes,
PR counters/tables/previews/reviews/gates, and report visibility. Run typecheck, unit suite and build.
