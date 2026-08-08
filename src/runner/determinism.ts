/**
 * Determinism knobs (spec §7).
 *
 * These are not polish: without them every run produces findings and the tool is worthless. Applied
 * to every browser context.
 *
 * - injected CSS killing animation, transition and the caret
 * - `prefers-reduced-motion: reduce` (a context option, see browser.ts)
 * - `TZ=UTC`, locale `en-US`, a clock frozen to a fixed epoch and a seeded `Math.random`, installed
 *   by an init script that runs **before any application code**
 * - overlay scrollbars disabled so scrollbar width never shifts layout
 */

/** Fixed epoch the page clock is frozen to: 2026-01-01T00:00:00.000Z. */
export const FROZEN_EPOCH_MS = 1767225600000;

/** Fixed `Math.random` seed. Any constant works; it must never change between runs. */
export const RANDOM_SEED = 0x5eed1234;

/** Locale forced on every context (spec §7). */
export const LOCALE = 'en-US';

/** Timezone forced on every context and on spawned dev servers (spec §7). */
export const TIMEZONE = 'UTC';

/** Marker id of the injected stylesheet, so injection is idempotent across SPA head rewrites. */
export const DETERMINISM_STYLE_ID = 'vdiff-determinism';

/**
 * The kill-switch stylesheet from spec §7, extended to pseudo-elements (which carry their own
 * animations) and to smooth scrolling, which is the same class of time-dependent motion.
 */
export const DETERMINISM_CSS =
  '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' +
  'html{scroll-behavior:auto!important}';

/**
 * Chromium launch arguments. `--disable-features=OverlayScrollbar,...` plus `--hide-scrollbars`
 * implements "overlay scrollbars disabled, so scrollbar width never shifts layout": no scrollbar
 * ever participates in layout, in either scroll state.
 */
export const CHROMIUM_LAUNCH_ARGS: readonly string[] = [
  '--hide-scrollbars',
  '--disable-features=OverlayScrollbar,FluentOverlayScrollbar,FluentScrollbar,PaintHolding',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--disable-lcd-text',
  '--disable-skia-runtime-opts',
  '--disable-back-forward-cache',
  '--deterministic-mode',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
];

/** Reference implementation of the PRNG the init script installs. Used as the test oracle. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface InitScriptOptions {
  epochMs?: number;
  seed?: number;
  css?: string;
  styleId?: string;
}

/**
 * Build the init script source. One self-contained string with no imports and no closure over the
 * Node side, because Playwright evaluates it in a fresh page context before application code runs.
 *
 * Everything it touches is reached through the injected `g` binding (`globalThis` at call time),
 * which is what lets `determinism.test.ts` execute it against a stub global instead of the real one.
 */
export function buildInitScript(options: InitScriptOptions = {}): string {
  const epoch = options.epochMs ?? FROZEN_EPOCH_MS;
  const seed = options.seed ?? RANDOM_SEED;
  const css = options.css ?? DETERMINISM_CSS;
  const styleId = options.styleId ?? DETERMINISM_STYLE_ID;

  return `(function (g) {
  var EPOCH = ${JSON.stringify(epoch)};
  var SEED = ${JSON.stringify(seed >>> 0)};
  var CSS = ${JSON.stringify(css)};
  var STYLE_ID = ${JSON.stringify(styleId)};
  if (g.__vdiff) { return; }
  g.__vdiff = { epoch: EPOCH, seed: SEED };

  var M = g.Math;
  var state = SEED >>> 0;
  M.random = function () {
    state = (state + 0x6d2b79f5) >>> 0;
    var t = state;
    t = M.imul(t ^ (t >>> 15), t | 1);
    t ^= t + M.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  var RealDate = g.Date;
  var FrozenDate = class extends RealDate {
    constructor() {
      if (arguments.length === 0) { super(EPOCH); } else { super(...arguments); }
    }
  };
  FrozenDate.now = function () { return EPOCH; };
  g.Date = FrozenDate;

  var install = function () {
    var doc = g.document;
    if (!doc || !doc.documentElement) { return false; }
    if (doc.getElementById && doc.getElementById(STYLE_ID)) { return true; }
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
    return true;
  };
  if (!install() && g.document && g.document.addEventListener) {
    g.document.addEventListener('DOMContentLoaded', install);
  }
})(globalThis);
`;
}

/**
 * Environment for a spawned dev server. `TZ`/`LC_ALL` keep server-rendered dates and number
 * formatting stable; `CI` and `BROWSER=none` stop dev servers opening a browser or printing spinners.
 */
export function deterministicEnv(port: number, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    PORT: String(port),
    TZ: TIMEZONE,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    BROWSER: 'none',
    CI: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
}
