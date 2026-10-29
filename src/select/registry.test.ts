import { describe, expect, it } from 'vitest';

import { cssNames, enclosingSelectors, registryNames } from './registry.js';

const added = (text: string, line = 1) => ({ text, line, side: '+' as const });
const removed = (text: string, line = 1) => ({ text, line, side: '-' as const });

describe('registryNames', () => {
  const keys = "([A-Z][A-Z0-9_]+):\\s*'([a-z0-9-]+)'|'([a-z0-9-]+)'|^export type FlagKey\\b";

  it('takes every capture of every changed line, and skips blanks and comments', () => {
    expect(
      registryNames(
        [added("  ORDERS_V2: 'orders-v2',"), added("  | 'orders-v2'"), added(''), added('  /** Orders. */'), added('   * more')],
        keys,
      ),
    ).toEqual(['ORDERS_V2', 'orders-v2']);
  });

  it('is null for a line of code the pattern does not describe', () => {
    expect(registryNames([added("  ORDERS_V2: 'orders-v2',"), added('export const x = 1')], keys)).toBeNull();
  });

  it('cancels what both sides write identically, so a one-line list touches only its new key', () => {
    expect(
      registryNames(
        [removed("export type FlagKey = 'a' | 'b'"), added("export type FlagKey = 'a' | 'b' | 'c'")],
        keys,
      ),
    ).toEqual(['c']);
  });

  it('keeps every capture of a match whose value changed', () => {
    expect(
      registryNames([removed("  ORDERS_V2: 'orders-v2',"), added("  ORDERS_V2: 'orders-next',")], keys),
    ).toEqual(['ORDERS_V2', 'orders-next', 'orders-v2']);
  });
});

describe('enclosingSelectors', () => {
  it('tracks nesting, at-rules and comments with braces in them', () => {
    const source = ['/* { not a rule */', '@media (min-width: 1px) {', '  .a .b, .c {', '    color: red;', '  }', '}', 'p { x: 1 }'].join('\n');
    const lines = enclosingSelectors(source);
    expect(lines[0]).toEqual([]);
    expect(lines[3]).toEqual(['@media (min-width: 1px)', '.a .b, .c']);
    // A line's state is where it starts: the brace closing the @media block sits inside it.
    expect(lines[5]).toEqual(['@media (min-width: 1px)']);
    expect(lines[6]).toEqual(['p']);
  });
});

describe('cssNames', () => {
  const source = ['.badge,', '.chip:hover {', '  color: red;', '}', '', ':root {', '  --x: 1;', '}'].join('\n');

  it('names the classes of the rule a property sits in', () => {
    expect(cssNames(source, [added('  color: blue;', 3)])).toEqual(['badge', 'chip']);
  });

  it('names the classes a removed rule wrote, though the head no longer has it', () => {
    expect(cssNames('', [removed('.gone {'), removed('  x: 1;')])).toBeNull();
    expect(cssNames('', [removed('.gone {')])).toEqual(['gone']);
  });

  it('is null under a rule with no class', () => {
    expect(cssNames(source, [added('  --x: 2;', 7)])).toBeNull();
  });

  it('reads comment prose as no change, added or removed', () => {
    const commented = ['.badge {', '  /* why the badge', '     is red */', '  color: red;', '}'].join('\n');
    expect(cssNames(commented, [added('     is red */', 3), removed('     was blue, and')])).toEqual([]);
  });

  it('names what @keyframes, @custom-variant and @utility define', () => {
    const sheet = ['@keyframes pulse {', '  0% {', '    opacity: 0;', '  }', '}', '@utility h-shell-* {', '  height: 1px;', '}'].join('\n');
    expect(cssNames(sheet, [added('    opacity: 0;', 3)])).toEqual(['pulse']);
    expect(cssNames(sheet, [added('  height: 1px;', 7)])).toEqual(['h-shell-']);
    const variant = '@custom-variant cell-active (&:focus-within);'
    expect(cssNames(variant, [added(variant, 1)])).toEqual(['cell-active']);
  });

  it('widens a BEM name to its element and block', () => {
    expect(cssNames('.menu__item--active {\n  x: 1;\n}', [added('  x: 1;', 2)])).toEqual([
      'menu',
      'menu__item',
      'menu__item--active',
    ]);
  });
});
