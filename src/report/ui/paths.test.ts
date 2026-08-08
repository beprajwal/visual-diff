import { describe, expect, it } from 'vitest';

import {
  BLOB_BASE,
  blobUrl,
  cropPath,
  diffDir,
  domPath,
  pairId,
  parsePairId,
  pixelPath,
  runDir,
  screenshotPath,
  stepDir,
} from './paths.js';

describe('store paths', () => {
  it('builds run and step directories keyed by step id', () => {
    expect(runDir('checkout', '0007')).toBe('runs/checkout/0007');
    expect(stepDir('checkout', '0007', 'pay-form')).toBe('runs/checkout/0007/steps/pay-form');
  });

  it('builds shot artifact paths exactly as spec §6 lays them out', () => {
    expect(screenshotPath('checkout', '0007', 'pay-form', '1280x800')).toBe(
      'runs/checkout/0007/steps/pay-form/1280x800/screenshot.png',
    );
    expect(domPath('checkout', '0007', 'pay-form', '390x844')).toBe(
      'runs/checkout/0007/steps/pay-form/390x844/dom.json',
    );
  });

  it('builds diff artifact paths', () => {
    expect(diffDir('checkout', '0003', '0007')).toBe('diffs/checkout/0003..0007');
    expect(pixelPath('checkout', '0003', '0007', 'pay-form', '1280x800')).toBe(
      'diffs/checkout/0003..0007/steps/pay-form/1280x800/pixel.png',
    );
    expect(cropPath('checkout', '0003', '0007', 'f1')).toBe(
      'diffs/checkout/0003..0007/crops/f1.png',
    );
  });
});

describe('pairId', () => {
  it('round-trips', () => {
    const id = pairId('0003', '0007');
    expect(id).toBe('0003..0007');
    expect(parsePairId(id)).toEqual({ base: '0003', head: '0007' });
  });

  it('rejects anything that is not exactly two run ids', () => {
    expect(parsePairId('0003')).toBeNull();
    expect(parsePairId('0003..0005..0007')).toBeNull();
    expect(parsePairId('..0007')).toBeNull();
    expect(parsePairId('0003..')).toBeNull();
    expect(parsePairId('')).toBeNull();
  });
});

describe('blobUrl', () => {
  it('keeps slashes and escapes everything else', () => {
    expect(blobUrl('runs/checkout/0007/steps/pay form/1280x800/screenshot.png')).toBe(
      `${BLOB_BASE}/runs/checkout/0007/steps/pay%20form/1280x800/screenshot.png`,
    );
  });

  it('normalises leading separators so a path cannot escape the blob namespace', () => {
    expect(blobUrl('/runs/a.png')).toBe(`${BLOB_BASE}/runs/a.png`);
    expect(blobUrl('./runs/a.png')).toBe(`${BLOB_BASE}/runs/a.png`);
  });

  it('appends the session token when one is supplied', () => {
    expect(blobUrl('runs/a.png', 'tok en')).toBe(`${BLOB_BASE}/runs/a.png?token=tok%20en`);
    expect(blobUrl('runs/a.png', null)).toBe(`${BLOB_BASE}/runs/a.png`);
  });
});
