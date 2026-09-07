/**
 * ci/review-render — a stored review as markdown (CI spec D39).
 *
 * A leaf, like `gate.ts` and `layout.ts`: pure functions over a `Review`, no `node:fs`, no client.
 * The comment renderer imports it, and so does the CLI for `vdiff review`'s human output — both
 * without crossing the lazy `ci` edge that holds the HTTP client (`cli/deps.ts`). One renderer
 * for both surfaces is also the point: what the terminal prints is what the pull request shows.
 */

import type { Review, ReviewChange, ReviewProvider } from '../types.js';

export const ASSESSMENT_MARK: Readonly<Record<ReviewChange['assessment'], string>> = {
  expected: '✅',
  unrelated: '⚠️',
  regression: '🔴',
  unclear: '❔',
};

const ASSESSMENT_WORD: Readonly<Record<ReviewChange['assessment'], string>> = {
  expected: 'expected',
  unrelated: 'not accounted for by this change',
  regression: 'looks like a regression',
  unclear: 'unclear',
};

export const PROVIDER_LABEL: Readonly<Record<ReviewProvider, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

/** Changes that a reader must not scroll past: the ones the description does not explain. */
export function flaggedChanges(review: Review): ReviewChange[] {
  return review.changes.filter(
    (change) => change.assessment === 'unrelated' || change.assessment === 'regression',
  );
}

/** One-line provenance, rendered wherever the review is: who wrote it and what it saw. */
export function reviewAttribution(review: Review): string {
  const saw =
    review.evidence.images > 0
      ? `findings.json and ${review.evidence.images} screenshot${review.evidence.images === 1 ? '' : 's'}`
      : 'findings.json only, no screenshots';
  const context = review.evidence.contextProvided
    ? 'with the pull request description'
    : 'without a description of the intended change';
  return (
    `Review by ${review.model} (${PROVIDER_LABEL[review.provider]}) from ${saw}, ${context}. ` +
    'It is a reading of the evidence, not a verdict.'
  );
}

export interface ReviewRenderOptions {
  /** Cap on change lines. The rest is counted. Default 12. */
  maxChanges?: number;
  /** Cap on concern lines. Default 6. */
  maxConcerns?: number;
}

/** Line safe: no newline inside a bullet or a heading can break the layout. */
function line(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').trim();
}

/**
 * The review as GitHub-flavoured markdown, in reading order: the headline, a warning when anything
 * is flagged, the summary, the ranked changes, the concerns, and who wrote it. Headed so it can
 * sit inside the comment after the verdict; the caller supplies the surrounding blank lines.
 */
export function reviewLines(review: Review, options: ReviewRenderOptions = {}): string[] {
  const maxChanges = options.maxChanges ?? 12;
  const maxConcerns = options.maxConcerns ?? 6;
  const flagged = flaggedChanges(review);
  const lines: string[] = [];

  lines.push('#### Review');
  lines.push('');
  lines.push(`**${line(review.headline)}**`);
  if (flagged.length > 0) {
    const n = flagged.length;
    lines.push('');
    lines.push(
      `> ⚠️ **${n} change${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} not accounted for by ` +
        `this pull request or look${n === 1 ? 's' : ''} like a regression** — flagged below.`,
    );
  }
  lines.push('');
  lines.push(line(review.summary));

  if (review.changes.length > 0) {
    lines.push('');
    const shown = review.changes.slice(0, maxChanges);
    for (const change of shown) {
      const where =
        change.viewport === null ? `\`${change.step}\`` : `\`${change.step}\` @ ${change.viewport}`;
      lines.push(
        `- ${ASSESSMENT_MARK[change.assessment]} ${where} — ${line(change.description)} ` +
          `_(${ASSESSMENT_WORD[change.assessment]})_`,
      );
    }
    const dropped = review.changes.length - shown.length;
    if (dropped > 0) {
      lines.push(`- … ${dropped} more change${dropped === 1 ? '' : 's'} in \`review.json\``);
    }
  }

  lines.push('');
  if (review.concerns.length === 0) {
    lines.push('_Nothing to raise beyond the changes listed._');
  } else {
    lines.push('**Look before merging:**');
    lines.push('');
    const shown = review.concerns.slice(0, maxConcerns);
    for (const concern of shown) lines.push(`- ⚠️ ${line(concern)}`);
    const dropped = review.concerns.length - shown.length;
    if (dropped > 0) lines.push(`- … ${dropped} more in \`review.json\``);
  }

  lines.push('');
  lines.push(`<sub>${reviewAttribution(review)}</sub>`);
  return lines;
}
