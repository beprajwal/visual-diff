/**
 * What a pair *is*, when it is not an ordinary revision-to-revision comparison: the two scenario
 * pairings the tool permits but refuses to let pass as regressions (mocking spec §6), and the three
 * a variant produces (variants spec §5).
 *
 * Banners rather than entries in the warnings rail, and above the images rather than beside them,
 * because they change what every finding below them *means*. A reader who scrolls straight to a red
 * region and never glances right has still been told that the "regression" they are looking at is
 * the difference between two states, between a fiction and a measurement — or between the page and
 * a proposal for it.
 *
 * The variant row is deliberately the calm one. For a variant run, "same revision, variant versus
 * none" *is* the question (D24), so it is stated at `note` severity and carries no warning stripe.
 * Dressing the normal case as an anomaly is how a banner strip stops being read at all.
 *
 * The source axis adds the fourth and fifth (e2e spec §4, D27), and it is the one that carries a
 * *sub-list*. An e2e pair is not confounded — it is the regression question on the ingested timeline
 * — but the diff beneath it genuinely cannot say everything a replay diff can, so the row states the
 * comparison and then spells out what is missing and why. §4's whole requirement is that the reduced
 * detail be explained rather than discovered as a disappointment, and a report that quietly shows
 * fewer findings reads as a report that missed them.
 *
 * The wording and the severity are {@link pairBanners}, {@link variantBanners} and
 * {@link sourceBanners}; this file is the markup.
 */

import type { DiffResult } from '../../../types.js';
import { pairBanners, sourceBanners, variantBanners } from '../derive.js';

export interface PairBannerProps {
  diff: DiffResult | null;
}

export function PairBanner({ diff }: PairBannerProps) {
  const rows = [
    ...pairBanners(diff).map((row) => ({ ...row, details: [] as readonly string[] })),
    ...variantBanners(diff).map((row) => ({ ...row, details: [] as readonly string[] })),
    ...sourceBanners(diff),
  ];
  if (rows.length === 0) return null;

  return (
    <div class="pair-banners">
      {rows.map((row) => (
        <div class={`pair-banner ${row.severity}`} key={row.label} role="note">
          <span class="badge">{row.label}</span>
          <span>
            {row.message}
            {row.details.length === 0 ? null : (
              <ul class="pair-banner-details">
                {row.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
