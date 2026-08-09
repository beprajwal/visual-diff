import { describe, expect, it } from 'vitest';

import {
  buildInitScript,
  CHROMIUM_LAUNCH_ARGS,
  DETERMINISM_CSS,
  DETERMINISM_STYLE_ID,
  deterministicEnv,
  FROZEN_EPOCH_MS,
  mulberry32,
  RANDOM_SEED,
} from './determinism.js';

interface StubStyle {
  id: string;
  textContent: string;
}

interface StubGlobal {
  Math: { imul: typeof Math.imul; random: () => number };
  Date: DateConstructor;
  document: {
    documentElement: object;
    head: { appendChild(node: StubStyle): void };
    createElement(tag: string): StubStyle;
    getElementById(id: string): StubStyle | null;
    addEventListener(type: string, listener: () => void): void;
  };
  __vdiff?: { epoch: number; seed: number };
}

function makeStub(): { global: StubGlobal; appended: StubStyle[] } {
  const appended: StubStyle[] = [];
  const global: StubGlobal = {
    Math: { imul: Math.imul, random: () => 0.5 },
    Date,
    document: {
      documentElement: {},
      head: {
        appendChild(node) {
          appended.push(node);
        },
      },
      createElement(tag) {
        return { id: tag === 'style' ? '' : '', textContent: '' };
      },
      getElementById(id) {
        return appended.find((node) => node.id === id) ?? null;
      },
      addEventListener() {
        /* no listener needed: documentElement is already present in the stub */
      },
    },
  };
  return { global, appended };
}

function runInitScript(global: StubGlobal, source = buildInitScript()): void {
  // The script's IIFE takes `globalThis` as its argument; a parameter of that name shadows the real
  // global, which is exactly how the page-side code stays isolated from this test process.
  const evaluate = new Function('globalThis', source) as (g: StubGlobal) => void;
  evaluate(global);
}

describe('buildInitScript', () => {
  it('is a single byte-stable string with no imports or requires', () => {
    const a = buildInitScript();
    const b = buildInitScript();
    expect(a).toBe(b);
    expect(typeof a).toBe('string');
    expect(a).not.toMatch(/\brequire\s*\(/);
    expect(a).not.toMatch(/\bimport\b/);
    expect(a).toContain(String(FROZEN_EPOCH_MS));
  });

  it('freezes the clock to the fixed epoch while leaving explicit dates alone', () => {
    const { global } = makeStub();
    runInitScript(global);

    expect(global.Date.now()).toBe(FROZEN_EPOCH_MS);
    expect(new global.Date().getTime()).toBe(FROZEN_EPOCH_MS);
    expect(new global.Date().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(new global.Date(0).getTime()).toBe(0);
    expect(new global.Date('2020-05-04T03:02:01.000Z').getTime()).toBe(
      Date.parse('2020-05-04T03:02:01.000Z'),
    );
    expect(global.Date.parse('2020-05-04T03:02:01.000Z')).toBe(
      Date.parse('2020-05-04T03:02:01.000Z'),
    );
    expect(new global.Date() instanceof Date).toBe(true);
  });

  it('seeds Math.random reproducibly and identically to the reference PRNG', () => {
    const first = makeStub().global;
    const second = makeStub().global;
    runInitScript(first);
    runInitScript(second);

    const oracle = mulberry32(RANDOM_SEED);
    const expected = [oracle(), oracle(), oracle(), oracle(), oracle()];
    const fromFirst = [0, 0, 0, 0, 0].map(() => first.Math.random());
    const fromSecond = [0, 0, 0, 0, 0].map(() => second.Math.random());

    expect(fromFirst).toEqual(expected);
    expect(fromSecond).toEqual(expected);
    for (const value of fromFirst) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(new Set(fromFirst).size).toBe(5);
  });

  it('injects the animation kill-switch stylesheet exactly once', () => {
    const { global, appended } = makeStub();
    runInitScript(global);
    runInitScript(global);

    expect(appended).toHaveLength(1);
    expect(appended[0]?.id).toBe(DETERMINISM_STYLE_ID);
    expect(appended[0]?.textContent).toBe(DETERMINISM_CSS);
    expect(global.__vdiff).toEqual({ epoch: FROZEN_EPOCH_MS, seed: RANDOM_SEED >>> 0 });
  });

  it('kills animation, transition and the caret', () => {
    expect(DETERMINISM_CSS).toContain('animation:none!important');
    expect(DETERMINISM_CSS).toContain('transition:none!important');
    expect(DETERMINISM_CSS).toContain('caret-color:transparent!important');
  });

  it('survives a global with no document at install time', () => {
    const global = makeStub().global as unknown as Omit<StubGlobal, 'document'> & {
      document?: unknown;
    };
    delete global.document;
    expect(() => runInitScript(global as unknown as StubGlobal)).not.toThrow();
    expect((global as unknown as StubGlobal).Date.now()).toBe(FROZEN_EPOCH_MS);
  });
});

describe('launch configuration', () => {
  it('disables overlay scrollbars so scrollbar width never shifts layout', () => {
    expect(CHROMIUM_LAUNCH_ARGS).toContain('--hide-scrollbars');
    expect(CHROMIUM_LAUNCH_ARGS.some((arg) => arg.includes('OverlayScrollbar'))).toBe(true);
  });

  it('never enables begin-frame control, which hangs screenshots on Linux headless', () => {
    // `--deterministic-mode` reads like exactly what this tool wants, and was used here until it
    // hung every browser-backed test in CI. It implies `--enable-begin-frame-control`, which stops
    // the compositor producing frames on its own; Playwright never sends BeginFrame, so
    // `page.screenshot()` never resolves. It works on macOS, so this cannot be caught locally.
    expect(CHROMIUM_LAUNCH_ARGS).not.toContain('--deterministic-mode');
    expect(CHROMIUM_LAUNCH_ARGS).not.toContain('--enable-begin-frame-control');
    expect(CHROMIUM_LAUNCH_ARGS).not.toContain('--run-all-compositor-stages-before-draw');

    // What is worth keeping from it: threaded, time-dependent rendering is what makes two captures
    // of an identical page differ.
    expect(CHROMIUM_LAUNCH_ARGS).toContain('--disable-threaded-animation');
    expect(CHROMIUM_LAUNCH_ARGS).toContain('--disable-threaded-scrolling');
    expect(CHROMIUM_LAUNCH_ARGS).toContain('--disable-checker-imaging');
  });

  it('forces UTC and en-US on spawned dev servers and passes the allocated port', () => {
    const env = deterministicEnv(4321, { PATH: '/usr/bin', TZ: 'Europe/Berlin' });
    expect(env.PORT).toBe('4321');
    expect(env.TZ).toBe('UTC');
    expect(env.LC_ALL).toBe('en_US.UTF-8');
    expect(env.PATH).toBe('/usr/bin');
  });
});
