/**
 * Per-step variant attribution (variants spec §7): "element modified by `denser-forecast` rule
 * `tighter-cards`".
 *
 * Rendered against the *selected step* rather than in the warnings rail, for the same reason the
 * scenario notes are: attribution is step-local. The reason this screen looks like this is the rule
 * that fired on this screen's elements, and a reader comparing a tighter layout against the
 * original needs the sentence next to the picture, not three sections away.
 *
 * Both ends of the pair are shown and labelled. For the ordinary proposal pair only one side has
 * anything to say — the other is the unmodified page, which is the point — and for a cross-variant
 * pair the two sides were shaped by different rules, so collapsing them would lose which did what.
 *
 * The verb rides beside the sentence as a tag rather than being conjugated into it, so the sentence
 * a reader learns to scan for is the same one whatever the rule did.
 *
 * The sentences are {@link variantNoteRows}; this file is the markup.
 */

import type { StepVariantAttribution } from '../../variant.js';
import { variantNoteRows } from '../derive.js';

export interface VariantNotesProps {
  /** Attribution for the selected step on each side; absent when the run had no variant. */
  base?: StepVariantAttribution | undefined;
  head?: StepVariantAttribution | undefined;
}

export function VariantNotes({ base, head }: VariantNotesProps) {
  const rows = [...variantNoteRows('base', base), ...variantNoteRows('head', head)];
  if (rows.length === 0) return null;

  return (
    <div class="variant-notes">
      {rows.map((row) => (
        <div class="variant-note" key={row.key}>
          <span class="badge">{row.side}</span>
          <span class="badge verb">{row.verb}</span>
          <span>
            {row.text}
            {row.viewports.length > 0 ? (
              <>
                {' '}
                <code>{row.viewports.join(' ')}</code>
              </>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}
