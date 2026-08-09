/**
 * Per-step scenario attribution (mocking spec §8): "response modified by `empty-forecast` rule
 * `forecast-empty`".
 *
 * Rendered against the *selected step* rather than in the warnings rail, because attribution is
 * step-local: the reason this screen looks like this is the rule that fired on this screen's
 * requests. A reader comparing an empty list against a full one needs the sentence next to the
 * empty list, not three sections away.
 *
 * Both ends of the pair are shown and labelled, because a cross-scenario pair was shaped by
 * different rules on each side and collapsing them would lose which side did what.
 *
 * The sentences are {@link scenarioNoteRows}; this file is the markup.
 */

import type { StepAttribution } from '../../attribution.js';
import { scenarioNoteRows } from '../derive.js';

export interface ScenarioNotesProps {
  /** Attribution for the selected step on each side; absent when the run had no scenario. */
  base?: StepAttribution | undefined;
  head?: StepAttribution | undefined;
}

export function ScenarioNotes({ base, head }: ScenarioNotesProps) {
  const rows = [...scenarioNoteRows('base', base), ...scenarioNoteRows('head', head)];
  if (rows.length === 0) return null;

  return (
    <div class="scenario-notes">
      {rows.map((row) => (
        <div class={`scenario-note${row.severity === 'high' ? ' high' : ''}`} key={row.key}>
          <span class="badge">{row.side}</span>
          <span>
            {row.text}
            {row.urls.length > 0 ? (
              <>
                {' '}
                <code>{row.urls.join(' ')}</code>
              </>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}
