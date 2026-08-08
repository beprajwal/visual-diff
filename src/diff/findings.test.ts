import { describe, expect, it } from 'vitest';

import type { ConsoleEntry, NetworkEntry } from '../types.js';
import { consoleFindings, networkFindings, normalizeRequestUrl } from './findings.js';

function request(overrides: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    step: 'cart',
    viewport: '1280x800',
    method: 'GET',
    url: 'http://127.0.0.1:5173/api/cart',
    status: 200,
    resourceType: 'fetch',
    harMatch: 'hit',
    durationMs: 4,
    ...overrides,
  };
}

function log(overrides: Partial<ConsoleEntry> = {}): ConsoleEntry {
  return {
    step: 'cart',
    viewport: '1280x800',
    level: 'error',
    text: 'TypeError: undefined is not a function',
    ts: '2026-08-08T10:00:00.000Z',
    ...overrides,
  };
}

describe('normalizeRequestUrl', () => {
  it('collapses the loopback authority, which changes on every spawned run', () => {
    expect(normalizeRequestUrl('http://127.0.0.1:62485/api/cart?x=1')).toBe(
      'http://localhost/api/cart?x=1',
    );
    expect(normalizeRequestUrl('http://localhost:5173/api/cart?x=1')).toBe(
      'http://localhost/api/cart?x=1',
    );
    expect(normalizeRequestUrl('http://[::1]:9000/')).toBe('http://localhost/');
  });

  it('leaves a real host, its port and the path alone', () => {
    expect(normalizeRequestUrl('https://api.example.com:8443/cart')).toBe(
      'https://api.example.com:8443/cart',
    );
    expect(normalizeRequestUrl('not a url')).toBe('not a url');
  });
});

describe('networkFindings', () => {
  it('reports nothing when only the dev server port moved', () => {
    const base = [request({ url: 'http://127.0.0.1:5173/api/cart' })];
    const head = [request({ url: 'http://127.0.0.1:62485/api/cart' })];
    expect(networkFindings('cart', base, head)).toEqual([]);
  });

  it('still reports a genuinely new request', () => {
    const findings = networkFindings('cart', [request()], [request(), request({ url: 'http://127.0.0.1:5173/api/user' })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'network', reasons: ['request-added'] });
  });

  it('reports a status change and a HAR miss on the same request', () => {
    const findings = networkFindings(
      'cart',
      [request()],
      [request({ status: null, harMatch: 'miss' })],
    );
    expect(findings.map((finding) => finding.reasons?.[0])).toEqual(['status-changed', 'har-miss']);
  });

  it('reports a disappeared request as low severity', () => {
    const findings = networkFindings('cart', [request()], []);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'low', reasons: ['request-removed'] });
  });
});

describe('consoleFindings', () => {
  it('treats a new console error as high severity (spec §8)', () => {
    const findings = consoleFindings('cart', [], [log()]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'console', severity: 'high' });
  });

  it('says nothing when the same error was already there', () => {
    expect(consoleFindings('cart', [log()], [log()])).toEqual([]);
  });
});
