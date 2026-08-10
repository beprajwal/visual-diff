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
 * ```
 *
 * Every default comes from `DEFAULTS` in types.ts, so config and code cannot drift apart. The file
 * is validated strictly: an unknown key is an error carrying file, line and the offending key
 * (spec §10, row 1), because a silently ignored `minRegionAre:` typo is how a user concludes the
 * noise controls "don't work".
 *
 * `network.scrub` is deliberately **not** readable from the file: HAR scrubbing is disabled only
 * by an explicit `--no-scrub` (spec §6).
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
import * as paths from './paths.js';
import {
  DEFAULTS,
  type Config,
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

const configSchema = z
  .object({
    baseUrl: z.string().min(1).optional(),
    app: appSchema,
    diff: diffSchema.optional(),
    network: networkSchema.optional(),
    retention: retentionSchema.optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof configSchema>;

/* ------------------------------------------------------------------ defaults */

/** A fully-defaulted Config. `app` has no defaults: the spec's example always spells it out. */
export function buildConfig(
  root: string,
  file: ConfigFile,
  readyTimeoutMs: number,
): E2eConfig {
  const config: E2eConfig = {
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
  return config;
}

/* ------------------------------------------------------------------ parsing */

export function parseConfigSource(
  source: string,
  file: string,
  root: string,
): ValidationResult<Config> {
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
): Promise<ValidationResult<Config>> {
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
export async function loadConfigOrThrow(options: LoadConfigOptions = {}): Promise<Config> {
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
