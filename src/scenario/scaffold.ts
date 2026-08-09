/**
 * `vdiff scenario new <name>` scaffolding (mocking spec §7).
 *
 * The scaffold's job is to be valid on the first parse and to teach the three things an author has
 * to get right, none of which is guessable from an empty file:
 *
 *   1. exactly one response verb per rule, with `delay` as a modifier that composes;
 *   2. rule ids are stable and load-bearing — they are what the report names when it attributes a
 *      changed response, and renaming one severs that rule's history;
 *   3. `overlay` patches a recording and `mock` does not have one, which is why `patch` is refused
 *      in mock mode rather than quietly producing a body made only of the patch.
 *
 * The two modes get different bodies, because a `mock` scaffold containing `patch` would fail the
 * validator the moment it was written — the scaffold must never be an example of a rejection.
 */

import { DEFAULTS, type ScenarioMode, type ScenarioSpec } from '../types.js';
import { assertScenarioName } from './name.js';
import { serializeScenario } from './serialize.js';

export interface ScaffoldOptions {
  /** `overlay` (the default) patches a recording; `mock` runs without one. */
  mode?: ScenarioMode;
  /** One line about what state this scenario puts the UI in. */
  description?: string;
  /** URL glob the example rule matches. Defaults to a wildcard over `/api/`. */
  url?: string;
}

const DEFAULT_URL = '**/api/**';

/** The ScenarioSpec behind a scaffold. Valid by construction. */
export function scaffoldScenarioSpec(name: string, options: ScaffoldOptions = {}): ScenarioSpec {
  assertScenarioName(name);

  const mode: ScenarioMode = options.mode ?? DEFAULTS.scenarioMode;
  const url = options.url ?? DEFAULT_URL;
  const description = options.description ?? describeDefault(name, mode);

  return {
    version: 1,
    scenario: name,
    description,
    mode,
    rules: [
      mode === 'mock'
        ? {
            id: 'example',
            match: { method: 'GET', url },
            respond: {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: { items: [] },
            },
          }
        : {
            id: 'example',
            match: { method: 'GET', url },
            patch: { items: [] },
          },
    ],
  };
}

/** The YAML written to `.visual-diff/scenarios/<name>.yaml`: a header comment plus the spec. */
export function scaffoldScenarioSource(name: string, options: ScaffoldOptions = {}): string {
  const spec = scaffoldScenarioSpec(name, options);
  return `${header(name, spec.mode)}${serializeScenario(spec)}`;
}

function describeDefault(name: string, mode: ScenarioMode): string {
  return mode === 'mock'
    ? `${name} — responses invented outright, for UI whose backend does not exist yet`
    : `${name} — what the UI looks like when the API answers this way`;
}

function header(name: string, mode: ScenarioMode): string {
  const lines = [
    `# .visual-diff/scenarios/${name}.yaml — scenario spec v1`,
    '#',
    '# A scenario is an overlay on recorded traffic: the recording stays the baseline and this file',
    '# is an explicit delta from it. Run it with:  vdiff run <flow> --scenario ' + name,
    '#',
    '# Each rule is one match plus exactly ONE response verb:',
    '#   patch     RFC 7386 merge patch of the recorded JSON body (null at a key deletes it)',
    '#   patchOps  RFC 6902 operations, for the array indices and removals merge patch cannot say',
    '#   respond   a whole synthetic response: status, headers, body',
    '#   abort     fail the request',
    '# plus the modifier:',
    '#   delay     milliseconds, composes with any verb and is legal on its own',
    '#',
    '# Two verbs on one rule is an error rather than an invented precedence order.',
    '#',
    '# match.url is a glob over the FULL url, query string included: * stops at /, ** crosses it.',
    '# match.nth picks the nth occurrence of an otherwise identical request, counting from 1.',
    '# First match wins in file order; unmatched requests are served from the recording.',
    '#',
    '# Rule ids are stable and load-bearing: the report says "modified by rule <id>", and renaming',
    '# an id severs that rule\'s history. Changing its match does not.',
  ];

  if (mode === 'mock') {
    lines.push(
      '#',
      '# mode: mock means there is no recording at all. patch and patchOps are rejected here —',
      '# a merge patch against a body that does not exist would produce whatever the patch alone',
      '# contains, which looks like it worked. Unmatched requests are aborted and reported as misses.',
    );
  } else {
    lines.push(
      '#',
      '# mode: overlay needs the flow to have a recording. Switch to mock only for UI whose backend',
      '# does not exist yet; a mock run is badged in the report, because it is a fiction.',
    );
  }

  lines.push('');
  return lines.join('\n');
}
