/**
 * Hash routing.
 *
 * Every screen a flow captures is addressed by one of these strings, so a routing change is a
 * change to the flow specs whether or not anyone updates them. The round-trip property is the one
 * that matters most: `parseRoute(buildHash(route))` must return the route, or a link the app
 * renders leads somewhere the app cannot parse.
 */

import { describe, expect, it } from 'vitest';

import { buildHash, parseRoute, withUnits } from '../src/router.js';

describe('parseRoute', () => {
  it('reads the list screen from every spelling of an empty path', () => {
    for (const hash of ['', '#', '#/', '/', '#//']) {
      expect(parseRoute(hash)).toMatchObject({ name: 'list', units: 'c' });
    }
  });

  it('reads a saved location', () => {
    expect(parseRoute('#/location/berlin')).toEqual({ name: 'saved', slug: 'berlin', units: 'c' });
    expect(parseRoute('#/location/reykjavik?units=f')).toEqual({ name: 'saved', slug: 'reykjavik', units: 'f' });
  });

  it('reads an arbitrary point, including negative and out-of-range coordinates', () => {
    expect(parseRoute('#/at/32.71571,-117.16472?label=San+Diego')).toEqual({
      name: 'point',
      latitude: '32.71571',
      longitude: '-117.16472',
      label: 'San Diego',
      units: 'c',
    });

    // The error state's route. It has to parse — the *API* rejects it, not the router.
    expect(parseRoute('#/at/999,13.405?label=Out+of+range')).toMatchObject({
      name: 'point',
      latitude: '999',
      longitude: '13.405',
      label: 'Out of range',
    });
  });

  it('labels a point with its coordinates when no label was given', () => {
    expect(parseRoute('#/at/52.52,13.405').label).toBe('52.52, 13.405');
  });

  it('falls back to Celsius for an unrecognised units value rather than rendering nothing', () => {
    expect(parseRoute('#/?units=kelvin').units).toBe('c');
    expect(parseRoute('#/?units=F').units).toBe('c');
    expect(parseRoute('#/?units=f').units).toBe('f');
  });

  it('reports an unmatched path as not-found instead of throwing', () => {
    expect(parseRoute('#/somewhere-else')).toEqual({ name: 'not-found', path: '/somewhere-else', units: 'c' });
    expect(parseRoute('#/at/not,coords').name).toBe('not-found');
    expect(parseRoute('#/location/has spaces').name).toBe('not-found');
    expect(parseRoute(undefined).name).toBe('list');
  });
});

describe('buildHash', () => {
  it('omits the default units so the common URL stays clean', () => {
    expect(buildHash({ name: 'list', units: 'c' })).toBe('#/');
    expect(buildHash({ name: 'list', units: 'f' })).toBe('#/?units=f');
    expect(buildHash({ name: 'saved', slug: 'berlin', units: 'c' })).toBe('#/location/berlin');
  });

  it('carries the label on a point route', () => {
    expect(buildHash({ name: 'point', latitude: '32.71571', longitude: '-117.16472', label: 'San Diego', units: 'f' })).toBe(
      '#/at/32.71571,-117.16472?units=f&label=San+Diego',
    );
  });

  it('round-trips every route the app can produce', () => {
    const routes = [
      { name: 'list', units: 'c' },
      { name: 'list', units: 'f' },
      { name: 'saved', slug: 'berlin', units: 'c' },
      { name: 'saved', slug: 'wellington', units: 'f' },
      { name: 'point', latitude: '32.71571', longitude: '-117.16472', label: 'San Diego', units: 'c' },
      { name: 'point', latitude: '-41.2866', longitude: '174.7756', label: 'Wellington', units: 'f' },
    ];
    for (const route of routes) {
      expect(parseRoute(buildHash(route))).toEqual(route);
    }
  });
});

describe('withUnits', () => {
  it('keeps the reader on the same screen when they change units', () => {
    const route = parseRoute('#/location/berlin');
    expect(withUnits(route, 'f')).toBe('#/location/berlin?units=f');
    expect(withUnits(parseRoute('#/location/berlin?units=f'), 'c')).toBe('#/location/berlin');
  });

  it('preserves the label of an ad-hoc point across a units change', () => {
    const route = parseRoute('#/at/32.71571,-117.16472?label=San+Diego');
    expect(parseRoute(withUnits(route, 'f'))).toMatchObject({ label: 'San Diego', units: 'f' });
  });
});
