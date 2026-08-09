/**
 * The C/F toggle.
 *
 * The toggle is one of the four screens the api-mocking spec asks this fixture to make diffable, and
 * it is the one whose bugs are invisible: a wrong conversion still renders a plausible number, so a
 * screenshot diff would show a change and call it intentional. These assertions are the only thing
 * that says which number is right.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_UNITS,
  UNITS,
  convertTemperature,
  formatMillimetres,
  formatPercent,
  formatTemperature,
  formatWind,
  isUnits,
  normalizeUnits,
  otherUnits,
  unitSymbol,
} from '../src/units.js';

describe('units', () => {
  it('exposes exactly the two units the toggle offers', () => {
    expect(UNITS).toEqual(['c', 'f']);
    expect(DEFAULT_UNITS).toBe('c');
  });

  it('normalizes anything unrecognised to Celsius', () => {
    expect(normalizeUnits('f')).toBe('f');
    expect(normalizeUnits('F')).toBe('c');
    expect(normalizeUnits('kelvin')).toBe('c');
    expect(normalizeUnits(undefined)).toBe('c');
    expect(normalizeUnits(null)).toBe('c');
    expect(isUnits('c')).toBe(true);
    expect(isUnits('k')).toBe(false);
  });

  it('swaps units for the toggle link', () => {
    expect(otherUnits('c')).toBe('f');
    expect(otherUnits('f')).toBe('c');
    expect(otherUnits('nonsense')).toBe('f');
  });
});

describe('convertTemperature', () => {
  it('leaves Celsius alone and converts Fahrenheit at the known anchors', () => {
    expect(convertTemperature(21.5, 'c')).toBe(21.5);
    expect(convertTemperature(0, 'f')).toBe(32);
    expect(convertTemperature(100, 'f')).toBe(212);
    expect(convertTemperature(-40, 'f')).toBe(-40);
    expect(convertTemperature(26.8, 'f')).toBeCloseTo(80.24, 10);
  });

  it('returns null rather than NaN for a value a scenario removed', () => {
    expect(convertTemperature(null, 'f')).toBeNull();
    expect(convertTemperature(undefined, 'c')).toBeNull();
    expect(convertTemperature(Number.NaN, 'c')).toBeNull();
    expect(convertTemperature(Number.POSITIVE_INFINITY, 'c')).toBeNull();
  });
});

describe('formatTemperature', () => {
  it('rounds to whole degrees and carries the symbol', () => {
    expect(formatTemperature(26.8, 'c')).toBe('27°C');
    expect(formatTemperature(26.8, 'f')).toBe('80°F');
    expect(formatTemperature(26.8, 'c', { withUnit: false })).toBe('27°');
  });

  it('never renders "-0°", which is what naive rounding produces just below freezing', () => {
    expect(formatTemperature(-0.4, 'c')).toBe('0°C');
    expect(formatTemperature(-0.4, 'c', { withUnit: false })).toBe('0°');
  });

  it('renders an em-dash for a missing reading instead of inventing one', () => {
    expect(formatTemperature(null, 'c')).toBe('—');
    expect(formatTemperature(undefined, 'f')).toBe('—');
  });
});

describe('the other formatters', () => {
  it('formats percentages', () => {
    expect(formatPercent(42)).toBe('42%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(null)).toBe('—');
  });

  it('switches wind and precipitation to imperial alongside the temperature', () => {
    expect(formatWind(9.4, 'c')).toBe('9 km/h');
    expect(formatWind(9.4, 'f')).toBe('6 mph');
    expect(formatWind(null, 'c')).toBe('—');

    expect(formatMillimetres(0.3, 'c')).toBe('0.3 mm');
    expect(formatMillimetres(25.4, 'f')).toBe('1.00 in');
    expect(formatMillimetres(null, 'f')).toBe('—');
  });

  it('symbolises the unit', () => {
    expect(unitSymbol('c')).toBe('°C');
    expect(unitSymbol('f')).toBe('°F');
  });
});
