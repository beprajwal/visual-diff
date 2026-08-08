/**
 * Keyboard map as a pure table, so the bindings from spec §9 are testable without a DOM.
 *
 *   j / k   step navigation
 *   [ / ]   iteration navigation (older / newer run)
 *   o       overlay view toggle
 *   f       findings-only filter
 *
 * `Escape` is added beyond the spec list purely to dismiss the feedback box and the finding
 * selection; it is the one binding that also fires while the user is typing.
 */

export type KeyActionType =
  | 'step-next'
  | 'step-prev'
  | 'run-older'
  | 'run-newer'
  | 'toggle-overlay'
  | 'toggle-findings-only'
  | 'dismiss';

export interface KeyBinding {
  /** Exact `KeyboardEvent.key` value. */
  key: string;
  action: KeyActionType;
  /** Rendered in the shortcut legend. */
  label: string;
  description: string;
  /** Bindings that still fire while a text field has focus. */
  whileTyping: boolean;
}

export const KEY_BINDINGS: readonly KeyBinding[] = [
  { key: 'j', action: 'step-next', label: 'j', description: 'next step', whileTyping: false },
  { key: 'k', action: 'step-prev', label: 'k', description: 'previous step', whileTyping: false },
  {
    key: '[',
    action: 'run-older',
    label: '[',
    description: 'older iteration',
    whileTyping: false,
  },
  {
    key: ']',
    action: 'run-newer',
    label: ']',
    description: 'newer iteration',
    whileTyping: false,
  },
  {
    key: 'o',
    action: 'toggle-overlay',
    label: 'o',
    description: 'overlay view',
    whileTyping: false,
  },
  {
    key: 'f',
    action: 'toggle-findings-only',
    label: 'f',
    description: 'findings only',
    whileTyping: false,
  },
  {
    key: 'Escape',
    action: 'dismiss',
    label: 'esc',
    description: 'close comment / clear selection',
    whileTyping: true,
  },
];

/** The subset of `KeyboardEvent` this module needs, so tests need no DOM. */
export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: KeyEventTargetLike | null;
}

export interface KeyEventTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** True when the event originated inside a text entry surface. */
export function isTypingTarget(target: KeyEventTargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable === true) return true;
  const tag = target.tagName;
  return typeof tag === 'string' && TYPING_TAGS.has(tag.toUpperCase());
}

const BY_KEY: ReadonlyMap<string, KeyBinding> = new Map(KEY_BINDINGS.map((b) => [b.key, b]));

/**
 * Resolves one key event to an action, or null when nothing is bound.
 *
 * Modifier chords are never bound — the browser and the OS own those — and single-character
 * bindings are skipped when Shift is held so `J` does not act as `j`.
 */
export function resolveKey(ev: KeyEventLike): KeyActionType | null {
  if (ev.ctrlKey === true || ev.metaKey === true || ev.altKey === true) return null;
  const binding = BY_KEY.get(ev.key);
  if (!binding) return null;
  if (ev.shiftKey === true && binding.key.length === 1) return null;
  if (isTypingTarget(ev.target) && !binding.whileTyping) return null;
  return binding.action;
}
