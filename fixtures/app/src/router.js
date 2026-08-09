/**
 * Hash routing, as pure string functions.
 *
 * Hash routes rather than history routes so `vite preview` and any static host serve every screen
 * without a rewrite rule, and so a flow can `goto` straight to a screen instead of clicking its way
 * there. Direct navigation matters more here than it usually would: a step that arrives at the
 * detail screen by clicking has already loaded the forecast on the previous screen, so the loading
 * state it is supposed to be capturing has been and gone.
 *
 * Units live in the route because they are a view concern that a flow must be able to address:
 * `#/location/berlin?units=f` is one `goto`, where a toggle click is a step whose selector can
 * drift. Both work; the URL is the one that survives a redesign.
 *
 * Routes:
 *   #/                                  the location list
 *   #/location/<slug>                   a saved location
 *   #/at/<lat>,<lon>?label=<name>       an arbitrary point, which is what a search result links to
 */

import { DEFAULT_UNITS, normalizeUnits } from './units.js';

export const LIST_ROUTE = { name: 'list' };

function parseQuery(text) {
  return new URLSearchParams(text ?? '');
}

/**
 * `location.hash` → a route object. Never throws: an unparseable hash is a 404 route, because a
 * router that throws turns a mistyped URL into a blank page with a console error.
 */
export function parseRoute(hash) {
  const raw = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
  const [pathPart, queryPart] = raw.split('?');
  const query = parseQuery(queryPart);
  const units = normalizeUnits(query.get('units'));
  // Trailing slashes are stripped *before* the empty check, so `#/`, `#//` and `#` are one route
  // rather than one route and two 404s.
  const trimmed = pathPart === undefined ? '' : pathPart.replace(/\/+$/, '');
  const path = trimmed === '' ? '/' : trimmed;

  if (path === '/') return { name: 'list', units };

  const location = /^\/location\/([A-Za-z0-9._-]+)$/.exec(path);
  if (location !== null) return { name: 'saved', slug: location[1], units };

  const point = /^\/at\/(-?[0-9.]+),(-?[0-9.]+)$/.exec(path);
  if (point !== null) {
    return {
      name: 'point',
      latitude: point[1],
      longitude: point[2],
      label: query.get('label') ?? `${point[1]}, ${point[2]}`,
      units,
    };
  }

  return { name: 'not-found', path, units };
}

/** The inverse, so links are built rather than concatenated at call sites. */
export function buildHash(route) {
  const units = normalizeUnits(route.units);
  const query = units === DEFAULT_UNITS ? new URLSearchParams() : new URLSearchParams({ units });

  let path = '/';
  if (route.name === 'saved') path = `/location/${route.slug}`;
  else if (route.name === 'point') {
    path = `/at/${route.latitude},${route.longitude}`;
    if (typeof route.label === 'string' && route.label.length > 0) query.set('label', route.label);
  }

  const suffix = query.toString();
  return suffix === '' ? `#${path}` : `#${path}?${suffix}`;
}

/** The same route with the units swapped — what the C/F toggle links to. */
export function withUnits(route, units) {
  return buildHash({ ...route, units });
}
