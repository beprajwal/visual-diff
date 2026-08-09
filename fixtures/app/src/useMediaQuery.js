/**
 * A media query as state.
 *
 * Used by exactly one thing: the temperature chart, whose viewBox has to change shape at the narrow
 * breakpoint rather than merely scale down. CSS can restyle an SVG but it cannot re-lay-out one —
 * the coordinates come from `chart.js`, so the component has to know which geometry to ask for.
 *
 * Deterministic despite reading the environment: the runner replays at fixed viewport sizes in a
 * fresh context, so this resolves to the same answer on every run of a given viewport. It is read
 * from `matchMedia` with the same breakpoint the stylesheet uses, so the chart and everything
 * around it change shape on the same pixel.
 */

import { useEffect, useState } from 'preact/hooks';

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => globalThis.matchMedia?.(query).matches ?? false);

  useEffect(() => {
    const list = globalThis.matchMedia?.(query);
    if (list === undefined) return undefined;

    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
