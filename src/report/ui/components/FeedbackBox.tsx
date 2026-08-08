/**
 * Comment box opened by clicking a region or a finding (spec §9, D6).
 *
 * It POSTs one JSON object to `/api/feedback`, which the server appends to
 * `feedback/pending.jsonl` for an agent to read back with `vdiff feedback --json --ack`. It never
 * asks the server to execute anything — that constraint is the whole point of D6.
 */

import { useEffect, useRef, useState } from 'preact/hooks';

import type { FeedbackTarget } from '../state.js';

export interface FeedbackBoxProps {
  target: FeedbackTarget;
  pair: string;
  flow: string;
  saving: boolean;
  cropUrl: string | null;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

export function FeedbackBox({
  target,
  pair,
  flow,
  saving,
  cropUrl,
  onSubmit,
  onCancel,
}: FeedbackBoxProps) {
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    field.current?.focus();
  }, [target]);

  const trimmed = text.trim();

  const submit = (): void => {
    if (trimmed.length === 0 || saving) return;
    onSubmit(trimmed);
  };

  return (
    <div class="feedback" role="dialog" aria-label="leave a comment">
      <header>
        <strong>comment</strong>
        <span class="target">
          {flow} · {pair}
        </span>
      </header>

      <div class="target">
        {target.label}
        {target.step ? ` · ${target.step}` : ''}
        {target.viewport ? ` · ${target.viewport}` : ''}
        {target.region
          ? ` · ${target.region.w}×${target.region.h} @ ${target.region.x},${target.region.y}`
          : ''}
      </div>
      {target.element ? <div class="target">{target.element}</div> : null}
      {cropUrl ? <img src={cropUrl} alt="the region this comment points at" /> : null}

      <textarea
        ref={field}
        value={text}
        placeholder="what should change, and why"
        onInput={(event: Event) => setText((event.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />

      <div class="row">
        <span class="target">⌘↵ to send</span>
        <button type="button" onClick={onCancel}>
          cancel
        </button>
        <button
          type="button"
          class="is-on"
          disabled={trimmed.length === 0 || saving}
          onClick={submit}
        >
          {saving ? 'sending…' : 'send'}
        </button>
      </div>
    </div>
  );
}
