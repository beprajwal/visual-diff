import { describe, expect, it } from 'vitest';

import {
  CAPTURED_ATTRS,
  DEFAULTS,
  DIFF_ENGINE_VERSION,
  EXIT,
  FINDING_KINDS,
  FLOW_DIFF_STATUSES,
  FORBIDDEN_STEP_VERBS,
  SEVERITIES,
  SEVERITY_ORDER,
  STEP_VERBS,
  STYLE_PROPS,
} from './types.js';

/**
 * These are contract assertions, not smoke tests. Every value below is named literally by the
 * design spec; if one of them moves, a stored run, a stored diff, or the agent-facing JSON API
 * changes meaning. The test pins them to the spec so the change has to be deliberate.
 */

describe('flow vocabulary (spec §6, D8)', () => {
  it('is exactly the closed verb list from the spec, in spec order', () => {
    expect([...STEP_VERBS]).toEqual([
      'goto',
      'click',
      'fill',
      'press',
      'hover',
      'scroll',
      'waitFor',
      'viewport',
      'mask',
      'shoot',
      'expect',
    ]);
  });

  it('names sleep-like verbs as forbidden rather than merely omitting them', () => {
    expect([...FORBIDDEN_STEP_VERBS]).toContain('sleep');
    expect([...FORBIDDEN_STEP_VERBS]).toEqual([
      'sleep',
      'wait',
      'waitForTimeout',
      'pause',
      'delay',
    ]);
  });

  it('keeps allowed and forbidden verbs disjoint', () => {
    const allowed = new Set<string>(STEP_VERBS);
    const overlap = FORBIDDEN_STEP_VERBS.filter((verb) => allowed.has(verb));
    expect(overlap).toEqual([]);
  });

  it('has no duplicate verbs', () => {
    expect(new Set<string>(STEP_VERBS).size).toBe(STEP_VERBS.length);
  });
});

describe('capture subsets (spec §7, §12)', () => {
  it('captures a closed, duplicate-free style subset', () => {
    expect(STYLE_PROPS.length).toBeGreaterThan(0);
    expect(new Set<string>(STYLE_PROPS).size).toBe(STYLE_PROPS.length);
  });

  it('includes the style properties the spec names explicitly', () => {
    for (const prop of [
      'color',
      'backgroundColor',
      'fontFamily',
      'fontSize',
      'borderRadius',
      'boxShadow',
      'display',
      'position',
      'opacity',
      'zIndex',
      'margin',
      'padding',
    ]) {
      expect(STYLE_PROPS).toContain(prop);
    }
  });

  it('retains every data-test attribute spelling, since testId is the strongest node key', () => {
    expect(CAPTURED_ATTRS).toContain('data-test');
    expect(CAPTURED_ATTRS).toContain('data-testid');
    expect(CAPTURED_ATTRS).toContain('data-test-id');
    expect(new Set<string>(CAPTURED_ATTRS).size).toBe(CAPTURED_ATTRS.length);
  });

  it('retains the accessibility attributes the a11y findings depend on', () => {
    for (const attr of ['role', 'aria-label', 'aria-labelledby', 'aria-hidden']) {
      expect(CAPTURED_ATTRS).toContain(attr);
    }
  });
});

describe('finding taxonomy (spec §8)', () => {
  it('is exactly the seven finding kinds', () => {
    expect([...FINDING_KINDS]).toEqual([
      'content',
      'style',
      'layout',
      'structural',
      'a11y',
      'console',
      'network',
    ]);
  });

  it('is exactly the six flow-diff buckets, so every step lands in one', () => {
    expect([...FLOW_DIFF_STATUSES]).toEqual([
      'matched',
      'added',
      'removed',
      'spec-changed',
      'failed',
      'blocked',
    ]);
  });

  it('orders severity high < med < low and covers every severity', () => {
    expect(Object.keys(SEVERITY_ORDER).sort()).toEqual([...SEVERITIES].sort());
    expect(SEVERITY_ORDER.high).toBeLessThan(SEVERITY_ORDER.med);
    expect(SEVERITY_ORDER.med).toBeLessThan(SEVERITY_ORDER.low);
  });

  it('sorts a mixed finding list high-first without dropping anything', () => {
    const severities = [...SEVERITIES, ...SEVERITIES].sort(
      (a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b],
    );
    expect(severities).toEqual(['high', 'high', 'med', 'med', 'low', 'low']);
  });
});

describe('exit codes (spec §9)', () => {
  it('maps success, run failure and config error to 0, 1, 2', () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.RUN_FAILURE).toBe(1);
    expect(EXIT.CONFIG_ERROR).toBe(2);
  });
});

describe('defaults (spec §6, §7, §12)', () => {
  it('pins the capture defaults the determinism test depends on', () => {
    expect(DEFAULTS.deviceScaleFactor).toBe(2);
    expect(DEFAULTS.maxDomNodes).toBe(5000);
    expect(DEFAULTS.viewportConcurrency).toBe(2);
    expect(DEFAULTS.readyTimeoutMs).toBe(90_000);
    expect(DEFAULTS.serverLogTailLines).toBe(50);
  });

  it('pins the noise-control defaults', () => {
    expect(DEFAULTS.diff.minRegionArea).toBe(64);
    expect(DEFAULTS.diff.maxRegions).toBe(40);
    expect(DEFAULTS.diff.antialiasTolerance).toBeCloseTo(0.1, 10);
    expect(DEFAULTS.diff.ignore).toEqual([]);
  });

  it('ships both spec viewports and keeps them parseable as WIDTHxHEIGHT', () => {
    expect(DEFAULTS.viewports).toEqual(['1280x800', '390x844']);
    for (const id of DEFAULTS.viewports) {
      expect(id).toMatch(/^\d+x\d+$/);
    }
  });

  it('keeps 20 runs and scrubs HARs unless explicitly disabled', () => {
    expect(DEFAULTS.retention.keepRuns).toBe(20);
    expect(DEFAULTS.network.scrub).toBe(true);
    expect(DEFAULTS.network.redact).toEqual([]);
  });

  it('always drops the three credential headers, lower-cased for header matching', () => {
    expect(DEFAULTS.alwaysRedactHeaders).toEqual(['authorization', 'cookie', 'set-cookie']);
    for (const header of DEFAULTS.alwaysRedactHeaders) {
      expect(header).toBe(header.toLowerCase());
    }
  });

  it('exposes a diff engine version usable as part of the cache key', () => {
    expect(DIFF_ENGINE_VERSION).toBe('1');
    expect(typeof DIFF_ENGINE_VERSION).toBe('string');
  });
});
