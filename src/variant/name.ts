/**
 * Variant names and the paths derived from them (variants spec §4 Storage, §5, §6).
 *
 * A variant name is not a path component: run identity is `(flow, revision, scenario, variant)` and
 * §5 records the variant in `meta.json` "exactly as `scenario` does (D12)", which is what spares it
 * from case-insensitive filesystems and reserved device names. It *is* the stem of its own spec
 * file, though, and it is echoed into `meta.json`, the CLI and the report, so it is held to the
 * same shape a flow name is.
 *
 * `none` is refused outright (§7): it is what a run captured without a variant records, so a file
 * of that name could never be selected.
 */

import type { ValidationIssue } from '../types.js';
import { VariantSpecError } from './errors.js';
import { SAFE_VARIANT_NAME_RE, VARIANTS_DIRNAME } from './schema.js';
import {
  VARIANT_NONE,
  VARIANT_VERBS,
  type VariantSpec,
  type VariantSummary,
  type VariantVerb,
} from './types.js';

/**
 * The store's own directory name. Restated here rather than imported from `store/paths.ts` so the
 * variant layer stays as free of dependencies as the flow and scenario layers are; all three spell
 * it the same way and `store/paths.ts` remains the authority for every path the store builds.
 */
const VDIFF_DIRNAME = '.visual-diff';

/** `denser-forecast.yaml` */
export function variantFileName(name: string): string {
  return `${name}.yaml`;
}

/** `variants/denser-forecast.yaml` — relative to `.visual-diff/`, as `VariantSummary.path` is. */
export function variantRelPath(name: string): string {
  return `${VARIANTS_DIRNAME}/${variantFileName(name)}`;
}

/** Path inside the repository, as `git show <sha>:<path>` wants it for historical replay (D4). */
export function variantRepoPath(name: string): string {
  return `${VDIFF_DIRNAME}/${variantRelPath(name)}`;
}

/**
 * Why `name` cannot be a variant name, as a `ValidationIssue`, or null when it can. `at.file` is
 * the file the name *would* produce, which is the only file there is to point at when the name came
 * from the command line rather than from a spec.
 */
export function variantNameIssue(name: string): ValidationIssue | null {
  const at = { file: variantFileName(name), key: 'variant' };

  if (name === VARIANT_NONE) {
    return {
      code: 'reserved-variant-name',
      message:
        `'${VARIANT_NONE}' is a reserved variant name: it is what a run captured without a ` +
        'variant records in meta.json, and what a variant run is diffed against, so no variant ' +
        'file may take it. Pick another name',
      at,
    };
  }
  if (!SAFE_VARIANT_NAME_RE.test(name)) {
    return {
      code: 'invalid-variant-name',
      message:
        `invalid variant name '${name}': a variant is stored as ` +
        `${VDIFF_DIRNAME}/${VARIANTS_DIRNAME}/<name>.yaml and named in meta.json, so it must ` +
        'start with a letter or digit and contain only letters, digits, dot, dash or underscore',
      at,
    };
  }
  return null;
}

export function isValidVariantName(name: string): boolean {
  return variantNameIssue(name) === null;
}

/** Throws `VariantSpecError` (exit 2) for a name that cannot be used. */
export function assertVariantName(name: string): void {
  const issue = variantNameIssue(name);
  if (issue !== null) throw new VariantSpecError(issue.at.file, [issue]);
}

/** One row of `vdiff variant list` (variants spec §6). */
export function variantSummary(spec: VariantSpec): VariantSummary {
  const used = new Set<VariantVerb>();
  for (const rule of spec.rules) {
    for (const verb of VARIANT_VERBS) {
      if (Object.prototype.hasOwnProperty.call(rule, verb)) used.add(verb);
    }
  }

  const summary: VariantSummary = {
    name: spec.variant,
    ruleCount: spec.rules.length,
    // VARIANT_VERBS order, not first-use order: a list that reorders itself when a rule is edited
    // is a diff in every report that shows it.
    verbs: VARIANT_VERBS.filter((verb) => used.has(verb)),
    path: variantRelPath(spec.variant),
  };
  if (spec.description !== undefined) summary.description = spec.description;
  return summary;
}
