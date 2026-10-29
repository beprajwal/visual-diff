import { describe, expect, it } from 'vitest';

import { nextPagesRouter, normalizeRoute, pageForRoute } from './routes.js';

describe('normalizeRoute', () => {
  it('keeps the path and drops the origin, the query and the hash', () => {
    expect(normalizeRoute('http://127.0.0.1:3000/shops/abc/products?tab=paid')).toEqual([
      'shops',
      'abc',
      'products',
    ]);
    expect(normalizeRoute('https://app.example.com/a#x')).toEqual(['a']);
  });

  it('drops a leading ${VAR} as a base path and wildcards one in the middle', () => {
    expect(normalizeRoute("'${BASE_PATH}/shops/${SHOP_ID}/orders#x'")).toEqual([
      'shops',
      '*',
      'orders',
    ]);
  });

  it('strips the configured base path, and only as a whole segment', () => {
    expect(normalizeRoute('/core/shops', '/core')).toEqual(['shops']);
    expect(normalizeRoute('/core', 'core/')).toEqual([]);
    expect(normalizeRoute('/corex/shops', '/core')).toEqual(['corex', 'shops']);
    expect(normalizeRoute('/core/shops')).toEqual(['core', 'shops']);
  });

  it('is null for an asset', () => {
    expect(normalizeRoute('http://127.0.0.1:3000/favicon.ico')).toBeNull();
    expect(normalizeRoute('/approval.html')).toBeNull();
  });
});

describe('next-pages router', () => {
  const router = nextPagesRouter('src/pages');
  const pages = [
    'src/pages/shops/[id]/products/index.tsx',
    'src/pages/shops/[id]/products/[productId]/index.tsx',
    'src/pages/shops/[id]/products/new.tsx',
    'src/pages/shops/[id]/[...rest].tsx',
    'src/pages/index.tsx',
  ];

  it('matches the most specific page', () => {
    expect(pageForRoute(['shops', 'p1', 'products'], pages, router)).toBe(pages[0]);
    expect(pageForRoute(['shops', 'p1', 'products', 'm1'], pages, router)).toBe(pages[1]);
    expect(pageForRoute(['shops', 'p1', 'products', 'new'], pages, router)).toBe(pages[2]);
    expect(pageForRoute(['shops', 'p1', 'anything', 'else'], pages, router)).toBe(pages[3]);
    expect(pageForRoute([], pages, router)).toBe(pages[4]);
    expect(pageForRoute(['members'], pages, router)).toBeNull();
  });

  it('knows a page from the app shell and the API', () => {
    expect(router.isPage('src/pages/_app.tsx')).toBe(false);
    expect(router.isPage('src/pages/api/health.ts')).toBe(false);
    expect(router.isServerOnly('src/pages/api/health.ts')).toBe(true);
    expect(router.isPage('src/pages/index.tsx')).toBe(true);
    expect(router.isPage('src/components/x.tsx')).toBe(false);
    expect(router.routeOf('src/pages/a/[b]/index.tsx')).toEqual(['a', '[b]']);
    expect(router.routeOf('src/pages/a/c.tsx')).toEqual(['a', 'c']);
  });
});
