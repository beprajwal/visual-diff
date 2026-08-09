/**
 * Post-schema semantic validation (spec §6, §10).
 *
 * Everything here needs knowledge the shape schema cannot express: id uniqueness across the step
 * list, the "WIDTHxHEIGHT" viewport grammar, and `har` being required whenever the network is
 * recorded or replayed. Each failure names the offending key so the CLI can print
 * file + line + key and exit 2.
 */

import type { FlowSpec, SourceLocation, ValidationIssue } from '../types.js';
import { SAFE_NAME_RE, VIEWPORT_RE } from './schema.js';

/** Resolves a key path (e.g. `['steps', 2, 'id']`) to a file/line/column/key location. */
export type Locate = (path: ReadonlyArray<string | number>) => SourceLocation;

export interface ValidateOptions {
  /**
   * Flow name the caller expected — normally the file's basename. A mismatch is a warning, never an
   * error, so `flow.snapshot.yaml` and ad-hoc filenames still load.
   */
  expectFlowName?: string;
}

export interface ValidateOutcome {
  issues: ValidationIssue[];
  warnings: ValidationIssue[];
}

export function validateFlowSpec(
  spec: FlowSpec,
  locate: Locate,
  options: ValidateOptions = {},
): ValidateOutcome {
  const issues: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  /* ---------------------------------------------------------------- flow identity */

  if (!SAFE_NAME_RE.test(spec.flow)) {
    issues.push({
      code: 'invalid-flow-name',
      message:
        `invalid flow name '${spec.flow}': a flow name is used as a directory name under runs/, ` +
        'so it must start with a letter or digit and contain only letters, digits, dot, dash or underscore',
      at: locate(['flow']),
    });
  }

  if (options.expectFlowName !== undefined && options.expectFlowName !== spec.flow) {
    warnings.push({
      code: 'flow-name-mismatch',
      message: `flow is named '${spec.flow}' but the file is named '${options.expectFlowName}'`,
      at: locate(['flow']),
    });
  }

  /* ---------------------------------------------------------------- viewports */

  const seenViewports = new Map<string, number>();
  spec.viewports.forEach((viewport, index) => {
    if (!VIEWPORT_RE.test(viewport)) {
      issues.push({
        code: 'invalid-viewport',
        message: `invalid viewport '${viewport}': expected WIDTHxHEIGHT, e.g. 1280x800`,
        at: locate(['viewports', index]),
      });
      return;
    }
    const first = seenViewports.get(viewport);
    if (first !== undefined) {
      issues.push({
        code: 'duplicate-viewport',
        message: `duplicate viewport '${viewport}' (already listed at viewports[${first}])`,
        at: locate(['viewports', index]),
      });
      return;
    }
    seenViewports.set(viewport, index);
  });

  /* ---------------------------------------------------------------- network */

  const { mode, har } = spec.network;
  if ((mode === 'record' || mode === 'replay') && (har === undefined || har.trim() === '')) {
    issues.push({
      code: 'har-required',
      message: `network.har is required when network.mode is '${mode}'`,
      at: locate(['network', 'har']),
    });
  }
  // `mock` has no recording behind it (mocking spec D13), so a `har` here is not merely redundant
  // the way it is under `off` — it suggests the author believes the recording is being consulted,
  // which is exactly the misunderstanding that makes a mock run read as a measurement.
  if ((mode === 'off' || mode === 'mock') && har !== undefined) {
    warnings.push({
      code: 'har-ignored',
      message: `network.har '${har}' is ignored because network.mode is '${mode}'`,
      at: locate(['network', 'har']),
    });
  }

  /* ---------------------------------------------------------------- steps */

  const seenIds = new Map<string, number>();
  spec.steps.forEach((step, index) => {
    const idPath = ['steps', index, 'id'] as const;

    if (!SAFE_NAME_RE.test(step.id)) {
      issues.push({
        code: 'invalid-id',
        message:
          `invalid step id '${step.id}': step directories are named by id (spec §6), so an id must ` +
          'start with a letter or digit and contain only letters, digits, dot, dash or underscore',
        at: locate(idPath),
      });
    }

    const first = seenIds.get(step.id);
    if (first !== undefined) {
      issues.push({
        code: 'duplicate-id',
        message:
          `duplicate step id '${step.id}' (already used by steps[${first}]). Step ids are the key ` +
          'the diff aligns runs by, so they must be unique within a flow',
        at: locate(idPath),
      });
    } else {
      seenIds.set(step.id, index);
    }

    if (step.viewport !== undefined && !VIEWPORT_RE.test(step.viewport)) {
      issues.push({
        code: 'invalid-viewport',
        message: `invalid viewport '${step.viewport}': expected WIDTHxHEIGHT, e.g. 1280x800`,
        at: locate(['steps', index, 'viewport']),
      });
    }

    if (step.fill !== undefined && Object.keys(step.fill).length === 0) {
      issues.push({
        code: 'empty-fill',
        message: 'fill needs at least one selector-to-value entry',
        at: locate(['steps', index, 'fill']),
      });
    }
  });

  return { issues, warnings };
}
