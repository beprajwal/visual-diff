# AI assessment of visual noise

Approved in conversation: extend the existing review call to assess likely capture noise, omit
supported noise from PR comments and previews, retain uncertain findings and full HTML evidence,
and keep CI gates based on measured thresholds.

The model returns structured finding and viewport assessments: meaningful, capture-noise,
uncertain, or capture-incomplete, with high/low confidence and a short evidence-based reason.
Capture-incomplete assessments become visible readiness concerns, never a clean result.
Use the existing single provider call; no additional model request or reasoning transcript.

Only exact, unambiguous IDs included in the prompt may receive finding assessments. Record the
actual base/head screenshot pairs supplied to the model. Missing images, omitted evidence,
unknown or duplicate assessments, stale reviews, and provider failures grant no suppression.
Only high-confidence capture-noise assessments can hide pixel-only or layout findings; preserve
high-severity, semantic, accessibility, structural, missing-shot and operational findings.
Any incomplete capture in a view prevents suppression there. A viewport is omitted only when
its own assessment is high-confidence capture noise and every finding can be omitted. Uncertain
or unreviewed pixels remain visible, including in mixed viewports. Contradictory reported changes
prevent a viewport from being dismissed as noise.

Keep AI decisions separate from measured within-tolerance annotations. A shared PR projection
filters findings and fully reviewed noise-only viewports and recomputes visible counts. Gates
continue to evaluate the threshold projection, and the comment explicitly explains any AI
exclusions without claiming that the screenshots were identical. Previews bind to the current
review assessment as well as the diff; a missing or stale stamp cannot reuse a filtered image.

The exported HTML and JSON retain the complete diff. The HTML review panel exposes the model's
assessments and reasons, including readiness concerns. Legacy reviews without assessments keep
their existing advisory behavior. When screenshots are unavailable the model may still describe
findings, but its assessment cannot hide any of them.
