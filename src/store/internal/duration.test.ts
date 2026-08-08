import { describe, expect, it } from 'vitest';

import { formatDuration, parseDuration } from './duration.js';

describe('parseDuration', () => {
  it('parses the units the config uses', () => {
    expect(parseDuration('1500ms')).toBe(1500);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration(' 90s ')).toBe(90_000);
    expect(parseDuration('0.5s')).toBe(500);
  });

  it('rejects unitless values, because 90 is ambiguous between seconds and milliseconds', () => {
    expect(parseDuration('90')).toBeNull();
  });

  it('rejects negative, empty and unknown units', () => {
    expect(parseDuration('-5s')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('90 s')).toBeNull();
    expect(parseDuration('90sec')).toBeNull();
    expect(parseDuration('forever')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('picks the largest exact unit', () => {
    expect(formatDuration(90_000)).toBe('90s');
    expect(formatDuration(120_000)).toBe('2m');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(1500)).toBe('1500ms');
    expect(formatDuration(0)).toBe('0ms');
  });

  it('round-trips through parseDuration', () => {
    for (const ms of [0, 1500, 90_000, 120_000, 3_600_000]) {
      expect(parseDuration(formatDuration(ms))).toBe(ms);
    }
  });
});
