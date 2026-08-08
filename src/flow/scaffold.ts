/**
 * `vdiff flow new <name>` scaffolding (spec §9).
 *
 * Produces a spec that is valid on the first parse and that teaches the two things an author has to
 * get right: the closed vocabulary (with `sleep` called out as refused) and stable step ids, which
 * are load-bearing for D4 rather than a convenience.
 */

import { DEFAULTS, type FlowSpec, type ViewportId } from '../types.js';
import { SpecError } from './errors.js';
import { SAFE_NAME_RE } from './schema.js';
import { serializeFlow } from './serialize.js';

export interface ScaffoldOptions {
  /** Defaults to the Vite dev server address used throughout the spec. */
  baseUrl?: string;
  viewports?: ViewportId[];
  /** HAR filename relative to `.visual-diff/flows/`. Defaults to `<name>.har`. */
  har?: string;
}

const DEFAULT_BASE_URL = 'http://localhost:5173';

/** The FlowSpec behind a scaffold. Valid by construction. */
export function scaffoldFlowSpec(name: string, options: ScaffoldOptions = {}): FlowSpec {
  assertFlowName(name);
  return {
    version: 1,
    flow: name,
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    viewports: options.viewports ?? [...DEFAULTS.viewports],
    network: { mode: 'replay', har: options.har ?? `${name}.har` },
    steps: [
      {
        id: 'home',
        goto: '/',
        waitFor: 'body',
        shoot: true,
      },
    ],
  };
}

/** The YAML written to `.visual-diff/flows/<name>.yaml`: a header comment plus the canonical spec. */
export function scaffoldFlowSource(name: string, options: ScaffoldOptions = {}): string {
  return `${header(name)}${serializeFlow(scaffoldFlowSpec(name, options))}`;
}

function header(name: string): string {
  return [
    `# .visual-diff/flows/${name}.yaml — flow spec v1`,
    '#',
    '# A flow is a declarative workflow replayed against one revision at a time. Closed vocabulary:',
    '#   goto      navigate, relative to baseUrl        waitFor   wait for a selector or text=',
    '#   click     click a selector                     viewport  resize for this step onward',
    '#   fill      { selector: value, ... }             mask      selectors painted over before capture',
    '#   press     keyboard key                         shoot     capture this step (default true)',
    '#   hover     hover a selector                     expect    assertions on the page',
    '#   scroll    { selector | x | y | to }',
    '#',
    '# There is no sleep: a fixed wait is how a half-rendered frame gets captured. Use waitFor.',
    '#',
    '# Step ids are stable and load-bearing: runs are aligned by id, never by index, and each step',
    '# owns a directory named after its id. Rename an id and its history restarts.',
    '#',
    '# Use mask for clocks, order ids and relative timestamps, or they produce a finding every run.',
    '',
  ].join('\n');
}

function assertFlowName(name: string): void {
  if (SAFE_NAME_RE.test(name)) return;
  throw new SpecError(`${name}.yaml`, [
    {
      code: 'invalid-flow-name',
      message:
        `invalid flow name '${name}': a flow name is used as a directory name under runs/, so it ` +
        'must start with a letter or digit and contain only letters, digits, dot, dash or underscore',
      at: { file: `${name}.yaml`, key: 'flow' },
    },
  ]);
}
