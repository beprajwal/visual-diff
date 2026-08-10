/**
 * `e2e/` — turning titles into identifiers (e2e spec D26, §8).
 *
 * D26 maps test titles to flows and step titles to step ids, and notes that titles were never
 * designed as identifiers. Reading real archives sharpens that into three rules this module exists
 * to enforce.
 *
 * **1. The test title contains a line number, and it must not reach the key.** `@playwright/test`
 * builds a trace's title as
 *
 *     [ path relative to project.testDir + ":" + line, ...titlePath.slice(1) ].join(" › ")
 *
 * so `probe.spec.ts:20 › search suite › finds a result` becomes `probe.spec.ts:31 › …` the moment
 * anyone adds eleven lines above it. D26 already says a drifted title shows up as removed-and-added
 * — visible rather than silently mis-compared — but this particular drift fires on *every unrelated
 * edit to the file*, which would make the e2e timeline useless. So the `:line` is stripped from the
 * leading path segment before any key is derived, and the path itself is kept, because two tests
 * with the same name in different files are different tests.
 *
 * **2. The separator is U+203A, not `>`.** Splitting on `>` silently fails to split at all.
 *
 * **3. The project name is not in the title.** `titlePath.slice(1)` drops it deliberately, and it
 * appears nowhere else in the archive, so no amount of parsing recovers it.
 *
 * Ids produced here must satisfy the store's `^[A-Za-z0-9][A-Za-z0-9._-]*$`, because a flow is a
 * file name and a step id is a directory name (§6).
 */

import { createHash } from 'node:crypto';

import type { StepId } from '../types.js';

/** U+203A SINGLE RIGHT-POINTING ANGLE QUOTATION MARK, with the spaces Playwright joins on. */
export const TITLE_SEPARATOR = ' › ';

/** The store's rule for a name that becomes a path component. */
export const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `isValidFlowName` caps a flow at 128 characters; we leave room for a disambiguating suffix. */
export const MAX_FLOW_NAME_LENGTH = 100;

export interface ParsedTestTitle {
  /** The spec file, when the title's first segment was `<path>:<line>`. */
  file?: string;
  /** The line number that was stripped. Kept for reporting, never for keying. */
  line?: number;
  /** Every remaining segment: describe blocks, then the test title. */
  path: string[];
}

/**
 * Splits a runner-format title into its parts.
 *
 * A library title (`tracing.start({ title })`) has no structure at all, so it comes back as a
 * single `path` segment with no `file` and no `line` — which is the honest reading: there is no
 * test concept in a library trace, only the string the caller chose.
 */
export function parseTestTitle(title: string): ParsedTestTitle {
  const segments = title
    .split('›')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
  if (segments.length === 0) return { path: [] };

  const [head, ...rest] = segments as [string, ...string[]];
  const match = /^(.+):(\d+)$/.exec(head);
  // Only a multi-segment title is in runner format; `foo:12` alone is far more likely to be a
  // deliberate library title than a spec file with no test name after it.
  if (match !== null && rest.length > 0) {
    const [, file, line] = match as unknown as [string, string, string];
    return { file, line: Number(line), path: rest };
  }
  return { path: segments };
}

/**
 * The title with its line number removed: the form every key is derived from.
 *
 * `probe.spec.ts:20 › search suite › finds a result` → `probe.spec.ts › search suite › finds a
 * result`. A title with no line number comes back unchanged apart from whitespace normalization.
 */
export function titleKeyOf(title: string): string {
  const parsed = parseTestTitle(title);
  const segments = parsed.file === undefined ? parsed.path : [parsed.file, ...parsed.path];
  return segments.join(TITLE_SEPARATOR);
}

/**
 * A name safe as a path component: lower-cased, every other character collapsed to a dash.
 *
 * `fallback` is returned when nothing survives — a title of `"…"` or `"🙂"` is not a name — so the
 * result always satisfies `SAFE_NAME_RE`.
 */
export function slugify(text: string, fallback = 'untitled'): string {
  const slug = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? fallback : slug;
}

/**
 * The flow a test maps to (D26).
 *
 * Derived from the line-stripped title so that editing a spec file above a test does not rename its
 * flow. Long titles are truncated and given an eight-character digest of the full key, so two tests
 * whose titles agree for the first hundred characters still land in different flows.
 */
export function flowNameFromTitle(title: string, fallback = 'e2e'): string {
  const key = titleKeyOf(title);
  const slug = slugify(key, fallback);
  if (slug.length <= MAX_FLOW_NAME_LENGTH) return slug;
  const digest = shortHash(key);
  return `${slug.slice(0, MAX_FLOW_NAME_LENGTH - digest.length - 1)}-${digest}`;
}

/** The step id a title maps to, before collision handling. */
export function stepIdFromTitle(title: string, fallback = 'step'): string {
  return slugify(title, fallback);
}

/** Eight hex characters of sha256 — enough to separate two titles, short enough to read. */
export function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

export interface StepIdInput {
  /** The step's title, or the synthesized description used when the archive carried none. */
  title: string;
  /** `.visual-diff/e2e-map.yaml`'s key for this step: its normalized title. */
  key: string;
}

export interface AssignedStepIds {
  ids: StepId[];
  /**
   * Titles that appeared more than once and were disambiguated (§8: "reported once as a notice").
   * Each title is listed once however many times it recurred.
   */
  duplicates: string[];
  /** Keys that an override map pinned. */
  overridden: string[];
}

/**
 * Assigns unique step ids in document order (§8, D26).
 *
 * Duplicate titles are trivially reachable — two `test.step('run the search')` blocks in one test
 * are indistinguishable except by call ordinal — so the first occurrence keeps the plain id and
 * each later one takes a `-2`, `-3` suffix. The suffix is *stable*: it depends only on how many
 * earlier steps in the same test carried the same title, so inserting an unrelated step elsewhere
 * does not renumber anything.
 *
 * Overrides win outright: that is what pinning a title to an id is for, and a suite that renames
 * often is exactly the case D26 introduced the map file for.
 */
export function assignStepIds(
  steps: readonly StepIdInput[],
  overrides: Readonly<Record<string, StepId>> = {},
): AssignedStepIds {
  const used = new Set<string>();
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  const overridden: string[] = [];
  const ids: StepId[] = [];

  for (const step of steps) {
    const override = overrides[step.key];
    if (override !== undefined) {
      overridden.push(step.key);
      ids.push(uniquify(override, used));
      continue;
    }
    const base = stepIdFromTitle(step.title);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    if (count === 2) duplicates.push(step.title);
    const candidate = count === 1 ? base : `${base}-${count}`;
    ids.push(uniquify(candidate, used));
  }

  return { ids, duplicates, overridden };
}

/**
 * Last-resort collision breaker.
 *
 * `assignStepIds` already numbers repeated titles, but two *different* titles can slug to the same
 * id (`run the search` and `Run the Search!`), and an override can collide with a derived id. A
 * step id is the key the diff aligns on, so a collision cannot be allowed to survive: the loser
 * takes the next free numeric suffix.
 */
function uniquify(candidate: string, used: Set<string>): string {
  const safe = SAFE_NAME_RE.test(candidate) ? candidate : slugify(candidate, 'step');
  if (!used.has(safe)) {
    used.add(safe);
    return safe;
  }
  for (let n = 2; ; n += 1) {
    const next = `${safe}-${n}`;
    if (!used.has(next)) {
      used.add(next);
      return next;
    }
  }
}
