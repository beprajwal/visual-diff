# Visual Tolerance Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the independent HTML report task;
> execute shared engine and PR integration locally. User approved the design in conversation.

**Goal:** Keep small differences inspectable while preventing them from becoming PR noise.

Enabled by default as requested: 0.3% unexplained pixels and 2 CSS pixels of layout movement.
Explicit 0 and 0.5px settings restore the previous sensitivity.

**Architecture:** Annotate raw results in the diff engine, then derive an immutable significant-only
projection for PR rendering, review and gates. Both report modes share the existing Preact app.

**Tech Stack:** TypeScript, Vitest, existing pixelmatch pipeline and Preact report.

### Task 1: Config and engine policy

- [x] Add regression tests in `src/diff/viewportDiff.test.ts` for `maxChangedPixelRatio: 0.003`,
  `layout: {enabled: true, tolerancePx: 2}`, inclusive boundaries, retained raw evidence and content
  exceptions. Add config validation and cache fingerprint tests.
- [x] Run `pnpm exec vitest run src/diff/viewportDiff.test.ts` and confirm the new assertions fail.
- [x] Add optional config/engine types and `withinTolerance?: boolean` on finding/viewport results.
  Validate and default in `src/store/config.ts`; pass through `src/diff/e2e-noise.ts`,
  `src/cli/commands/pair.ts`, `src/report/server/diff-service.ts`; fingerprint in `src/diff/cache.ts`.
- [x] Apply geometry policy in `src/diff/viewportDiff.ts`, counting residual pixels outside ignored
  and tolerated layout regions; preserve raw findings and percentage. Keep policy in a focused module.

### Task 2: Significant projection and PR surfaces

- [x] Add `src/diff/significance.test.ts` and comment/preview/review regression tests for pure minor
  and mixed changes. Assert raw input is unchanged and totals match visible findings.
- [x] Implement `significantDiff(result)` in `src/diff/significance.ts`; retain operational failures
  and structural step changes, filter tolerated findings and viewports, recompute summary.
- [x] Use projection in `src/ci/comment.ts`, `src/ci/preview-card.ts`, `src/ci/review.ts`, and gate
  callers. Prevent stale free-text reviews from reintroducing minor changes. Keep export evidence raw.
- [x] Run `pnpm exec vitest run src/ci src/diff/significance.test.ts`.

### Task 3: HTML report

- [x] Add pure derivation/state tests for minor cells and visibility before changing the app.
- [x] Add “within tolerance” labels and a show-minor toggle in `src/report/ui/`, shared by static
  and live report. Keep raw percentages and screenshots accessible and navigation coherent.
- [x] Run `pnpm exec vitest run src/report/ui` and inspect built report behavior.

### Task 4: Documentation and verification

- [x] Document settings, units, boundaries, defaults and PR/report semantics in `README.md` and
  generated config comments. Explain explicit readiness for loading states.
- [x] Run `pnpm typecheck`, `pnpm test:unit`, `pnpm build`, and `git diff --check`.
- [x] Review spec compliance and final diff, resolve issues, and report results and remaining limits.

## Validation record

Implemented on `feat/visual-tolerance`. Tests covered raw evidence retention, inclusive pixel and
CSS-pixel boundaries, subpixel geometry, masked content, moved-container repaints, resized images,
small semantic edits below the region floor, consumer caches, filtered PR counts, AI input,
preview capture fingerprints, and report visibility/navigation. Typecheck and build pass.
The complete unit suite runs with local browser/server access; the sandbox-only attempt was unable
to bind localhost or launch Chromium. A real Chromium report smoke check verified both report
visibility states and keyboard navigation. Final review found no remaining material issues.
