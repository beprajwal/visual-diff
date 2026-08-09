import { describe, expect, it } from 'vitest';

import { formatHash, isViewMode, parseHash, routePair, type RouteState } from './route.js';

describe('parseHash', () => {
  it('reads every field', () => {
    const route = parseHash(
      '#flow=checkout&pair=0003..0007&step=pay-form&viewport=1280x800&view=overlay&findings=1',
    );
    expect(route).toEqual({
      flow: 'checkout',
      base: '0003',
      head: '0007',
      step: 'pay-form',
      viewport: '1280x800',
      view: 'overlay',
      findingsOnly: true,
    });
  });

  it('tolerates a missing leading hash and an empty hash', () => {
    expect(parseHash('flow=checkout').flow).toBe('checkout');
    expect(parseHash('')).toEqual({});
    expect(parseHash('#')).toEqual({});
  });

  it('ignores a malformed pair rather than half-applying it', () => {
    expect(parseHash('#pair=0003').base).toBeUndefined();
    expect(parseHash('#pair=0003..0005..0007').head).toBeUndefined();
  });

  it('ignores an unknown view mode', () => {
    expect(parseHash('#view=kaleidoscope').view).toBeUndefined();
    expect(parseHash('#view=swipe').view).toBe('swipe');
  });

  it('reads findings=0 as an explicit off', () => {
    expect(parseHash('#findings=0').findingsOnly).toBe(false);
    expect(parseHash('#findings=true').findingsOnly).toBe(true);
    expect(parseHash('#flow=a').findingsOnly).toBeUndefined();
  });

  it('ignores unknown keys', () => {
    expect(parseHash('#flow=a&nonsense=1')).toEqual({ flow: 'a' });
  });
});

describe('formatHash', () => {
  it('round-trips a full route', () => {
    const route: RouteState = {
      flow: 'checkout',
      base: '0003',
      head: '0007',
      step: 'pay-form',
      viewport: '1280x800',
      view: 'swipe',
      findingsOnly: true,
    };
    expect(parseHash(formatHash(route))).toEqual(route);
  });

  it('omits defaults so the common URL stays short', () => {
    expect(formatHash({ flow: 'checkout', view: 'side-by-side', findingsOnly: false })).toBe(
      '#flow=checkout',
    );
  });

  it('omits a half-specified pair', () => {
    expect(formatHash({ flow: 'checkout', head: '0007' })).toBe('#flow=checkout');
  });

  it('returns an empty string for an empty route', () => {
    expect(formatHash({})).toBe('');
  });
});

describe('routePair', () => {
  it('returns the pair id only when both ends are present', () => {
    expect(routePair({ base: '0003', head: '0007' })).toBe('0003..0007');
    expect(routePair({ head: '0007' })).toBeNull();
    expect(routePair({})).toBeNull();
  });
});

describe('isViewMode', () => {
  it('accepts exactly the three view modes', () => {
    expect(isViewMode('side-by-side')).toBe(true);
    expect(isViewMode('overlay')).toBe(true);
    expect(isViewMode('swipe')).toBe(true);
    expect(isViewMode('onion')).toBe(false);
  });
});

describe('the scenario filter in the hash (mocking §7)', () => {
  it('round-trips a filter', () => {
    const route = parseHash('#flow=forecast&scenario=empty-forecast&pair=0002..0004');
    expect(route.scenario).toBe('empty-forecast');
    expect(formatHash(route)).toBe('#flow=forecast&scenario=empty-forecast&pair=0002..0004');
  });

  it('omits the all-scenarios default, so the common URL stays short', () => {
    expect(formatHash({ flow: 'forecast', scenario: '*' })).toBe('#flow=forecast');
  });

  it('keeps the reserved `none` filter, which is a real selection', () => {
    expect(formatHash({ flow: 'forecast', scenario: 'none' })).toBe(
      '#flow=forecast&scenario=none',
    );
    expect(parseHash('#scenario=none').scenario).toBe('none');
  });

  it('leaves the filter unset when the hash does not name one', () => {
    expect(parseHash('#flow=forecast').scenario).toBeUndefined();
  });
});
