/**
 * `vdiff variant new <name>` scaffolding (variants spec §6).
 *
 * The scaffold's job is to be valid on the first parse and to teach the four things an author has
 * to get right, none of which is guessable from an empty file:
 *
 *   1. **a variant cannot invent UI** (§1) — every element a rule shows is one the application
 *      already rendered, which is why there is no verb that takes markup and never will be (§2);
 *   2. exactly one verb per rule, out of a closed vocabulary of five (D21);
 *   3. rule ids are stable and load-bearing — they are what the report names when it attributes a
 *      modified element, and renaming one severs that rule's history;
 *   4. rules are applied once, just before capture, and a rule that matches nothing is a warning
 *      rather than a failure — so the run still produces a screenshot, and the screenshot is of the
 *      unmodified page (§7).
 *
 * The scaffolded rule uses `style`, the verb with the least that can go wrong: it needs no second
 * selector, no source page and no reference element, so a first `vdiff variant check` fails only if
 * the author's own selector is wrong.
 */

import { assertVariantName } from './name.js';
import { serializeVariant } from './serialize.js';
import { VARIANT_VERBS, type VariantSpec } from './types.js';

export interface ScaffoldOptions {
  /** One line about what this variant proposes. */
  description?: string;
  /** Selector the example rule matches. Defaults to a data-test hook. */
  match?: string;
}

const DEFAULT_MATCH = '[data-test=example]';

/** The VariantSpec behind a scaffold. Valid by construction. */
export function scaffoldVariantSpec(name: string, options: ScaffoldOptions = {}): VariantSpec {
  assertVariantName(name);

  const match = options.match ?? DEFAULT_MATCH;
  const description = options.description ?? `${name} — a proposed change, previewed without building it`;

  return {
    version: 1,
    variant: name,
    description,
    rules: [
      {
        id: 'example',
        match,
        style: { padding: '8px' },
      },
    ],
  };
}

/** The YAML written to `.visual-diff/variants/<name>.yaml`: a header comment plus the spec. */
export function scaffoldVariantSource(name: string, options: ScaffoldOptions = {}): string {
  const spec = scaffoldVariantSpec(name, options);
  return `${header(name)}${serializeVariant(spec)}`;
}

function header(name: string): string {
  return [
    `# .visual-diff/variants/${name}.yaml — variant spec v1`,
    '#',
    '# A variant is a proposed UI change, rendered without being built: its rules are applied to the',
    '# page just before the screenshot, and the run is diffed against the same revision without them.',
    `# Run it with:  vdiff run <flow> --variant ${name}`,
    '#',
    '# A variant CANNOT INVENT UI. Every element it shows is one the application already rendered —',
    '# rules restyle, retext, hide, reorder and repeat existing nodes. There is no verb that takes',
    '# markup, and there will not be one: a preview made of markup predicts nothing about the app.',
    '#',
    `# Each rule is one match plus exactly ONE verb, out of ${VARIANT_VERBS.length}:`,
    '#   style   CSS declarations applied to every matched element',
    '#   text    replacement copy for every matched element',
    '#   hide    remove the matched elements from the layout',
    '#   order   first | last | { before: <selector> } | { after: <selector> }',
    '#   clone   copy an element rendered elsewhere into a container on this page:',
    '#             clone:',
    '#               from: { step: <step id>, match: <selector> }   # or { url: /pricing, match: … }',
    '#               into: <selector>',
    '#               position: prepend | append | { before: … } | { after: … }   # default append',
    '#               times: 1',
    '#',
    '# Two verbs on one rule is an error rather than an invented precedence order. A clone rule takes',
    '# no top-level match: it names its source with clone.from.match and its target with clone.into.',
    '#',
    '# match is a CSS selector evaluated on the rendered page, so anything querySelectorAll accepts',
    '# works. Every rule applies, in file order, so two rules touching the same element compose.',
    '#',
    '# Rule ids are stable and load-bearing: the report says "element modified by rule <id>", and',
    "# renaming an id severs that rule's history. Changing its match does not.",
    '#',
    '# A rule that matches nothing is a run warning naming it, not a failure — the screenshot is then',
    '# of the unmodified page, so read those warnings before believing what you are looking at.',
    '',
  ].join('\n');
}
