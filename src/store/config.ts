/**
 * store/config — `.visual-diff/config.yaml` (spec §6, "Configuration").
 *
 * ```yaml
 * app:
 *   install: pnpm install --frozen-lockfile
 *   dev:     pnpm dev --port $PORT
 *   readyOn: http://localhost:$PORT/
 *   readyTimeout: 90s
 * diff:
 *   minRegionArea: 64
 *   maxRegions: 40
 *   antialiasTolerance: 0.1
 *   ignore: ["[data-test=session-id]"]
 * network:
 *   redact: ["x-api-key"]
 * retention:
 *   keepRuns: 20
 * e2e:
 *   minRegionArea: 256
 *   antialiasTolerance: 0.25
 * ```
 *
 * Every default comes from `DEFAULTS` in types.ts, so config and code cannot drift apart. The file
 * is validated strictly: an unknown key is an error carrying file, line and the offending key
 * (spec §10, row 1), because a silently ignored `minRegionAre:` typo is how a user concludes the
 * noise controls "don't work".
 *
 * `network.scrub` is deliberately **not** readable from the file: HAR scrubbing is disabled only
 * by an explicit `--no-scrub` (spec §6).
 *
 * ## The `e2e:` block (e2e spec §5)
 *
 * `diff:` sets the noise controls for every pair; `e2e:` overrides them for a pair with an ingested
 * side, because an e2e capture has no frozen clock, no seeded RNG and no settle gate. The values in
 * the example above are the defaults, and this file **does not restate them**: it carries only the
 * keys the user actually wrote, and `diff/e2e-noise.ts` (`E2E_DIFF_DEFAULTS`) fills the rest. That
 * is deliberate — two copies of a provisional threshold is how the value nobody re-measures becomes
 * folklore, which is the failure D27 names outright.
 *
 * The block is validated here rather than at diff time so a bad value is a config error with a line
 * number (exit 2), not a warning discovered halfway through a diff.
 */

import * as path from 'node:path';

import * as YAML from 'yaml';
import { z } from 'zod';

import { configError } from './errors.js';
import { parseDuration } from './internal/duration.js';
import { DEFAULT_KEEP_E2E_RUNS } from './internal/e2e.js';
import type { E2eConfig } from './internal/e2e.js';
import { isDirectory, readTextOrNull } from './internal/fs.js';
import { DEFAULT_KEEP_VARIANT_RUNS } from './internal/variant.js';
import { locate, yamlSyntaxIssues, zodIssues } from './internal/yaml-issues.js';
import type { ParsedYamlDocument } from './internal/yaml-issues.js';
import * as paths from './paths.js';
// Type-only, and erased at emit: the *shape* of the `e2e:` block belongs to the module that owns
// the defaults and applies them (`diff/e2e-noise.ts`), so declaring a second copy of it here is
// exactly the drift the block's own docblock argues against. No runtime edge is created.
import type { E2eNoiseOverrides } from '../diff/e2e-noise.js';
import {
  DEFAULTS,
  type ValidationIssue,
  type ValidationResult,
} from '../types.js';

/* ------------------------------------------------------------------ schema */

const appSchema = z
  .object({
    install: z.string().optional(),
    dev: z.string().min(1),
    readyOn: z.string().min(1),
    readyTimeout: z.string().min(1).optional(),
  })
  .strict();

const diffSchema = z
  .object({
    minRegionArea: z.number().int().nonnegative().optional(),
    maxRegions: z.number().int().positive().optional(),
    antialiasTolerance: z.number().min(0).max(1).optional(),
    ignore: z.array(z.string()).optional(),
  })
  .strict();

const networkSchema = z
  .object({
    redact: z.array(z.string()).optional(),
  })
  .strict();

const retentionSchema = z
  .object({
    keepRuns: z.number().int().positive().optional(),
    /**
     * The second bucket (variants spec §5, D24). Separate from `keepRuns` so exploratory variant
     * runs can never evict the capture history regressions depend on.
     */
    keepVariantRuns: z.number().int().positive().optional(),
    /**
     * The third bucket (e2e spec §7). Separate from `keepRuns` so ingesting a CI run's worth of
     * traces can never evict replay history — the same isolation `keepVariantRuns` provides, for a
     * source of runs that arrives in far larger batches.
     */
    keepE2eRuns: z.number().int().positive().optional(),
  })
  .strict();

/**
 * `e2e:` — the noise controls a pair with an ingested side is diffed under (e2e spec §5, D27).
 *
 * The same two knobs `diff:` exposes, and only those two. `maxRegions` is deliberately absent: it
 * caps how many findings are shown, not how much noise is tolerated, and one cap for the whole tool
 * is one fewer number to keep in agreement. `ignore` is absent for a harder reason — see
 * `store/e2e-map.ts`: nothing can be masked on a run ingested from a trace, because a trace snapshot
 * carries no box metrics, so accepting a mask list here would be accepting a no-op.
 *
 * Bounds match `diffSchema` exactly, so a value that is legal for replay is legal for e2e.
 */
const e2eSchema = z
  .object({
    minRegionArea: z.number().int().nonnegative().optional(),
    antialiasTolerance: z.number().min(0).max(1).optional(),
  })
  .strict();

const configSchema = z
  .object({
    baseUrl: z.string().min(1).optional(),
    app: appSchema,
    diff: diffSchema.optional(),
    network: networkSchema.optional(),
    retention: retentionSchema.optional(),
    e2e: e2eSchema.optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof configSchema>;

/**
 * A fully-defaulted `Config` that also carries the user's `e2e:` overrides.
 *
 * Structural, exactly as `E2eConfig` is over `Config`: `src/types.ts` does not yet carry the block,
 * and every caller that only knows `Config` keeps working because the field is additive and
 * optional. `e2eNoiseOf` in `diff/e2e-noise.ts` is how a caller reads it back.
 */
export type NoiseAwareConfig = E2eConfig & { e2e?: E2eNoiseOverrides };

/**
 * Keys §5's own table invites a user to write, and what they are actually called.
 *
 * §5 tabulates three settings — *pixel threshold*, *minimum region area*, *antialias tolerance* —
 * but the engine has two knobs, because `pixelmatch` exposes a single YIQ colour-delta threshold
 * that doubles as its antialias sensitivity (`diff/e2e-noise.ts` records the measurements). A user
 * transcribing the table therefore lands on a key that does not exist, and a bare "unknown key"
 * would read as *this setting is unavailable* rather than *this setting has another name*.
 */
const E2E_RENAMED_KEYS: Readonly<Record<string, string>> = {
  pixelThreshold: 'antialiasTolerance',
  threshold: 'antialiasTolerance',
  minimumRegionArea: 'minRegionArea',
};

/** The `e2e:` keys that are really other keys, reported before the strict schema calls them unknown. */
function renamedE2eKeyIssues(
  raw: unknown,
  doc: ParsedYamlDocument,
  lineCounter: YAML.LineCounter,
  file: string,
): ValidationIssue[] {
  const block = (raw as { e2e?: unknown } | null)?.e2e;
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return [];
  const issues: ValidationIssue[] = [];
  for (const [written, actual] of Object.entries(E2E_RENAMED_KEYS)) {
    if (!Object.hasOwn(block, written)) continue;
    issues.push({
      code: 'renamed-key',
      message:
        `e2e.${written} is not a setting; the e2e noise controls are e2e.minRegionArea and ` +
        `e2e.antialiasTolerance — write e2e.${actual} instead`,
      at: locate(doc, lineCounter, file, ['e2e', written]),
    });
  }
  return issues;
}

/* ------------------------------------------------------------------ defaults */

/** A fully-defaulted Config. `app` has no defaults: the spec's example always spells it out. */
export function buildConfig(
  root: string,
  file: ConfigFile,
  readyTimeoutMs: number,
): NoiseAwareConfig {
  const config: NoiseAwareConfig = {
    root,
    dir: paths.vdiffDir(root),
    app: {
      dev: file.app.dev,
      readyOn: file.app.readyOn,
      readyTimeoutMs,
    },
    diff: {
      minRegionArea: file.diff?.minRegionArea ?? DEFAULTS.diff.minRegionArea,
      maxRegions: file.diff?.maxRegions ?? DEFAULTS.diff.maxRegions,
      antialiasTolerance: file.diff?.antialiasTolerance ?? DEFAULTS.diff.antialiasTolerance,
      ignore: [...(file.diff?.ignore ?? DEFAULTS.diff.ignore)],
    },
    network: {
      redact: [...(file.network?.redact ?? DEFAULTS.network.redact)],
      // Only `--no-scrub` turns this off (spec §6); the file cannot.
      scrub: DEFAULTS.network.scrub,
    },
    retention: {
      keepRuns: file.retention?.keepRuns ?? DEFAULTS.retention.keepRuns,
      // Not in `DEFAULTS` because `types.ts` does not yet carry the variant axis; the constant
      // lives beside the rest of the axis so config and pruner cannot drift (variants spec §5).
      keepVariantRuns: file.retention?.keepVariantRuns ?? DEFAULT_KEEP_VARIANT_RUNS,
      // Likewise for the e2e bucket (§7): the constant lives beside the source axis it belongs to.
      keepE2eRuns: file.retention?.keepE2eRuns ?? DEFAULT_KEEP_E2E_RUNS,
    },
  };
  if (file.app.install !== undefined) config.app.install = file.app.install;
  if (file.baseUrl !== undefined) config.baseUrl = file.baseUrl;

  // Only what was written. An absent key stays absent all the way to `e2eNoiseSettings`, which is
  // the single place `E2E_DIFF_DEFAULTS` is read — so "what is the e2e minimum region area?" has
  // exactly one answer, and changing it means changing one line.
  if (file.e2e !== undefined) {
    const e2e: E2eNoiseOverrides = {};
    if (file.e2e.minRegionArea !== undefined) e2e.minRegionArea = file.e2e.minRegionArea;
    if (file.e2e.antialiasTolerance !== undefined) {
      e2e.antialiasTolerance = file.e2e.antialiasTolerance;
    }
    config.e2e = e2e;
  }
  return config;
}

/* ------------------------------------------------------------------ parsing */

export function parseConfigSource(
  source: string,
  file: string,
  root: string,
): ValidationResult<NoiseAwareConfig> {
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(source, { lineCounter });

  if (doc.errors.length > 0) {
    return { ok: false, issues: yamlSyntaxIssues(doc, lineCounter, file) };
  }

  const raw = doc.toJS() as unknown;
  if (raw === null || raw === undefined) {
    return {
      ok: false,
      issues: [
        {
          code: 'empty-config',
          message: 'config.yaml is empty; it must at least declare the app section',
          at: { file },
        },
      ],
    };
  }

  // Ahead of the schema, so `e2e.pixelThreshold` is answered with its real name instead of being
  // rejected as an unknown key the user has no way to look up.
  const renamed = renamedE2eKeyIssues(raw, doc, lineCounter, file);
  if (renamed.length > 0) return { ok: false, issues: renamed };

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: zodIssues(parsed.error, doc, lineCounter, file) };
  }

  const readyTimeoutRaw = parsed.data.app.readyTimeout;
  let readyTimeoutMs: number = DEFAULTS.readyTimeoutMs;
  if (readyTimeoutRaw !== undefined) {
    const ms = parseDuration(readyTimeoutRaw);
    if (ms === null) {
      return {
        ok: false,
        issues: [
          {
            code: 'invalid-duration',
            message: `app.readyTimeout "${readyTimeoutRaw}" needs a unit: 90s, 2m, 1500ms`,
            at: locate(doc, lineCounter, file, ['app', 'readyTimeout']),
          },
        ],
      };
    }
    readyTimeoutMs = ms;
  }

  return { ok: true, value: buildConfig(root, parsed.data, readyTimeoutMs), warnings: [] };
}

/* ------------------------------------------------------------------ locating the project */

/** Nearest ancestor of `startDir` containing a `.visual-diff` directory. */
export async function findProjectRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  for (;;) {
    if (await isDirectory(paths.vdiffDir(current))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export interface LoadConfigOptions {
  /** Where to start looking for `.visual-diff`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Skip discovery and use this project root. */
  root?: string;
}

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<ValidationResult<NoiseAwareConfig>> {
  const start = options.cwd ?? process.cwd();
  const root = options.root ?? (await findProjectRoot(start));
  if (root === null) {
    return {
      ok: false,
      issues: [
        {
          code: 'no-project',
          message: `no ${paths.VISUAL_DIFF_DIRNAME}/ directory found in ${start} or any parent`,
          at: { file: start },
        },
      ],
    };
  }
  const file = paths.configFile(root);
  const source = await readTextOrNull(file);
  if (source === null) {
    return {
      ok: false,
      issues: [
        {
          code: 'config-missing',
          message: `${file} does not exist`,
          at: { file },
        },
      ],
    };
  }
  return parseConfigSource(source, file, root);
}

/** Load or fail with exit code 2 (spec §9, "config or spec error"). */
export async function loadConfigOrThrow(
  options: LoadConfigOptions = {},
): Promise<NoiseAwareConfig> {
  const result = await loadConfig(options);
  if (result.ok) return result.value;
  const first = result.issues[0];
  const where =
    first === undefined
      ? ''
      : ` (${first.at.file}${first.at.line === undefined ? '' : `:${first.at.line}`})`;
  throw configError(
    first?.code ?? 'invalid-config',
    `${first?.message ?? 'invalid configuration'}${where}`,
    { issues: result.issues },
  );
}
