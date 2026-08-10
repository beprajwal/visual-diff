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
 * The wording and the severity are {@link pairBanners} and {@link variantBanners}; this file is the
 * markup.
 */

import type { DiffResult } from '../../../types.js';
import { pairBanners, variantBanners } from '../derive.js';

export interface PairBannerProps {
  diff: DiffResult | null;
}

export function PairBanner({ diff }: PairBannerProps) {
  const rows = [...pairBanners(diff), ...variantBanners(diff)];
  if (rows.length === 0) return null;

  return (
    <div class="pair-banners">
      {rows.map((row) => (
        <div class={`pair-banner ${row.severity}`} key={row.label} role="note">
          <span class="badge">{row.label}</span>
          <span>{row.message}</span>
        </div>
      ))}
    </div>
  );
}
