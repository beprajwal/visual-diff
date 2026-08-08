import { describe, expect, it } from 'vitest';

import { KEY_BINDINGS, isTypingTarget, resolveKey } from './keys.js';

describe('KEY_BINDINGS', () => {
  it('binds every key exactly once', () => {
    const keys = KEY_BINDINGS.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('binds every action exactly once', () => {
    const actions = KEY_BINDINGS.map((b) => b.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('covers the spec §9 shortcut list', () => {
    const map = Object.fromEntries(KEY_BINDINGS.map((b) => [b.key, b.action]));
    expect(map['j']).toBe('step-next');
    expect(map['k']).toBe('step-prev');
    expect(map['[']).toBe('run-older');
    expect(map[']']).toBe('run-newer');
    expect(map['o']).toBe('toggle-overlay');
    expect(map['f']).toBe('toggle-findings-only');
  });
});

describe('resolveKey', () => {
  it('resolves the navigation keys', () => {
    expect(resolveKey({ key: 'j' })).toBe('step-next');
    expect(resolveKey({ key: 'k' })).toBe('step-prev');
    expect(resolveKey({ key: '[' })).toBe('run-older');
    expect(resolveKey({ key: ']' })).toBe('run-newer');
    expect(resolveKey({ key: 'o' })).toBe('toggle-overlay');
    expect(resolveKey({ key: 'f' })).toBe('toggle-findings-only');
    expect(resolveKey({ key: 'Escape' })).toBe('dismiss');
  });

  it('ignores unbound keys', () => {
    expect(resolveKey({ key: 'q' })).toBeNull();
    expect(resolveKey({ key: 'ArrowDown' })).toBeNull();
  });

  it('never steals modifier chords', () => {
    expect(resolveKey({ key: 'f', metaKey: true })).toBeNull();
    expect(resolveKey({ key: 'f', ctrlKey: true })).toBeNull();
    expect(resolveKey({ key: 'o', altKey: true })).toBeNull();
  });

  it('does not treat a shifted single character as its lowercase binding', () => {
    expect(resolveKey({ key: 'J', shiftKey: true })).toBeNull();
    expect(resolveKey({ key: 'j', shiftKey: true })).toBeNull();
  });

  it('suppresses shortcuts while a text field has focus, except dismiss', () => {
    const target = { tagName: 'TEXTAREA' };
    expect(resolveKey({ key: 'j', target })).toBeNull();
    expect(resolveKey({ key: 'f', target })).toBeNull();
    expect(resolveKey({ key: 'Escape', target })).toBe('dismiss');
  });

  it('treats contenteditable as a text field', () => {
    expect(resolveKey({ key: 'j', target: { tagName: 'DIV', isContentEditable: true } })).toBeNull();
    expect(resolveKey({ key: 'j', target: { tagName: 'DIV' } })).toBe('step-next');
  });
});

describe('isTypingTarget', () => {
  it('matches text entry surfaces case-insensitively', () => {
    expect(isTypingTarget({ tagName: 'input' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });
});
