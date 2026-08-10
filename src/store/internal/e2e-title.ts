/**
 * store/internal/e2e-title — D26: test titles become flow names, step titles become step ids.
 *
 * Diffing depends on stable step ids (D4), and a trace offers titles, which were never designed as
 * identifiers. This module is the whole of the translation, and every rule in it exists because of
 * something measured in a real archive rather than something the spec assumed.
 *
 * ### The line number is inside the title
 *
 * A `@playwright/test` archive puts the test title in the *library* trace's `context-options.title`,
 * built by the worker as:
 *
 * ```
 * [relative(project.testDir, file) + ":" + line, ...titlePath.slice(1)].join(" › ")
 * ```
 *
 * so a real title reads `checkout.spec.ts:12 › checkout › shows the cart`, with U+203A
 * (single right-pointing angle quotation mark) as the separator — not `>` — and the project name
 * deliberately dropped.
 *
 * **That title contains a line number.** Adding an import at the top of a spec file renumbers every
 * test in it, and a key that included the line would report every flow in that file as
 * removed-and-added on an edit that changed nothing visual. D26's "titles are normalized" therefore
 * has one non-negotiable clause: `stripLocation` removes the `:line`, keeping the file path, before
 * anything is keyed on the result. This is not a hypothetical drift; it fires on every unrelated
 * edit above a test.
 *
 * ### Two artefacts, not one
 *
 * - **`titleKey`** — the canonical title: location line dropped, separators and whitespace
 *   normalised. It is what `e2e-map.yaml` pins are matched against, what a later ingest recognises a
 *   flow by, and what drift is measured on. It is never a path component, so it keeps `/`, `:` and
 *   any other character the test author used.
 * - **`flowName` / step ids** — slugs, which *are* path components (`runs/<flow>/…`,
 *   `steps/<stepId>/…`), and so must survive `paths.assertSafeSegment`.
 *
 * Keeping them separate is what lets the pretty name be short while the key stays exact.
 *
 * ### Stability of the disambiguating suffix
 *
 * D26 asks for a *stable* suffix on collisions, and "stable" rules out the obvious `-2`, `-3` by
 * arrival order: that renames an existing flow the day a colliding test is written. So:
 *
 * - a flow name is derived from the title alone, and collides only across two genuinely different
 *   titles that slug alike. `allocateFlowName` resolves that against the names already claimed, and
 *   the suffix it appends is a hash of the *title*, not a counter — the first claimant keeps its
 *   name forever and the newcomer gets a name that does not depend on when it arrived;
 * - step ids are ordinal-suffixed within one test, and there `-2` is the only thing available:
 *   duplicate step titles are byte-identical strings, so nothing but position distinguishes them
 *   (verified: two `test.step('run the search')` blocks in one test differ only in callId ordinal).
 *   §8 requires this case be reported as a notice precisely because the suffix is the weak kind.
 */

import { sha256Hex } from './hash.js';

/** U+203A, the separator `@playwright/test` joins title segments with. Not `>`. */
export const TITLE_SEPARATOR = '›';

/** Longest slug emitted before it is truncated and hashed. Well inside every filesystem's limit. */
export const MAX_SLUG_LENGTH = 80;

/** Length of the hex suffix that makes a truncated or colliding slug unique. */
const SUFFIX_LENGTH = 6;

/**
 * The leading `<path>:<line>` segment of a runner title.
 *
 * Deliberately narrow: no whitespace, a file extension, and a `:` followed only by digits at the
 * end. A test titled `Foo: 12` or `chapter 3: 40` does not match, and neither does a bare
 * `something:12` with no extension — the cost of a false positive here is silently renaming a flow.
 */
const LOCATION_RE = /^(?<file>\S*[^\s/\\]\.[A-Za-z0-9]+):(?<line>\d+)$/;

/** Trailing `.spec` / `.test` plus extension, so `checkout.spec.ts` reads as `checkout`. */
const SPEC_SUFFIX_RE = /\.(spec|test)\.[A-Za-z0-9]+$/;
const EXTENSION_RE = /\.[A-Za-z0-9]+$/;

/* ------------------------------------------------------------------ parsing */

/** A test title split into its parts, with the location line already removed. */
export interface ParsedTestTitle {
  /** Path of the spec file relative to the project's `testDir`, or null for a title without one. */
  file: string | null;
  /**
   * The line the title carried, kept for display only. **Nothing may key on this**: it moves on
   * every unrelated edit above the test.
   */
  line: number | null;
  /** The `describe › … > test` segments, i.e. everything after the location. */
  path: string[];
  /** The canonical title: location line dropped, segments rejoined with a single separator. */
  key: string;
}

/** Split a title on U+203A, trimming each segment and dropping empty ones. */
export function splitTitle(title: string): string[] {
  return title
    .split(TITLE_SEPARATOR)
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .filter((segment) => segment !== '');
}

/** `checkout.spec.ts:12` → `{ file, line }`; anything else → null. */
export function parseLocation(segment: string): { file: string; line: number } | null {
  const match = LOCATION_RE.exec(segment);
  const file = match?.groups?.['file'];
  const line = match?.groups?.['line'];
  if (file === undefined || line === undefined) return null;
  return { file, line: Number.parseInt(line, 10) };
}

/**
 * Parse a test title into the parts the rest of the slice keys on.
 *
 * A title with no location segment — every library-only trace, where the only title is whatever the
 * caller passed to `tracing.start({ title })` — parses with `file: null` and all its segments in
 * `path`. That is the normal case for Tier-1 fixtures, not an error.
 */
export function parseTestTitle(title: string): ParsedTestTitle {
  const segments = splitTitle(title);
  const first = segments[0];
  const location = first === undefined ? null : parseLocation(first);
  const path = location === null ? segments : segments.slice(1);
  const keySegments = location === null ? segments : [location.file, ...path];
  return {
    file: location?.file ?? null,
    line: location?.line ?? null,
    path,
    key: keySegments.join(` ${TITLE_SEPARATOR} `),
  };
}

/**
 * The canonical form of a title: the string every pin, lookup and drift comparison uses.
 *
 * Idempotent by construction — `normalizeTitle(normalizeTitle(t)) === normalizeTitle(t)` — which is
 * what lets a `e2e-map.yaml` key be written either way round and still match.
 */
export function normalizeTitle(title: string): string {
  return parseTestTitle(title).key;
}

/** Whether two titles name the same test once the line number is out of the way. */
export function sameTitle(a: string, b: string): boolean {
  return normalizeTitle(a) === normalizeTitle(b);
}

/* ------------------------------------------------------------------ slugs */

/**
 * A path-safe slug: lower case, runs of anything else collapsed to a single `-`.
 *
 * The output can never trip `paths.assertSafeSegment` — no separator, no control character, no
 * leading dot, never `.` or `..` — because only `[a-z0-9]` survives.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Short, stable discriminator for a title. Never an ordinal, so it does not move. */
function titleDigest(key: string): string {
  return sha256Hex(key).slice(0, SUFFIX_LENGTH);
}

/**
 * Cap a slug's length without letting two long titles that share a prefix become one name: the
 * truncated form always carries a digest of the full key.
 */
function capSlug(slug: string, key: string): string {
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  const room = MAX_SLUG_LENGTH - SUFFIX_LENGTH - 1;
  const cut = slug.slice(0, room);
  const lastDash = cut.lastIndexOf('-');
  const head = (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
  return `${head}-${titleDigest(key)}`;
}

/** `tests/e2e/checkout.spec.ts` → `checkout`: the part of a path worth putting in a flow name. */
export function specStem(file: string): string {
  const base = file.split(/[/\\]/).pop() ?? file;
  const withoutSpec = base.replace(SPEC_SUFFIX_RE, '');
  return withoutSpec === base ? base.replace(EXTENSION_RE, '') : withoutSpec;
}

/**
 * The flow name a test title prefers, before any collision is considered (D26).
 *
 * Built from the spec file's stem plus the describe/test path — not from the full path, which would
 * make every flow read `tests-e2e-checkout-spec-ts-…`, and not from the describe/test path alone,
 * which would merge two same-named tests in different files into one timeline. The full path stays
 * in `titleKey`, so exactness is never traded away for the shorter name.
 *
 * Null when the title carries nothing sluggable — a title of `"---"`, or an empty one. The caller
 * must then fall back to `--flow` or the archive name; inventing a name here would produce a flow
 * nobody can find twice.
 */
export function flowNameForTitle(title: string): string | null {
  const parsed = parseTestTitle(title);
  const parts = parsed.file === null ? parsed.path : [specStem(parsed.file), ...parsed.path];
  const slug = slugify(parts.join(' '));
  if (slug === '') return null;
  return capSlug(slug, parsed.key);
}

/**
 * The flow name for a title, avoiding names already claimed by *other* titles.
 *
 * `taken` is the set of flow names already in use by a different `titleKey` — in practice, the flow
 * names the store has already recorded against other tests. The suffix is a digest of this title,
 * never a counter, so:
 *
 * - the flow that claimed the name first keeps it forever, and no existing history is renamed;
 * - the newcomer's name does not depend on the order the traces were ingested in, so two machines
 *   ingesting the same CI run in different orders produce the same flow names.
 */
export function allocateFlowName(title: string, taken: ReadonlySet<string> = new Set()): string | null {
  const preferred = flowNameForTitle(title);
  if (preferred === null) return null;
  if (!taken.has(preferred)) return preferred;
  const key = normalizeTitle(title);
  const suffixed = capSlug(`${preferred}-${titleDigest(key)}`, key);
  if (!taken.has(suffixed)) return suffixed;
  // Both names are spoken for, which means a *third* title already hashed into this slot. Widen
  // the digest rather than fall back to a counter, so the answer still depends only on the title.
  return capSlug(`${preferred}-${sha256Hex(key).slice(0, SUFFIX_LENGTH * 2)}`, key);
}

/* ------------------------------------------------------------------ step ids */

/** A step title that occurs more than once in one test, and the ids its occurrences were given. */
export interface DuplicateStepTitle {
  title: string;
  /** Every id assigned to this title, in step order; the first is the undecorated one. */
  ids: string[];
}

export interface StepIdAssignment {
  /** One id per input title, in the same order. Unique within the test by construction. */
  ids: string[];
  /** Titles that occurred more than once — what §8 wants reported as a single notice. */
  duplicates: DuplicateStepTitle[];
}

/**
 * Turn one test's ordered step titles into unique step ids (D26).
 *
 * Three cases, and the second and third are the ones a trace really produces:
 *
 * 1. a distinct title slugs to itself;
 * 2. an *unsluggable* title — a library-only trace has no step titles at all, so the reader passes
 *    whatever label it could build, and something like `internal:role=button[name="Fetch"i]` may
 *    reduce to nothing usable — becomes `step-<n>`, so the run still has a well-formed id;
 * 3. a repeat is suffixed with its occurrence number, checked against every id already assigned so
 *    a title that literally reads `run the search 2` cannot be handed the id its neighbour's repeat
 *    was about to take.
 *
 * The ordinal suffix is the weakness D4 warns about, confined to the one place nothing else can
 * distinguish the steps: two identical strings. Everything else is keyed by title.
 */
export function assignStepIds(titles: readonly string[]): StepIdAssignment {
  const ids: string[] = [];
  const used = new Set<string>();
  /** base slug → how many steps have wanted it, and what they were called. */
  const seen = new Map<string, { title: string; ids: string[] }>();

  titles.forEach((title, index) => {
    const base = slugify(title) || `step-${index + 1}`;
    const group = seen.get(base) ?? { title, ids: [] };
    const occurrence = group.ids.length + 1;
    // The suffix is *this title's* occurrence number, so the §8 notice's "the repeats were
    // numbered" is literally true and a reader can count the steps to find the one meant.
    let id = occurrence === 1 ? base : `${base}-${occurrence}`;
    // Only if a differently-titled step already holds that exact id. Repeating the number rather
    // than incrementing it keeps the occurrence readable in the id it produced.
    while (used.has(id)) id = `${id}-${occurrence}`;
    used.add(id);
    ids.push(id);
    group.ids.push(id);
    seen.set(base, group);
  });

  const duplicates: DuplicateStepTitle[] = [];
  for (const group of seen.values()) {
    if (group.ids.length > 1) duplicates.push({ title: group.title, ids: group.ids });
  }
  return { ids, duplicates };
}
