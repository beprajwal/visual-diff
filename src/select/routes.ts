/**
 * From a flow's URLs to the page files that render them (selection spec §3, D62).
 *
 * A flow names routes: `readyOn` and every `goto`. A page file names a route pattern by where it
 * sits. The router adapter is the convention that turns the file into the pattern and scores a
 * route against it; `next-pages` is the one shipped, and an app on another router declares its
 * coverage with `covers:` until an adapter for it exists.
 */

import * as path from 'node:path';

import type { FlowSpec } from '../types.js';

export type Route = string[];
export type RouterId = 'next-pages';

export interface Router {
  id: RouterId;
  /** A file under the pages directory that renders a route. */
  isPage(file: string): boolean;
  /** A file under the pages directory that renders nothing a screenshot can show. */
  isServerOnly(file: string): boolean;
  /** The route pattern the file answers, as segments. */
  routeOf(file: string): Route;
  /**
   * How well a pattern matches a route: a score per segment, higher the more specific, or null for
   * no match. Compared lexicographically, so a literal segment beats a parameter at the same depth.
   */
  score(pattern: Route, route: Route): number[] | null;
}

const SEGMENT_SCORE = { literal: 3, dynamic: 2, 'catch-all': 1, 'optional-catch-all': 1 } as const;

type SegmentKind = keyof typeof SEGMENT_SCORE;

function nextSegmentKind(segment: string): SegmentKind {
  if (/^\[\[\.\.\..+\]\]$/.test(segment)) return 'optional-catch-all';
  if (/^\[\.\.\..+\]$/.test(segment)) return 'catch-all';
  if (/^\[.+\]$/.test(segment)) return 'dynamic';
  return 'literal';
}

/** The Next.js pages router: `pages/a/[id]/index.tsx` answers `/a/:id`, `_app` and `api/` do not. */
export function nextPagesRouter(dir: string): Router {
  const prefix = `${dir}/`;
  const api = `${dir}/api/`;
  return {
    id: 'next-pages',
    isPage: (file) =>
      file.startsWith(prefix) && !file.startsWith(api) && !path.posix.basename(file).startsWith('_'),
    isServerOnly: (file) => file.startsWith(api),
    routeOf: (file) => {
      const segments = file
        .slice(prefix.length)
        .replace(/\.[^.]+$/, '')
        .split('/');
      if (segments.at(-1) === 'index') segments.pop();
      return segments;
    },
    score: (pattern, route) => {
      const score: number[] = [];
      for (let index = 0; index < pattern.length; index += 1) {
        const kind = nextSegmentKind(pattern[index] as string);
        if (kind === 'catch-all') return route.length > index ? [...score, 1] : null;
        if (kind === 'optional-catch-all') return [...score, 1];
        if (index >= route.length) return null;
        if (kind === 'literal' && pattern[index] !== route[index]) return null;
        score.push(SEGMENT_SCORE[kind]);
      }
      return route.length === pattern.length ? score : null;
    },
  };
}

export function routerFor(id: RouterId, dir: string): Router {
  switch (id) {
    case 'next-pages':
      return nextPagesRouter(dir);
  }
}

const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * A flow's URL as route segments, the way a page would be asked for it. The origin, query and hash
 * go; a leading `${VAR}` segment is a base path the deployment supplies and goes too, as does the
 * configured `basePath`; any other `${VAR}` segment becomes `*`, matching one segment of anything.
 * A URL ending in a file extension names an asset, not a page, and is null.
 */
export function normalizeRoute(value: string, basePath?: string): Route | null {
  let route = unquote(value)
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .replace(/[?#].*$/, '');
  route = route.replace(/^\$\{[^}]+\}/, '');
  const base = basePath === undefined ? '' : `/${basePath.replace(/^\/+|\/+$/g, '')}`;
  if (base !== '/' && base !== '' && (route === base || route.startsWith(`${base}/`))) {
    route = route.slice(base.length);
  }
  const segments = route.split('/').filter((segment) => segment !== '');
  const last = segments.at(-1);
  if (last !== undefined && /\.[a-z0-9]+$/i.test(last)) return null;
  return segments.map((segment) => (/\$\{[^}]+\}/.test(segment) ? '*' : segment));
}

/** The routes a flow visits: `readyOn` first, then every `goto` in step order. */
export function flowRoutes(spec: FlowSpec, basePath?: string): Route[] {
  const routes: Route[] = [];
  const push = (value: string | undefined): void => {
    if (value === undefined) return;
    const route = normalizeRoute(value, basePath);
    if (route !== null) routes.push(route);
  };
  push(spec.readyOn);
  for (const step of spec.steps) push(step.goto);
  return routes;
}

/** The page that answers a route, or null when none does. The most specific pattern wins. */
export function pageForRoute(
  route: Route,
  pages: readonly string[],
  router: Router,
): string | null {
  let best: { page: string; score: number[] } | null = null;
  for (const page of pages) {
    const score = router.score(router.routeOf(page), route);
    if (score === null) continue;
    if (best === null || compareScores(score, best.score) > 0) best = { page, score };
  }
  return best === null ? null : best.page;
}

function compareScores(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
