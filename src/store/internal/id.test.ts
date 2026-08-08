import { describe, expect, it } from 'vitest';

import {
  compareRunIds,
  feedbackId,
  formatRunId,
  isRunId,
  nextFeedbackId,
  nextRunId,
  normalizeRunId,
  pairId,
  parseFeedbackId,
  parsePairId,
  parseRunId,
  sortRunIds,
} from './id.js';

describe('run ids', () => {
  it('zero-pads to four digits', () => {
    expect(formatRunId(0)).toBe('0000');
    expect(formatRunId(7)).toBe('0007');
    expect(formatRunId(1234)).toBe('1234');
  });

  it('widens rather than wrapping past 9999', () => {
    expect(formatRunId(10_000)).toBe('10000');
    expect(compareRunIds('9999', '10000')).toBeLessThan(0);
  });

  it('rejects non-integral ordinals', () => {
    expect(() => formatRunId(-1)).toThrow(RangeError);
    expect(() => formatRunId(1.5)).toThrow(RangeError);
  });

  it('only treats padded digit strings as directory-level run ids', () => {
    expect(isRunId('0007')).toBe(true);
    expect(isRunId('10000')).toBe(true);
    expect(isRunId('7')).toBe(false);
    expect(isRunId('.tmp-abc')).toBe(false);
    expect(isRunId('0003..0007')).toBe(false);
  });

  it('normalises what a human types', () => {
    expect(normalizeRunId('7')).toBe('0007');
    expect(normalizeRunId(' 0007 ')).toBe('0007');
    expect(normalizeRunId('007')).toBe('0007');
    expect(normalizeRunId('latest')).toBeNull();
  });

  it('is monotonic and gap-tolerant', () => {
    expect(nextRunId([])).toBe('0000');
    expect(nextRunId(['0000', '0001'])).toBe('0002');
    // 0002 was pruned away entirely; ids must not be reused.
    expect(nextRunId(['0000', '0001', '0003'])).toBe('0004');
    expect(nextRunId(['0003', '0001'])).toBe('0004');
  });

  it('ignores junk directory names when allocating', () => {
    expect(nextRunId(['0001', '.tmp-xyz', 'notarun'])).toBe('0002');
  });

  it('sorts numerically, not lexically', () => {
    expect(sortRunIds(['10000', '0009', '0100'])).toEqual(['0009', '0100', '10000']);
  });

  it('parses back', () => {
    expect(parseRunId('0007')).toBe(7);
    expect(parseRunId('nope')).toBeNull();
  });
});

describe('pair ids', () => {
  it('round-trips', () => {
    expect(pairId('0003', '0007')).toBe('0003..0007');
    expect(parsePairId('0003..0007')).toEqual({ base: '0003', head: '0007' });
  });

  it('normalises loose ids inside a pair', () => {
    expect(parsePairId('3..7')).toEqual({ base: '0003', head: '0007' });
  });

  it('rejects anything that is not two run ids', () => {
    expect(parsePairId('0003')).toBeNull();
    expect(parsePairId('0003..')).toBeNull();
    expect(parsePairId('a..b')).toBeNull();
  });
});

describe('feedback ids', () => {
  it('matches the spec example shape', () => {
    expect(feedbackId(1)).toBe('fb_01');
    expect(feedbackId(12)).toBe('fb_12');
    expect(feedbackId(100)).toBe('fb_100');
  });

  it('allocates past the highest id already stored', () => {
    expect(nextFeedbackId([])).toBe('fb_01');
    expect(nextFeedbackId(['fb_01', 'fb_09'])).toBe('fb_10');
    expect(nextFeedbackId(['fb_01', 'garbage'])).toBe('fb_02');
  });

  it('parses back', () => {
    expect(parseFeedbackId('fb_07')).toBe(7);
    expect(parseFeedbackId('f7')).toBeNull();
  });
});
