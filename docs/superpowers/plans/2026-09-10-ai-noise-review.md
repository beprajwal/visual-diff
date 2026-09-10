# AI noise review implementation plan

1. Add regression tests and shared types for bounded finding/viewport assessments and actual
   paired-image evidence. Extend the existing model schema/prompt/parser and persist decisions.
2. Implement a shared, immutable PR projection with conservative eligibility, evidence matching,
   stale/contradictory assessment handling, and review-dependent preview fingerprints.
3. Integrate comments, previews, export and CLI preview validation. Keep gates on deterministic
   thresholds; show readiness concerns and retain raw HTML/JSON evidence with assessment reasons.
4. Document behavior, run targeted regressions, typecheck, build and relevant full suites. Review
   the final diff independently and address substantive findings before completion.
