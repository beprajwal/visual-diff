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
import { isDirectory, readTextOrNull } from './internal/fs.js';
import * as paths from './paths.js';
import {
  DEFAULTS,
  type Config,
  type SourceLocation,
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

/* ------------------------------------------------------------------ locating issues */

/** Derived from the function rather than named directly, so a yaml type rename cannot break us. */
type ParsedYamlDocument = ReturnType<typeof YAML.parseDocument>;

function formatKeyPath(keyPath: readonly (string | number)[]): string {
  let out = '';
  for (const part of keyPath) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out === '' ? part : `.${part}`;
  }
  return out;
}

function nodeRange(node: unknown): number | null {
  if (node !== null && typeof node === 'object' && 'range' in node) {
    const range = (node as { range?: unknown }).range;
    if (Array.isArray(range) && typeof range[0] === 'number') return range[0];
  }
  return null;
}

/**
 * Point at the offending key, falling back to the nearest ancestor that exists in the document —
 * which is what a missing required key needs, since the key itself has no node.
 */
function locate(
  doc: ParsedYamlDocument,
  lineCounter: YAML.LineCounter,
  file: string,
  keyPath: readonly (string | number)[],
): SourceLocation {
  const key = keyPath.length === 0 ? undefined : formatKeyPath(keyPath);
  for (let i = keyPath.length; i >= 0; i -= 1) {
    const prefix = keyPath.slice(0, i);
    let node: unknown;
    try {
      node = prefix.length === 0 ? doc.contents : doc.getIn(prefix, true);
    } catch {
      node = undefined;
    }
    const offset = nodeRange(node);
    if (offset !== null) {
      const pos = lineCounter.linePos(offset);
      const at: SourceLocation = { file, line: pos.line, column: pos.col };
      if (key !== undefined) at.key = key;
      return at;
    }
  }
  const at: SourceLocation = { file };
  if (key !== undefined) at.key = key;
  return at;
}

function zodIssues(
  error: z.ZodError,
  doc: ParsedYamlDocument,
  lineCounter: YAML.LineCounter,
  file: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const keyPath = [...issue.path, key];
        issues.push({
          code: 'unknown-key',
          message: `unknown key "${formatKeyPath(keyPath)}"`,
          at: locate(doc, lineCounter, file, keyPath),
        });
      }
      continue;
    }
    if (issue.code === 'invalid_type' && issue.received === 'undefined') {
      issues.push({
        code: 'missing-key',
        message: `missing required key "${formatKeyPath(issue.path)}"`,
        at: locate(doc, lineCounter, file, issue.path),
      });
      continue;
    }
    issues.push({
      code: issue.code === 'invalid_type' ? 'invalid-type' : 'invalid-value',
      message: `${formatKeyPath(issue.path) || 'config'}: ${issue.message}`,
      at: locate(doc, lineCounter, file, issue.path),
    });
  }
  return issues;
}

/* ------------------------------------------------------------------ defaults */

/** A fully-defaulted Config. `app` has no defaults: the spec's example always spells it out. */
export function buildConfig(root: string, file: ConfigFile, readyTimeoutMs: number): Config {
  const config: Config = {
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
    return {
      ok: false,
      issues: doc.errors.map((err) => {
        const offset = Array.isArray(err.pos) && typeof err.pos[0] === 'number' ? err.pos[0] : null;
        const pos = offset === null ? null : lineCounter.linePos(offset);
        const at: SourceLocation = { file };
        if (pos !== null) {
          at.line = pos.line;
          at.column = pos.col;
        }
        return { code: 'invalid-yaml', message: err.message, at };
      }),
    };
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
