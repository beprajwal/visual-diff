/**
 * CSS colour parsing and WCAG contrast, used by the severity heuristic
 * "a contrast ratio dropping below 4.5" (spec §8).
 *
 * Only the forms Chromium's `getComputedStyle` actually emits are handled — `rgb()`, `rgba()`,
 * `color(srgb ...)`, hex and the handful of keywords that survive computation. Anything else
 * returns null and the contrast heuristic simply does not fire; it never guesses.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

const KEYWORDS: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
};

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, n));
}

function parseChannel(raw: string): number | null {
  const t = raw.trim();
  if (t.endsWith('%')) {
    const pct = Number.parseFloat(t.slice(0, -1));
    return Number.isFinite(pct) ? clamp255(Math.round((pct / 100) * 255)) : null;
  }
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? clamp255(Math.round(n)) : null;
}

function parseAlpha(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const t = raw.trim();
  if (t === '' || t === 'none') return 1;
  if (t.endsWith('%')) {
    const pct = Number.parseFloat(t.slice(0, -1));
    return Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : 1;
  }
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

export function parseCssColor(input: string | undefined | null): Rgba | null {
  if (input === undefined || input === null) return null;
  const value = input.trim().toLowerCase();
  if (value === '') return null;

  const keyword = KEYWORDS[value];
  if (keyword !== undefined) return { ...keyword };

  if (value.startsWith('#')) {
    const hex = value.slice(1);
    const expand = (c: string): number => Number.parseInt(c + c, 16);
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = [hex[0], hex[1], hex[2], hex[3]];
      if (r === undefined || g === undefined || b === undefined) return null;
      return {
        r: expand(r),
        g: expand(g),
        b: expand(b),
        a: a === undefined ? 1 : expand(a) / 255,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      const n = (i: number): number => Number.parseInt(hex.slice(i, i + 2), 16);
      const [r, g, b] = [n(0), n(2), n(4)];
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
      return { r, g, b, a: hex.length === 8 ? n(6) / 255 : 1 };
    }
    return null;
  }

  const fn = /^(rgba?|color)\(([^)]*)\)$/.exec(value);
  if (fn === null) return null;
  const name = fn[1] ?? '';
  let body = (fn[2] ?? '').trim();

  if (name === 'color') {
    // color(srgb 0.1 0.2 0.3 / 0.5)
    if (!body.startsWith('srgb')) return null;
    body = body.slice('srgb'.length).trim();
    const [coords, alphaPart] = body.split('/');
    const parts = (coords ?? '').trim().split(/\s+/).filter((p) => p !== '');
    if (parts.length < 3) return null;
    const chan = (s: string): number => clamp255(Math.round(Number.parseFloat(s) * 255));
    const r = chan(parts[0] as string);
    const g = chan(parts[1] as string);
    const b = chan(parts[2] as string);
    if (![r, g, b].every(Number.isFinite)) return null;
    return { r, g, b, a: parseAlpha(alphaPart) };
  }

  const [coordPart, slashAlpha] = body.split('/');
  const parts = (coordPart ?? '')
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length < 3) return null;
  const r = parseChannel(parts[0] as string);
  const g = parseChannel(parts[1] as string);
  const b = parseChannel(parts[2] as string);
  if (r === null || g === null || b === null) return null;
  const alphaRaw = slashAlpha !== undefined ? slashAlpha : parts[3];
  return { r, g, b, a: parseAlpha(alphaRaw) };
}

/** Source-over composite of a translucent colour onto an opaque backdrop. */
export function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (f: number, b: number): number =>
    Math.round((f * fg.a + b * bg.a * (1 - fg.a)) / a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a };
}

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(c: Rgba): number {
  return (
    0.2126 * channelLuminance(c.r) +
    0.7152 * channelLuminance(c.g) +
    0.0722 * channelLuminance(c.b)
  );
}

/** WCAG 2.x contrast ratio, 1..21. Translucent foregrounds are composited onto the backdrop. */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const solidBg = bg.a >= 1 ? bg : compositeOver(bg, { r: 255, g: 255, b: 255, a: 1 });
  const solidFg = fg.a >= 1 ? fg : compositeOver(fg, solidBg);
  const l1 = relativeLuminance(solidFg);
  const l2 = relativeLuminance(solidBg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
