/**
 * store/e2e-map — `.visual-diff/e2e-map.yaml` (e2e spec D26, §5, §8).
 *
 * ```yaml
 * flows:
 *   "checkout.spec.ts › checkout › shows the cart": cart
 * steps:
 *   "checkout.spec.ts › checkout › shows the cart":
 *     "open the dashboard": dashboard
 * ```
 *
 * D26 derives a flow name from a test title and a step id from a step title, which is the only
 * thing a trace offers — and titles were not designed as identifiers. This file is the escape
 * hatch: it pins a title to an id "for suites that rename often", so a rename costs one line here
 * instead of a removed-and-added flow.
 *
 * Three properties matter, and each is here because getting it wrong is silent.
 *
 * - **Keys are matched on the normalised title**, so a pin written with the `:12` still in it, or
 *   with different spacing around the separator, matches the trace it was written for. Two keys
 *   that normalise to one title are refused rather than resolved by document order — the loser
 *   would silently do nothing, which is the exact failure §8 exists to prevent.
 * - **Pinned names are validated as path segments at load time.** A flow name becomes
 *   `runs/<flow>/`, so `../..` in a hand-written pin must fail here, with the file and line,
 *   rather than at the first ingest.
 * - **Every pin records whether it was used.** `unmatched()` is what produces the §8 run warning,
 *   which the spec is explicit about: "a stale map entry silently doing nothing is the same failure
 *   as a never-matched scenario rule".
 *
 * ## `ignore:` is refused, and why
 *
 * §5 proposes an `ignore` list here — "clocks, ids and animated regions, which no amount of
 * threshold tuning handles correctly" — and it cannot be built. Masking is a geometric operation:
 * the engine matches a selector against a captured node, takes that node's rect, and subtracts the
 * rect from the pixel diff (`diff/viewportDiff.ts`, `exclusionRects`). A Playwright trace's DOM
 * snapshot carries attributes but no box metrics, so every ingested node's rect is `0×0`
 * (`e2e/to-shots.ts`, `UNAVAILABLE_RECT`) and subtracting it subtracts nothing. Measured, not
 * assumed: an ignore selector that suppresses a finding on a replay pair suppresses none of it on
 * the same pair ingested.
 *
 * So the key is parsed — purely so it can be named — and then **refused**, with the file and the
 * line. The alternative was to accept the list, carry it to the engine and have it mask nothing,
 * which is the failure this whole file exists to prevent, one field over: a user reading the
 * resulting findings as real regressions because they believe the clock is covered.
 */

import * as YAML from 'yaml';
import { z } from 'zod';

import { configError } from './errors.js';
import { normalizeTitle, TITLE_SEPARATOR } from './internal/e2e-title.js';
import { unmatchedMapWarning } from './internal/e2e.js';
import type { E2eRunWarning } from './internal/e2e.js';
import { readTextOrNull } from './internal/fs.js';
import { locate, yamlSyntaxIssues, zodIssues } from './internal/yaml-issues.js';
import * as paths from './paths.js';
import type { SourceLocation, ValidationIssue, ValidationResult } from '../types.js';

/* ------------------------------------------------------------------ schema */

const mapSchema = z
  .object({
    /** Test title → flow name. */
    flows: z.record(z.string().min(1)).optional(),
    /** Test title → (step title → step id). */
    steps: z.record(z.record(z.string().min(1))).optional(),
    /**
     * §5's proposed mask list. Accepted by the schema **only** so it can be rejected by name: a
     * bare "unknown key" would read as a typo in a key the spec documents, when the truth is that
     * the feature cannot exist on an ingested run at all. See {@link IGNORE_UNSUPPORTED_MESSAGE}.
     */
    ignore: z.array(z.string()).optional(),
  })
  .strict();

export type E2eMapFile = z.infer<typeof mapSchema>;

/* ------------------------------------------------------------------ the loaded map */

export interface E2eMap {
  /** Absolute path the map was read from, for error and warning text. */
  file: string;
  /** Normalised test title → flow name. */
  flows: Map<string, string>;
  /** Normalised test title → (step title → step id). */
  steps: Map<string, Map<string, string>>;
}

/** The map a project with no `e2e-map.yaml` has: empty, and not an error (the file is optional). */
export function emptyE2eMap(file: string): E2eMap {
  return { file, flows: new Map(), steps: new Map() };
}

/**
 * Why `ignore:` is refused. One string, asserted by the test that owns this behaviour, so the
 * explanation can never drift from the rejection.
 *
 * It says three things on purpose: that the list would do nothing, *why* it would do nothing, and
 * what to reach for instead. A refusal without the third part just moves the user's confusion.
 */
export const IGNORE_UNSUPPORTED_MESSAGE =
  'e2e-map.yaml "ignore" cannot be applied: a Playwright trace snapshot records element ' +
  'attributes but no box metrics, so every ingested element has a 0x0 rect and no selector can be ' +
  'turned into a masked region — the list would suppress nothing. Remove it; tune ' +
  'e2e.minRegionArea and e2e.antialiasTolerance in config.yaml instead, and mask at capture time ' +
  'in the test suite itself if a region must not be compared.';

/* ------------------------------------------------------------------ parsing */

function issue(code: string, message: string, at: SourceLocation): ValidationIssue {
  return { code, message, at };
}

/**
 * Reject a pinned name that could not be a directory. `paths.assertSafeSegment` is the same guard
 * the store applies at write time; running it here turns "the ingest exploded" into "line 4 of
 * e2e-map.yaml".
 */
function segmentIssue(
  kind: string,
  value: string,
  doc: ReturnType<typeof YAML.parseDocument>,
  lineCounter: YAML.LineCounter,
  file: string,
  keyPath: readonly (string | number)[],
): ValidationIssue | null {
  try {
    paths.assertSafeSegment(kind, value);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : `${kind} "${value}" is not usable`;
    return issue('unsafe-name', message, locate(doc, lineCounter, file, keyPath));
  }
}

export function parseE2eMapSource(source: string, file: string): ValidationResult<E2eMap> {
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(source, { lineCounter });

  if (doc.errors.length > 0) {
    return { ok: false, issues: yamlSyntaxIssues(doc, lineCounter, file) };
  }

  const raw = doc.toJS() as unknown;
  // An empty file is an empty map, not a mistake: commenting every pin out is a legitimate state.
  if (raw === null || raw === undefined) return { ok: true, value: emptyE2eMap(file), warnings: [] };

  const parsed = mapSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: zodIssues(parsed.error, doc, lineCounter, file) };
  }

  const issues: ValidationIssue[] = [];
  const map = emptyE2eMap(file);

  // First, so the answer to "why are my clocks still showing up" is the first line of the error
  // rather than the last, and so it is reported even when the pins below are also wrong.
  if (parsed.data.ignore !== undefined) {
    issues.push(
      issue(
        'e2e-ignore-unsupported',
        IGNORE_UNSUPPORTED_MESSAGE,
        locate(doc, lineCounter, file, ['ignore']),
      ),
    );
  }

  // Where each normalised title came from, so a collision names both original spellings.
  const flowKeySource = new Map<string, string>();
  for (const [title, flow] of Object.entries(parsed.data.flows ?? {})) {
    const key = normalizeTitle(title);
    if (key === '') {
      issues.push(
        issue(
          'empty-title',
          `flows key "${title}" has no title in it once normalised`,
          locate(doc, lineCounter, file, ['flows', title]),
        ),
      );
      continue;
    }
    const previous = flowKeySource.get(key);
    if (previous !== undefined) {
      issues.push(
        issue(
          'duplicate-pin',
          `flows keys "${previous}" and "${title}" both name the test "${key}"; ` +
            'one of the two pins would silently do nothing',
          locate(doc, lineCounter, file, ['flows', title]),
        ),
      );
      continue;
    }
    const unsafe = segmentIssue('flow', flow, doc, lineCounter, file, ['flows', title]);
    if (unsafe !== null) {
      issues.push(unsafe);
      continue;
    }
    flowKeySource.set(key, title);
    map.flows.set(key, flow);
  }

  const stepKeySource = new Map<string, string>();
  for (const [title, stepMap] of Object.entries(parsed.data.steps ?? {})) {
    const key = normalizeTitle(title);
    if (key === '') {
      issues.push(
        issue(
          'empty-title',
          `steps key "${title}" has no title in it once normalised`,
          locate(doc, lineCounter, file, ['steps', title]),
        ),
      );
      continue;
    }
    const previous = stepKeySource.get(key);
    if (previous !== undefined) {
      issues.push(
        issue(
          'duplicate-pin',
          `steps keys "${previous}" and "${title}" both name the test "${key}"; ` +
            'one of the two pins would silently do nothing',
          locate(doc, lineCounter, file, ['steps', title]),
        ),
      );
      continue;
    }
    stepKeySource.set(key, title);
    const pins = new Map<string, string>();
    for (const [stepTitle, stepId] of Object.entries(stepMap)) {
      const unsafe = segmentIssue('step id', stepId, doc, lineCounter, file, [
        'steps',
        title,
        stepTitle,
      ]);
      if (unsafe !== null) {
        issues.push(unsafe);
        continue;
      }
      pins.set(stepTitle, stepId);
    }
    map.steps.set(key, pins);
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: map, warnings: [] };
}

/** Load `.visual-diff/e2e-map.yaml`. A missing file is an empty map, not an error. */
export async function loadE2eMap(root: string): Promise<ValidationResult<E2eMap>> {
  const file = paths.e2eMapFile(root);
  const source = await readTextOrNull(file);
  if (source === null) return { ok: true, value: emptyE2eMap(file), warnings: [] };
  return parseE2eMapSource(source, file);
}

/** Load or fail with exit code 2, as `loadConfigOrThrow` does for `config.yaml` (§8). */
export async function loadE2eMapOrThrow(root: string): Promise<E2eMap> {
  const result = await loadE2eMap(root);
  if (result.ok) return result.value;
  const first = result.issues[0];
  const where =
    first === undefined
      ? ''
      : ` (${first.at.file}${first.at.line === undefined ? '' : `:${first.at.line}`})`;
  throw configError(
    first?.code ?? 'invalid-e2e-map',
    `${first?.message ?? `invalid ${paths.E2E_MAP_FILENAME}`}${where}`,
    { issues: result.issues },
  );
}

/* ------------------------------------------------------------------ using the map */

/**
 * A map plus the record of which pins were consulted.
 *
 * Stateful on purpose. §8 requires a run warning listing pins no trace matched, and the only way to
 * know that is to watch every lookup: a pin is "used" when a title actually asked for it, not when
 * it merely parses.
 */
export interface E2eMapper {
  readonly map: E2eMap;
  /** The pinned flow name for a test title, or null to derive one. Marks the pin used. */
  flowFor(testTitle: string): string | null;
  /** The pinned step id, or null to derive one. Marks the pin used. */
  stepIdFor(testTitle: string, stepTitle: string): string | null;
  /** Pins nothing asked for, as displayable titles, in file order. */
  unmatched(): string[];
  /** The §8 warning for those pins, or null when every pin was used. */
  unmatchedWarning(): E2eRunWarning | null;
}

export function createE2eMapper(map: E2eMap): E2eMapper {
  const usedFlows = new Set<string>();
  // "<test key>\u0000<step title>" — NUL cannot appear in either half of a YAML scalar key here.
  const usedSteps = new Set<string>();

  const stepPinKey = (test: string, step: string): string => `${test}\u0000${step}`;

  return {
    map,

    flowFor(testTitle: string): string | null {
      const key = normalizeTitle(testTitle);
      const pinned = map.flows.get(key);
      if (pinned === undefined) return null;
      usedFlows.add(key);
      return pinned;
    },

    stepIdFor(testTitle: string, stepTitle: string): string | null {
      const key = normalizeTitle(testTitle);
      const pinned = map.steps.get(key)?.get(stepTitle);
      if (pinned === undefined) return null;
      usedSteps.add(stepPinKey(key, stepTitle));
      return pinned;
    },

    unmatched(): string[] {
      const out: string[] = [];
      for (const key of map.flows.keys()) {
        if (!usedFlows.has(key)) out.push(key);
      }
      for (const [key, pins] of map.steps) {
        for (const stepTitle of pins.keys()) {
          if (!usedSteps.has(stepPinKey(key, stepTitle))) {
            // Named as the pin is scoped, so "run the search" is not reported as a bare string a
            // user then has to hunt for across every test in the file.
            out.push(`${key} ${TITLE_SEPARATOR} ${stepTitle}`);
          }
        }
      }
      return out;
    },

    unmatchedWarning(): E2eRunWarning | null {
      return unmatchedMapWarning(this.unmatched());
    },
  };
}
