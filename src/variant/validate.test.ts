/**
 * One test per rejection in variants spec §7, asserting the *message* and not merely the failure.
 * §8 item 5: "Validator messages, one per rejection in §7, asserting the text."
 *
 * The messages are this feature's user interface: a variant is written by an agent proposing a UI
 * change, and a rejection that does not say what to write instead costs a round trip.
 */

import { describe, expect, it } from 'vitest';
import type { SourceLocation, ValidationIssue, ValidationResult } from '../types.js';
import type { Locate } from '../scenario/index.js';
import { parseVariantSource } from './parse.js';
import type { VariantSpecInput } from './schema.js';
import { validateVariantSpec } from './validate.js';

/** A locator that echoes the key path, so tests can assert the offending key directly. */
const echo: Locate = (path): SourceLocation => ({
  file: 'denser-forecast.yaml',
  line: 1,
  column: 1,
  key: path
    .map((segment, index) =>
      typeof segment === 'number' ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
    )
    .join(''),
});

function parse(source: string): ValidationResult<unknown> {
  return parseVariantSource(source, { file: 'denser-forecast.yaml' });
}

function issues(result: ValidationResult<unknown>): ValidationIssue[] {
  if (result.ok) throw new Error('expected the spec to be rejected, but it parsed');
  return result.issues;
}

function only(result: ValidationResult<unknown>): ValidationIssue {
  const list = issues(result);
  if (list.length !== 1) {
    throw new Error(`expected exactly one issue, got ${list.map((i) => i.code).join(', ')}`);
  }
  return list[0] as ValidationIssue;
}

function warningsOf(result: ValidationResult<unknown>): ValidationIssue[] {
  if (!result.ok) throw new Error(`expected the spec to parse: ${issues(result)[0]?.message ?? ''}`);
  return result.warnings;
}

function withRules(rules: string, head = 'version: 1\nvariant: denser-forecast\n'): string {
  return `${head}rules:\n${rules}`;
}

const HIDE_RULE = '  - id: a\n    match: ".card"\n    hide: true\n';

describe('variant identity (variants spec §7)', () => {
  it("refuses the reserved name 'none'", () => {
    const issue = only(parse(withRules(HIDE_RULE, 'version: 1\nvariant: none\n')));
    expect(issue.code).toBe('reserved-variant-name');
    expect(issue.message).toBe(
      "'none' is a reserved variant name: it is what a run captured without a variant records in " +
        'meta.json, and what a variant run is diffed against, so no variant file may take it. ' +
        'Pick another name',
    );
    expect(issue.at.key).toBe('variant');
    expect(issue.at.line).toBe(2);
  });

  it('refuses a name that could not be a filename', () => {
    for (const name of ['"../escape"', '"has space"', '".hidden"', '""']) {
      const issue = only(parse(withRules(HIDE_RULE, `version: 1\nvariant: ${name}\n`)));
      expect(issue.code).toBe('invalid-variant-name');
      expect(issue.message).toContain(
        'a variant is stored as .visual-diff/variants/<name>.yaml and named in meta.json, so it ' +
          'must start with a letter or digit and contain only letters, digits, dot, dash or underscore',
      );
    }
  });

  it('makes a name/filename disagreement an error, not a warning', () => {
    const issue = only(
      parseVariantSource(withRules(HIDE_RULE), {
        file: 'sparse-sidebar.yaml',
        expectVariantName: 'sparse-sidebar',
      }),
    );
    expect(issue.code).toBe('variant-name-mismatch');
    expect(issue.message).toBe(
      "variant is named 'denser-forecast' but the file is named 'sparse-sidebar.yaml': the two " +
        'must agree, because a run records the variant by name and later looks the file up by it',
    );
  });

  it('refuses an empty description rather than writing an empty line into the report', () => {
    const issue = only(
      parse(withRules(HIDE_RULE, 'version: 1\nvariant: denser-forecast\ndescription: "   "\n')),
    );
    expect(issue.code).toBe('empty-description');
    expect(issue.message).toBe('description is empty: give it a sentence or remove the key');
  });
});

describe('rule ids (variants spec §4, §7)', () => {
  it('refuses an empty id', () => {
    const issue = only(parse(withRules('  - id: ""\n    match: ".card"\n    hide: true\n')));
    expect(issue.code).toBe('invalid-rule-id');
    expect(issue.message).toBe(
      'rule id is empty: an id is required and stable, because it is what the report names when ' +
        'it attributes a modified element, what the never-matched warning lists, and what lets ' +
        'two versions of a variant be compared',
    );
  });

  it('refuses an id with surrounding whitespace', () => {
    const issue = only(parse(withRules('  - id: " a "\n    match: ".card"\n    hide: true\n')));
    expect(issue.code).toBe('invalid-rule-id');
    expect(issue.message).toBe(
      'invalid rule id " a ": a rule id is printed in run warnings and in the report, so it may ' +
        'not have surrounding whitespace or control characters',
    );
  });

  it('refuses a duplicate id, naming the rule that already used it', () => {
    const issue = only(
      parse(
        withRules(
          '  - id: tighter\n    match: ".card"\n    hide: true\n' +
            '  - id: tighter\n    match: ".chart"\n    hide: true\n',
        ),
      ),
    );
    expect(issue.code).toBe('duplicate-rule-id');
    expect(issue.message).toBe(
      "duplicate rule id 'tighter' (already used by rules[0]). Rule ids are how a modified " +
        'element is attributed and how two versions of a variant are compared, so they must be ' +
        'unique within a variant',
    );
    expect(issue.at.key).toBe('rules[1].id');
  });
});

describe('the verb (D21, variants spec §7)', () => {
  it('refuses a rule with no verb, and says why there is no markup verb', () => {
    const issue = only(parse(withRules('  - id: a\n    match: ".card"\n')));
    expect(issue.code).toBe('no-verb');
    expect(issue.message).toBe(
      "rule 'a' does nothing: a rule needs exactly one of style, text, hide, order, clone. There " +
        'is no verb that takes markup — a variant rearranges what the application already ' +
        'renders, it does not add UI to it',
    );
  });

  it('refuses two verbs on one rule rather than inventing a precedence', () => {
    const issue = only(
      parse(withRules('  - id: a\n    match: ".card"\n    hide: true\n    text: "Hi"\n')),
    );
    expect(issue.code).toBe('two-verbs');
    expect(issue.message).toBe(
      "rule 'a' has 2 verbs (text, hide): a rule takes exactly one, so that the tool never has " +
        'to invent a precedence order between them. Split them into separate rules — they apply ' +
        'in file order',
    );
    expect(issue.at.key).toBe('rules[0].hide');
  });

  it('reports one issue per verb after the first, so --json can point at each key', () => {
    const list = issues(
      parse(
        withRules(
          '  - id: a\n    match: ".card"\n    style: { padding: 8px }\n    text: "Hi"\n    hide: true\n',
        ),
      ),
    );
    expect(list.map((issue) => issue.at.key)).toEqual(['rules[0].text', 'rules[0].hide']);
    for (const issue of list) expect(issue.message).toContain('has 3 verbs (style, text, hide)');
  });
});

describe('match (variants spec §7)', () => {
  it('names the verb when match is missing', () => {
    const issue = only(parse(withRules('  - id: a\n    hide: true\n')));
    expect(issue.code).toBe('missing-match');
    expect(issue.message).toBe(
      "rule 'a' is missing required key 'match': hide acts on elements the application already " +
        'rendered, so the rule has to say which ones — e.g. match: "[data-test=forecast-card]"',
    );
  });

  it('refuses an empty match', () => {
    const issue = only(parse(withRules('  - id: a\n    match: ""\n    hide: true\n')));
    expect(issue.code).toBe('missing-match');
    expect(issue.message).toBe(
      "rule 'a' has an empty match: a match is a CSS selector over the rendered page, so it must " +
        'name one — e.g. match: "[data-test=forecast-card]"',
    );
  });

  it('refuses a match on a clone rule, which already has two selectors', () => {
    const issue = only(
      parse(
        withRules(
          '  - id: a\n    match: ".card"\n    clone:\n      from: { step: s, match: ".p" }\n      into: ".x"\n',
        ),
      ),
    );
    expect(issue.code).toBe('unexpected-match');
    expect(issue.message).toBe(
      "rule 'a' is a clone and also has a match: a clone names the element it copies with " +
        'clone.from.match and the element it copies into with clone.into, so a third selector ' +
        'has nothing to select. Remove match',
    );
  });

  it('refuses an unparseable selector instead of letting it match nothing', () => {
    const issue = only(parse(withRules('  - id: a\n    match: "[data-test=card"\n    hide: true\n')));
    expect(issue.code).toBe('invalid-selector');
    expect(issue.message).toBe(
      'rule \'a\' has an invalid match "[data-test=card": an attribute selector opened with ' +
        "'[' is never closed",
    );
  });

  it('refuses a pseudo-element, which can never be an element', () => {
    const issue = only(parse(withRules('  - id: a\n    match: ".card::before"\n    hide: true\n')));
    expect(issue.code).toBe('pseudo-element-selector');
    expect(issue.message).toBe(
      'rule \'a\' has an invalid match ".card::before": \'::before\' is a pseudo-element, not an ' +
        'element. A variant rule operates on nodes the application rendered, and querySelectorAll ' +
        'never returns a pseudo-element, so this selector can only ever match nothing — select ' +
        'the element itself',
    );
  });
});

describe('style (variants spec §4)', () => {
  it('refuses a style that is not a mapping', () => {
    const issue = only(parse(withRules('  - id: a\n    match: ".card"\n    style: "padding: 8px"\n')));
    expect(issue.code).toBe('invalid-style');
    expect(issue.message).toBe(
      'rule \'a\' has a style that is the string "padding: 8px": style is a mapping of CSS ' +
        'declarations, as in style: { padding: 8px, gap: 4px }',
    );
  });

  it('refuses an empty style', () => {
    const issue = only(parse(withRules('  - id: a\n    match: ".card"\n    style: {}\n')));
    expect(issue.code).toBe('empty-style');
    expect(issue.message).toBe(
      "rule 'a' has an empty style: a rule that declares nothing changes nothing, so either give " +
        'it a declaration or delete the rule',
    );
  });

  it('refuses the DOM spelling of a property, which setProperty silently ignores', () => {
    const issue = only(
      parse(withRules('  - id: a\n    match: ".card"\n    style: { paddingTop: 8px }\n')),
    );
    expect(issue.code).toBe('invalid-style-property');
    expect(issue.message).toBe(
      "rule 'a' sets 'paddingTop', which is the DOM spelling of a CSS property: a style is " +
        "written the way CSS writes it, hyphenated and lower-case, so use 'padding-top'",
    );
    expect(issue.at.key).toBe('rules[0].style.paddingTop');
  });

  it('refuses a property name that is not one', () => {
    const issue = only(
      parse(withRules('  - id: a\n    match: ".card"\n    style: { "padding:": 8px }\n')),
    );
    expect(issue.code).toBe('invalid-style-property');
    expect(issue.message).toBe(
      'rule \'a\' has an invalid CSS property name "padding:": a property is a word such as ' +
        "'padding', a vendor-prefixed '-webkit-line-clamp', or a custom property '--brand-gap'",
    );
  });

  it('accepts vendor prefixes and custom properties', () => {
    const result = parse(
      withRules(
        '  - id: a\n    match: ".card"\n    style: { -webkit-line-clamp: 2, --brand-gap: 4px }\n',
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('refuses an empty value, which removes the declaration instead of setting it', () => {
    const issue = only(
      parse(withRules('  - id: a\n    match: ".card"\n    style: { padding: "" }\n')),
    );
    expect(issue.code).toBe('invalid-style-value');
    expect(issue.message).toBe(
      "rule 'a' sets 'padding' to an empty value, which removes the declaration rather than " +
        "changing it. Write the value you want, e.g. 0 or 'none'",
    );
  });

  it('refuses a value carrying a second declaration', () => {
    const issue = only(
      parse(withRules('  - id: a\n    match: ".card"\n    style: { padding: "8px; color: red" }\n')),
    );
    expect(issue.code).toBe('invalid-style-value');
    expect(issue.message).toBe(
      'rule \'a\' sets \'padding\' to "8px; color: red", which contains ; { or }: a style is one ' +
        'declaration per key, so write each property as its own entry',
    );
  });

  it('refuses !important, which the CSSOM discards from the value', () => {
    const issue = only(
      parse(withRules('  - id: a\n    match: ".card"\n    style: { padding: "8px !important" }\n')),
    );
    expect(issue.code).toBe('invalid-style-value');
    expect(issue.message).toBe(
      'rule \'a\' sets \'padding\' to "8px !important": a variant already writes an inline style, ' +
        'which beats every stylesheet rule, and !important in the value is silently discarded. Drop it',
    );
  });

  it('refuses a value that is not a string or a number', () => {
    const issue = only(
      parse(withRules('  - id: a\n    match: ".card"\n    style: { padding: [8px] }\n')),
    );
    expect(issue.code).toBe('invalid-style-value');
    expect(issue.message).toBe(
      "rule 'a' sets 'padding' to a list: a CSS declaration takes a value such as 8px, 1.5 or 'none'",
    );
  });
});

describe('order and clone.position (variants spec §4, §7)', () => {
  it('names the four forms when the keyword is unknown', () => {
    const issue = only(parse(withRules('  - id: a\n    match: ".card"\n    order: top\n')));
    expect(issue.code).toBe('invalid-order');
    expect(issue.message).toBe(
      'rule \'a\' has order "top": order takes first, last, { before: <selector> } or ' +
        '{ after: <selector> }',
    );
  });

  it('names the four forms of clone.position separately', () => {
    const issue = only(
      parse(
        withRules(
          '  - id: a\n    clone:\n      from: { step: s, match: ".p" }\n      into: ".x"\n      position: middle\n',
        ),
      ),
    );
    expect(issue.code).toBe('invalid-position');
    expect(issue.message).toBe(
      'rule \'a\' has clone.position "middle": clone.position takes prepend, append, ' +
        '{ before: <selector> } or { after: <selector> }',
    );
  });

  it('refuses both before and after', () => {
    const issue = only(
      parse(withRules('  - id: a\n    match: ".card"\n    order: { before: ".x", after: ".y" }\n')),
    );
    expect(issue.code).toBe('invalid-order');
    expect(issue.message).toBe(
      "rule 'a' has both before and after in order: an element goes on one side of its reference " +
        'or the other, so give exactly one',
    );
    expect(issue.at.key).toBe('rules[0].order.after');
  });

  it('refuses an unknown key inside a relative order', () => {
    const issue = only(
      parse(withRules('  - id: a\n    match: ".card"\n    order: { above: ".x" }\n')),
    );
    expect(issue.code).toBe('invalid-order');
    expect(issue.message).toBe(
      "rule 'a' has an unknown key 'above' in order: a selector-relative order is written " +
        '{ before: <selector> } or { after: <selector> }',
    );
  });

  it('refuses an empty relative order', () => {
    const issue = only(parse(withRules('  - id: a\n    match: ".card"\n    order: {}\n')));
    expect(issue.code).toBe('invalid-order');
    expect(issue.message).toBe(
      "rule 'a' has an empty order: order takes first, last, { before: <selector> } or " +
        '{ after: <selector> }',
    );
  });

  it('refuses an order reference selector that is itself invalid', () => {
    const issue = only(
      parse(withRules('  - id: a\n    match: ".card"\n    order: { before: ".x >" }\n')),
    );
    expect(issue.code).toBe('invalid-selector');
    expect(issue.message).toBe(
      'rule \'a\' has an invalid order.before selector ".x >": the combinator \'>\' has nothing ' +
        'on its right',
    );
    expect(issue.at.key).toBe('rules[0].order.before');
  });
});

describe('clone (D23, variants spec §7)', () => {
  const clone = (body: string): string => `  - id: a\n    clone:\n${body}`;

  it('refuses a clone source with neither step nor url', () => {
    const issue = only(parse(withRules(clone('      from: { match: ".p" }\n      into: ".x"\n'))));
    expect(issue.code).toBe('invalid-clone-source');
    expect(issue.message).toBe(
      "rule 'a' has a clone.from with neither step nor url: a clone comes from a step of this " +
        'same run, or from a url visited during it — both are the same revision as the target, ' +
        'which is what keeps a variant a preview rather than two revisions composited together. ' +
        'Give exactly one of step or url',
    );
  });

  it('refuses a clone source with both step and url', () => {
    const issue = only(
      parse(
        withRules(clone('      from: { step: s, url: /pricing, match: ".p" }\n      into: ".x"\n')),
      ),
    );
    expect(issue.code).toBe('invalid-clone-source');
    expect(issue.message).toBe(
      "rule 'a' has a clone.from with both step and url: a clone has one source, and the tool " +
        'will not invent a precedence between them. Keep step for a page the flow already ' +
        'visits, url for one it never does',
    );
    expect(issue.at.key).toBe('rules[0].clone.from.url');
  });

  it('refuses a step id that could not be one', () => {
    const issue = only(
      parse(withRules(clone('      from: { step: "../x", match: ".p" }\n      into: ".x"\n'))),
    );
    expect(issue.code).toBe('invalid-step');
    expect(issue.message).toBe(
      'rule \'a\' has an invalid clone.from.step "../x": it names a step of the flow being run, ' +
        'and a step id starts with a letter or digit and contains only letters, digits, dot, ' +
        'dash or underscore',
    );
  });

  it('refuses a step the flow does not have, before the run starts', () => {
    const result = parseVariantSource(
      withRules(clone('      from: { step: pricing, match: ".p" }\n      into: ".x"\n')),
      { file: 'denser-forecast.yaml', flowStepIds: ['home', 'forecast'] },
    );
    const issue = only(result);
    expect(issue.code).toBe('unknown-step');
    expect(issue.message).toBe(
      "rule 'a' clones from step 'pricing', which this flow does not have. Its steps are: home, forecast",
    );
    expect(issue.at.key).toBe('rules[0].clone.from.step');
  });

  it('says nothing about the step when no flow was given to check against', () => {
    const result = parse(clone('      from: { step: pricing, match: ".p" }\n      into: ".x"\n'));
    expect(result.ok).toBe(false);
  });

  it('accepts a step the flow does have', () => {
    const result = parseVariantSource(
      withRules(clone('      from: { step: pricing, match: ".p" }\n      into: ".x"\n')),
      { file: 'denser-forecast.yaml', flowStepIds: ['home', 'pricing'] },
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a url that is neither absolute nor rooted', () => {
    const issue = only(
      parse(withRules(clone('      from: { url: "pricing", match: ".p" }\n      into: ".x"\n'))),
    );
    expect(issue.code).toBe('invalid-url');
    expect(issue.message).toBe(
      'rule \'a\' has an invalid clone.from.url "pricing": it is neither an absolute url nor a ' +
        "path: write '/pricing' to resolve it against the flow's baseUrl, or the whole " +
        "'https://…' url",
    );
  });

  it('refuses a url that is not http', () => {
    const issue = only(
      parse(
        withRules(clone('      from: { url: "file:///etc/passwd", match: ".p" }\n      into: ".x"\n')),
      ),
    );
    expect(issue.code).toBe('invalid-url');
    expect(issue.message).toBe(
      'rule \'a\' has an invalid clone.from.url "file:///etc/passwd": a clone source is a page ' +
        'of the application under test, so its url is http or https, not "file"',
    );
  });

  it('accepts a rooted path and an absolute http url', () => {
    for (const url of ['/pricing', 'https://example.test/pricing?plan=pro']) {
      const result = parse(
        withRules(clone(`      from: { url: "${url}", match: ".p" }\n      into: ".x"\n`)),
      );
      expect(result.ok).toBe(true);
    }
  });

  it('refuses an empty clone.into', () => {
    const issue = only(
      parse(withRules(clone('      from: { step: s, match: ".p" }\n      into: ""\n'))),
    );
    expect(issue.code).toBe('missing-into');
    expect(issue.message).toBe(
      "rule 'a' has an empty clone.into: it is the selector of the element the copy is placed " +
        'into — e.g. into: "[data-test=sidebar]"',
    );
  });

  it('refuses an empty clone.from.match, because a clone descends from a rendered element', () => {
    const issue = only(
      parse(withRules(clone('      from: { step: s, match: "" }\n      into: ".x"\n'))),
    );
    expect(issue.code).toBe('missing-match');
    expect(issue.message).toBe(
      "rule 'a' has an empty clone.from.match: it is the selector of the element to copy, and a " +
        'clone descends from an element the application rendered — it cannot be written from nothing',
    );
  });

  it('refuses times below 1', () => {
    const issue = only(
      parse(
        withRules(clone('      from: { step: s, match: ".p" }\n      into: ".x"\n      times: 0\n')),
      ),
    );
    expect(issue.code).toBe('invalid-times');
    expect(issue.message).toBe(
      "rule 'a' has times 0: times counts how many copies to make and so is at least 1. To " +
        'preview the page without this element, delete the rule rather than cloning it zero times',
    );
    expect(issue.at.key).toBe('rules[0].clone.times');
  });

  it('refuses a fractional times', () => {
    const issue = only(
      parse(
        withRules(clone('      from: { step: s, match: ".p" }\n      into: ".x"\n      times: 1.5\n')),
      ),
    );
    expect(issue.code).toBe('invalid-times');
    expect(issue.message).toBe(
      "rule 'a' has times 1.5: times counts how many copies to make, so it must be a whole number",
    );
  });

  it('refuses an invalid clone.into selector', () => {
    const issue = only(
      parse(withRules(clone('      from: { step: s, match: ".p" }\n      into: "#"\n'))),
    );
    expect(issue.code).toBe('invalid-selector');
    expect(issue.message).toBe(
      'rule \'a\' has an invalid clone.into "#": \'#\' must be followed by an id, as in \'#total\'',
    );
  });
});

describe('warnings — rules that apply but cannot be seen (D22)', () => {
  it('warns when a later rule overrides an earlier one on the same match', () => {
    const warnings = warningsOf(
      parse(
        withRules(
          '  - id: copy-a\n    match: ".cta"\n    text: "One"\n' +
            '  - id: copy-b\n    match: ".cta"\n    text: "Two"\n',
        ),
      ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('overridden-rule');
    expect(warnings[0]?.message).toBe(
      "rule 'copy-b' overrides rule 'copy-a' at rules[0]: both set text on the same match, and " +
        "rules apply in file order, so only this rule's text is visible",
    );
  });

  it('warns only about the declarations two style rules actually share', () => {
    const warnings = warningsOf(
      parse(
        withRules(
          '  - id: pad\n    match: ".card"\n    style: { padding: 8px, gap: 4px }\n' +
            '  - id: pad-more\n    match: ".card"\n    style: { padding: 2px, color: red }\n',
        ),
      ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      "rule 'pad-more' overrides rule 'pad' at rules[0]: both set padding on the same match, and " +
        "rules apply in file order, so only this rule's value is visible",
    );
  });

  it('stays quiet when two style rules touch different declarations', () => {
    const warnings = warningsOf(
      parse(
        withRules(
          '  - id: pad\n    match: ".card"\n    style: { padding: 8px }\n' +
            '  - id: colour\n    match: ".card"\n    style: { color: red }\n',
        ),
      ),
    );
    expect(warnings).toEqual([]);
  });

  it('warns that hiding the same match twice changes nothing', () => {
    const warnings = warningsOf(
      parse(
        withRules(
          '  - id: hide-a\n    match: ".aq"\n    hide: true\n' +
            '  - id: hide-b\n    match: ".aq"\n    hide: true\n',
        ),
      ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('redundant-rule');
    expect(warnings[0]?.message).toBe(
      "rule 'hide-b' repeats rule 'hide-a' at rules[0]: both hide the same match, and hiding an " +
        'element twice changes nothing',
    );
  });

  it('stays quiet about different matches, and about clones', () => {
    const warnings = warningsOf(
      parse(
        withRules(
          '  - id: a\n    match: ".card"\n    hide: true\n' +
            '  - id: b\n    match: ".chart"\n    hide: true\n' +
            '  - id: c\n    clone:\n      from: { step: s, match: ".p" }\n      into: ".x"\n' +
            '  - id: d\n    clone:\n      from: { step: s, match: ".p" }\n      into: ".x"\n',
        ),
      ),
    );
    expect(warnings).toEqual([]);
  });
});

describe('validateVariantSpec directly', () => {
  it('reports every problem at once, so a check prints one list', () => {
    const input: VariantSpecInput = {
      version: 1,
      variant: 'none',
      rules: [{ id: '', match: '.a', hide: true }, { id: 'b' }],
    };
    const { issues: found } = validateVariantSpec(input, echo);
    expect(found.map((issue) => issue.code)).toEqual([
      'reserved-variant-name',
      'invalid-rule-id',
      'no-verb',
    ]);
    expect(found.map((issue) => issue.at.key)).toEqual(['variant', 'rules[0].id', 'rules[1]']);
  });
});
