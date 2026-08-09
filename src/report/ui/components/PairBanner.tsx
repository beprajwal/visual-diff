/**
 * The two pairings the tool permits but refuses to let pass as ordinary regressions
 * (mocking spec §6).
 *
 * Banners rather than entries in the warnings rail, and above the images rather than beside them,
 * because they change what every finding below them *means*. A reader who scrolls straight to a red
 * region and never glances right has still been told that the "regression" they are looking at is
 * the difference between two states, or between a fiction and a measurement.
 *
 * The wording and the severity are {@link pairBanners}; this file is the markup.
 */

import type { DiffResult } from '../../../types.js';
import { pairBanners } from '../derive.js';

export interface PairBannerProps {
  diff: DiffResult | null;
}

export function PairBanner({ diff }: PairBannerProps) {
  const rows = pairBanners(diff);
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
