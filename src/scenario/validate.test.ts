/**
 * One test per rejection in mocking spec §8, asserting the *message* and not merely the failure.
 * §10 item 4: "These messages are the feature's user interface."
 */

import { describe, expect, it } from 'vitest';
import type { SourceLocation, ValidationIssue, ValidationResult } from '../types.js';
import type { Locate } from './locate.js';
import { parseScenarioSource } from './parse.js';
import type { ScenarioSpecInput } from './schema.js';
import { findNonJson, validateScenarioSpec } from './validate.js';

/** A locator that echoes the key path, so tests can assert the offending key directly. */
const echo: Locate = (path): SourceLocation => ({
  file: 'empty-forecast.yaml',
  line: 1,
  column: 1,
  key: path
    .map((segment, index) =>
      typeof segment === 'number' ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
    )
    .join(''),
});

function parse(source: string): ValidationResult<unknown> {
  return parseScenarioSource(source, { file: 'empty-forecast.yaml' });
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

function withRules(rules: string, head = 'version: 1\nscenario: empty-forecast\n'): string {
  return `${head}rules:\n${rules}`;
}

const MOCK_HEAD = 'version: 1\nscenario: empty-forecast\nmode: mock\n';

describe('scenario identity (mocking spec §8, §11)', () => {
  it("refuses the reserved name 'none'", () => {
    const issue = only(
      parse(withRules('  - id: a\n    match: { url: "**" }\n    abort: true\n', 'version: 1\nscenario: none\n')),
    );
    expect(issue.code).toBe('reserved-scenario-name');
    expect(issue.message).toBe(
      "'none' is a reserved scenario name: it is what a run captured without a scenario records " +
        'in meta.json, so no scenario file may take it. Pick another name',
    );
    expect(issue.at.key).toBe('scenario');
    expect(issue.at.line).toBe(2);
  });

  it('refuses a name that could not be a filename', () => {
    for (const name of ['"../escape"', '"has space"', '".hidden"', '""']) {
      const issue = only(
        parse(
          withRules(
            '  - id: a\n    match: { url: "**" }\n    abort: true\n',
            `version: 1\nscenario: ${name}\n`,
          ),
        ),
      );
      expect(issue.code).toBe('invalid-scenario-name');
      expect(issue.message).toContain(
        'a scenario is stored as .visual-diff/scenarios/<name>.yaml and named in meta.json, so ' +
          'it must start with a letter or digit and contain only letters, digits, dot, dash or underscore',
      );
    }
  });

  it('makes a name/filename disagreement an error, not a warning', () => {
    const result = parseScenarioSource(
      withRules('  - id: a\n    match: { url: "**" }\n    abort: true\n'),
      { file: 'slow-api.yaml', expectScenarioName: 'slow-api' },
    );
    const issue = only(result);
    expect(issue.code).toBe('scenario-name-mismatch');
    expect(issue.message).toBe(
      "scenario is named 'empty-forecast' but the file is named 'slow-api.yaml': the two must " +
        'agree, because a run records the scenario by name and later looks the file up by it',
    );
  });

  it('rejects a description that is present but blank', () => {
    const issue = only(
      parse(
        withRules(
          '  - id: a\n    match: { url: "**" }\n    abort: true\n',
          'version: 1\nscenario: empty-forecast\ndescription: "   "\n',
        ),
      ),
    );
    expect(issue.code).toBe('empty-description');
    expect(issue.message).toBe('description is empty: give it a sentence or remove the key');
  });
});

describe('rule ids (mocking spec §5, §8)', () => {
  it('reports every repeat of a duplicated id against the first occurrence', () => {
    const result = parse(
      withRules(
        `  - id: forecast
    match: { url: "**/a" }
    abort: true
  - id: search
    match: { url: "**/b" }
    abort: true
  - id: forecast
    match: { url: "**/c" }
    abort: true
`,
      ),
    );
    const issue = only(result);
    expect(issue.code).toBe('duplicate-rule-id');
    expect(issue.message).toBe(
      "duplicate rule id 'forecast' (already used by rules[0]). Rule ids are how two versions of " +
        'a scenario are compared and how a changed response is attributed, so they must be unique ' +
        'within a scenario',
    );
    expect(issue.at.key).toBe('rules[2].id');
  });

  it('rejects an empty id and explains what an id is for', () => {
    const issue = only(parse(withRules('  - id: ""\n    match: { url: "**" }\n    abort: true\n')));
    expect(issue.code).toBe('invalid-rule-id');
    expect(issue.message).toBe(
      'rule id is empty: an id is required and stable, because it is what lets two versions of a ' +
        'scenario be compared and what the report names when it attributes a changed response',
    );
  });

  it('rejects an id with surrounding whitespace', () => {
    const issue = only(parse(withRules('  - id: " forecast "\n    match: { url: "**" }\n    abort: true\n')));
    expect(issue.code).toBe('invalid-rule-id');
    expect(issue.message).toBe(
      'invalid rule id " forecast ": a rule id is printed in run warnings and in the report, so ' +
        'it may not have surrounding whitespace or control characters',
    );
  });
});

describe('match (mocking spec §5, §8)', () => {
  it('rejects an empty url with the shape of a glob', () => {
    const issue = only(parse(withRules('  - id: a\n    match: { url: "" }\n    abort: true\n')));
    expect(issue.code).toBe('missing-url');
    expect(issue.message).toBe(
      'match.url is empty: a rule is a URL glob applied to the whole URL including the query ' +
        "string, so match.url must name one — e.g. '**/v1/forecast**'",
    );
  });

  it('rejects an unparseable glob and says how to escape the character', () => {
    const issue = only(parse(withRules('  - id: a\n    match: { url: "**/v1/[abc" }\n    abort: true\n')));
    expect(issue.code).toBe('invalid-glob');
    expect(issue.message).toBe(
      'invalid url glob "**/v1/[abc": there is a \'[\' with no matching \']\'. Escape it as ' +
        "'\\[' to match one literally",
    );
    expect(issue.at.key).toBe('rules[0].match.url');
    expect(issue.at.line).toBe(5);
  });

  it('rejects a method that is not one word', () => {
    const issue = only(parse(withRules('  - id: a\n    match: { url: "**", method: "GET " }\n    abort: true\n')));
    expect(issue.code).toBe('invalid-method');
    expect(issue.message).toBe(
      'invalid match.method "GET ": an HTTP method is a bare word such as GET, POST or DELETE. ' +
        'Omit match.method entirely to match any method',
    );
  });

  it('rejects nth below 1 and explains that it counts from one', () => {
    for (const nth of [0, -3]) {
      const issue = only(
        parse(withRules(`  - id: a\n    match: { url: "**", nth: ${nth} }\n    abort: true\n`)),
      );
      expect(issue.code).toBe('invalid-nth');
      expect(issue.message).toBe(
        `invalid nth ${nth}: nth selects the nth occurrence of an otherwise identical request and ` +
          'is 1-based, so the first occurrence is nth: 1',
      );
      expect(issue.at.key).toBe('rules[0].match.nth');
    }
  });

  it('rejects a fractional nth', () => {
    const issue = only(parse(withRules('  - id: a\n    match: { url: "**", nth: 1.5 }\n    abort: true\n')));
    expect(issue.message).toBe(
      'invalid nth 1.5: nth counts occurrences of an otherwise identical request, so it must be a ' +
        'whole number',
    );
  });

  it('accepts nth: 1', () => {
    expect(parse(withRules('  - id: a\n    match: { url: "**", nth: 1 }\n    abort: true\n')).ok).toBe(
      true,
    );
  });
});

describe('delay (mocking spec §5, §8)', () => {
  it('rejects a negative delay', () => {
    const issue = only(parse(withRules('  - id: a\n    match: { url: "**" }\n    delay: -1\n')));
    expect(issue.code).toBe('invalid-delay');
    expect(issue.message).toBe(
      'invalid delay -1: a delay is a non-negative number of milliseconds, and there is no way to ' +
        'serve a response earlier than it was asked for',
    );
    expect(issue.at.key).toBe('rules[0].delay');
  });

  it('rejects a delay that is not a number JSON can hold', () => {
    const issue = only(parse(withRules('  - id: a\n    match: { url: "**" }\n    delay: .inf\n')));
    expect(issue.message).toBe('invalid delay Infinity: a delay is a number of milliseconds');
  });

  it('accepts a delay of zero and a delay on its own in overlay mode', () => {
    const result = parse(withRules('  - id: a\n    match: { url: "**" }\n    delay: 0\n'));
    expect(result.ok).toBe(true);
    expect(warningsOf(result)).toEqual([]);
  });
});

describe('response verbs (mocking spec §5, §8)', () => {
  it('rejects two response verbs on one rule rather than inventing a precedence order', () => {
    const result = parse(
      withRules('  - id: a\n    match: { url: "**" }\n    patch: { a: 1 }\n    abort: true\n'),
    );
    const issue = only(result);
    expect(issue.code).toBe('two-response-verbs');
    expect(issue.message).toBe(
      "rule 'a' has 2 response verbs (patch, abort): a rule takes exactly one, so that the tool " +
        'never has to invent a precedence order between them. delay is a modifier and composes ' +
        'with any of them; split the rest into separate rules',
    );
    expect(issue.at.key).toBe('rules[0].abort');
  });

  it('points at each verb after the first when three are present', () => {
    const result = parse(
      withRules(
        '  - id: a\n    match: { url: "**" }\n    patch: { a: 1 }\n    respond: { status: 200 }\n    abort: true\n',
      ),
    );
    expect(issues(result).map((issue) => issue.at.key)).toEqual([
      'rules[0].respond',
      'rules[0].abort',
    ]);
    expect(issues(result)[0]?.message).toContain('3 response verbs (patch, respond, abort)');
  });

  it('rejects a rule with no verb and no delay', () => {
    const issue = only(parse(withRules('  - id: a\n    match: { url: "**" }\n')));
    expect(issue.code).toBe('no-response-verb');
    expect(issue.message).toBe(
      "rule 'a' does nothing: a rule needs exactly one of patch, patchOps, respond, abort — or " +
        'delay on its own, which passes the recorded response through late',
    );
    expect(issue.at.key).toBe('rules[0]');
  });
});

describe('mock mode (mocking spec §5 table, §8)', () => {
  it('rejects patch in mock mode, at validation time rather than run time', () => {
    const issue = only(
      parse(withRules('  - id: a\n    match: { url: "**" }\n    patch: { a: 1 }\n', MOCK_HEAD)),
    );
    expect(issue.code).toBe('patch-in-mock-mode');
    expect(issue.message).toBe(
      "rule 'a' uses patch, which is rejected in mock mode: there is no recorded body to patch, " +
        'so the patch would be applied to nothing and produce whatever it contains, which looks ' +
        'like it worked. Use respond to state the whole response, or switch the scenario to ' +
        'overlay mode',
    );
    expect(issue.at.key).toBe('rules[0].patch');
  });

  it('rejects patchOps in mock mode too', () => {
    const issue = only(
      parse(
        withRules(
          '  - id: a\n    match: { url: "**" }\n    patchOps:\n      - { op: remove, path: /a }\n',
          MOCK_HEAD,
        ),
      ),
    );
    expect(issue.code).toBe('patch-in-mock-mode');
    expect(issue.message).toContain("rule 'a' uses patchOps, which is rejected in mock mode");
    expect(issue.at.key).toBe('rules[0].patchOps');
  });

  it('accepts patch in overlay mode, which is the whole point of overlay', () => {
    expect(parse(withRules('  - id: a\n    match: { url: "**" }\n    patch: { a: 1 }\n')).ok).toBe(true);
  });

  it('warns that a delay-only rule in mock mode has no recording to pass through', () => {
    const result = parse(withRules('  - id: a\n    match: { url: "**" }\n    delay: 500\n', MOCK_HEAD));
    expect(result.ok).toBe(true);
    const warning = warningsOf(result)[0];
    expect(warning?.code).toBe('delay-only-in-mock-mode');
    expect(warning?.message).toBe(
      "rule 'a' has only a delay, which passes the recorded response through late — but mock mode " +
        'has no recording, so the request is aborted as a miss anyway. Add a respond, or an abort ' +
        'if the miss is the point',
    );
  });
});

describe('patch payloads (RFC 7386)', () => {
  it('rejects an empty patch, which would replace the whole body with null', () => {
    const issue = only(parse(withRules('  - id: a\n    match: { url: "**" }\n    patch:\n')));
    expect(issue.code).toBe('empty-patch');
    expect(issue.message).toBe(
      "rule 'a' has an empty patch: a merge patch of null replaces the whole recorded body with " +
        'null (RFC 7386), which is almost never the intent. Give patch a mapping, or use respond ' +
        'to state the whole response',
    );
  });

  it('rejects a patch value JSON cannot hold, naming where it is', () => {
    const issue = only(
      parse(withRules('  - id: a\n    match: { url: "**" }\n    patch: { hourly: { t: .nan } }\n')),
    );
    expect(issue.code).toBe('invalid-patch');
    expect(issue.message).toBe(
      "rule 'a' has a patch that is not JSON at hourly.t: NaN is not a number JSON can hold. A " +
        'merge patch is applied to a recorded JSON body, so every value in it must be JSON',
    );
  });
});

describe('patchOps (RFC 6902, mocking spec §8 "malformed op")', () => {
  function patchOps(ops: string): ValidationResult<unknown> {
    return parse(withRules(`  - id: a\n    match: { url: "**" }\n    patchOps:\n${ops}`));
  }

  it('rejects an empty patchOps', () => {
    const issue = only(parse(withRules('  - id: a\n    match: { url: "**" }\n    patchOps: []\n')));
    expect(issue.code).toBe('empty-patch-ops');
    expect(issue.message).toBe(
      "rule 'a' has an empty patchOps: a rule with no operations changes nothing, so either give " +
        'it an operation or delete the rule',
    );
  });

  it('rejects an operation that is not a mapping', () => {
    const issue = only(patchOps('      - remove /daily/time/0\n'));
    expect(issue.code).toBe('invalid-patch-op');
    expect(issue.message).toBe(
      'rule \'a\': patchOps[0] is the string "remove /daily/time/0", but an RFC 6902 operation is ' +
        'a mapping such as { op: remove, path: /daily/time/0 }',
    );
  });

  it('lists the six operations when op is missing or unknown', () => {
    expect(only(patchOps('      - { path: /a }\n')).message).toBe(
      "rule 'a': patchOps[0] is missing 'op'. RFC 6902 defines: add, remove, replace, move, copy, test",
    );
    expect(only(patchOps('      - { op: frobnicate, path: /a }\n')).message).toBe(
      'rule \'a\': unknown JSON Patch op "frobnicate" in patchOps[0]. RFC 6902 defines: add, ' +
        'remove, replace, move, copy, test',
    );
  });

  it('rejects an unknown key inside an operation', () => {
    const issue = only(patchOps('      - { op: remove, path: /a, pth: 1 }\n'));
    expect(issue.message).toBe(
      "rule 'a': unknown key 'pth' in patchOps[0]. An RFC 6902 operation is written with op, " +
        'path, value, from',
    );
    expect(issue.at.key).toBe('rules[0].patchOps[0].pth');
  });

  it('reports the unknown key and the missing one together', () => {
    expect(issues(patchOps('      - { op: remove, pth: /a }\n')).map((issue) => issue.message)).toEqual([
      // Ordered by position: the missing key is reported against the operation itself, which
      // starts before the unknown key inside it.
      "rule 'a': JSON Patch op 'remove' is missing 'path' in patchOps[0]",
      "rule 'a': unknown key 'pth' in patchOps[0]. An RFC 6902 operation is written with op, path, value, from",
    ]);
  });

  it('requires a path, and requires it to be a JSON Pointer', () => {
    expect(only(patchOps('      - { op: remove }\n')).message).toBe(
      "rule 'a': JSON Patch op 'remove' is missing 'path' in patchOps[0]",
    );
    expect(only(patchOps('      - { op: remove, path: daily/time }\n')).message).toBe(
      'rule \'a\': invalid JSON Pointer "daily/time" in patchOps[0]: a pointer is either empty or ' +
        "starts with '/', so write '/daily/time/0'",
    );
    expect(only(patchOps('      - { op: remove, path: "/daily/~2" }\n')).message).toBe(
      'rule \'a\': invalid JSON Pointer "/daily/~2" in patchOps[0]: \'~\' is an escape and must be ' +
        "followed by '0' (a literal ~) or '1' (a literal /)",
    );
    expect(only(patchOps('      - { op: remove, path: 7 }\n')).message).toBe(
      "rule 'a': the 'path' of patchOps[0] is a number, but a JSON Pointer is a string such as " +
        "'/daily/time/0'",
    );
  });

  it('requires value exactly where RFC 6902 does', () => {
    expect(only(patchOps('      - { op: add, path: /a }\n')).message).toBe(
      "rule 'a': JSON Patch op 'add' requires 'value', and patchOps[0] has none",
    );
    expect(only(patchOps('      - { op: remove, path: /a, value: 1 }\n')).message).toBe(
      "rule 'a': JSON Patch op 'remove' does not take a 'value'. Only add, replace, test do",
    );
    expect(patchOps('      - { op: add, path: /a, value: null }\n').ok).toBe(true);
  });

  it('requires from exactly where RFC 6902 does', () => {
    expect(only(patchOps('      - { op: move, path: /a }\n')).message).toBe(
      "rule 'a': JSON Patch op 'move' requires 'from', and patchOps[0] has none",
    );
    expect(only(patchOps('      - { op: add, path: /a, value: 1, from: /b }\n')).message).toBe(
      "rule 'a': JSON Patch op 'add' does not take a 'from'. Only move, copy do",
    );
    expect(only(patchOps('      - { op: copy, path: /a, from: b }\n')).message).toContain(
      'invalid JSON Pointer "b" in patchOps[0]',
    );
  });

  it('refuses to move a location into its own child', () => {
    expect(only(patchOps('      - { op: move, path: /daily/time, from: /daily }\n')).message).toBe(
      "rule 'a': cannot move '/daily' into its own child '/daily/time': RFC 6902 forbids a move " +
        "whose 'from' is a prefix of its 'path'",
    );
    expect(patchOps('      - { op: move, path: /dailyish, from: /daily }\n').ok).toBe(true);
  });

  it('rejects a value JSON cannot hold', () => {
    expect(only(patchOps('      - { op: replace, path: /a, value: { b: .inf } }\n')).message).toBe(
      "rule 'a': the 'value' of patchOps[0] is not JSON at b: Infinity is not a number JSON can hold",
    );
  });

  it('accepts the spec §5 operations', () => {
    expect(
      patchOps(
        '      - { op: remove,  path: /daily/time/0 }\n      - { op: replace, path: /daily/weather_code/0, value: 95 }\n',
      ).ok,
    ).toBe(true);
  });
});

describe('respond (mocking spec §5, §8)', () => {
  it('rejects a status outside 100-599', () => {
    for (const status of [99, 600, 0]) {
      const issue = only(
        parse(withRules(`  - id: a\n    match: { url: "**" }\n    respond: { status: ${status} }\n`)),
      );
      expect(issue.code).toBe('invalid-status');
      expect(issue.message).toBe(`invalid status ${status}: an HTTP status is between 100 and 599`);
      expect(issue.at.key).toBe('rules[0].respond.status');
    }
  });

  it('rejects a status that is not a whole number', () => {
    expect(
      only(parse(withRules('  - id: a\n    match: { url: "**" }\n    respond: { status: 200.5 }\n'))).message,
    ).toBe('invalid status 200.5: an HTTP status is a whole number between 100 and 599');
  });

  it('accepts the edges of the range', () => {
    for (const status of [100, 599]) {
      expect(
        parse(withRules(`  - id: a\n    match: { url: "**" }\n    respond: { status: ${status} }\n`)).ok,
      ).toBe(true);
    }
  });

  it('rejects a header name that is not a token', () => {
    const issue = only(
      parse(
        withRules(
          '  - id: a\n    match: { url: "**" }\n    respond: { status: 200, headers: { "content type": text/plain } }\n',
        ),
      ),
    );
    expect(issue.code).toBe('invalid-header');
    expect(issue.message).toBe(
      'invalid response header name "content type": a header name is a bare token such as content-type',
    );
  });

  it('rejects base64 that is not base64', () => {
    const issue = only(
      parse(
        withRules('  - id: a\n    match: { url: "**" }\n    respond: { status: 200, body: { base64: "not!base64" } }\n'),
      ),
    );
    expect(issue.code).toBe('invalid-base64');
    expect(issue.message).toBe(
      "rule 'a' has a respond.body.base64 that is not valid base64: it must be A-Z, a-z, 0-9, + " +
        'and /, padded with = to a multiple of four characters',
    );
  });

  it('rejects a base64 body carrying other keys, which would be ambiguous', () => {
    const issue = only(
      parse(
        withRules(
          '  - id: a\n    match: { url: "**" }\n    respond: { status: 200, body: { base64: "aGk=", gzip: true } }\n',
        ),
      ),
    );
    expect(issue.code).toBe('invalid-body');
    expect(issue.message).toBe(
      "rule 'a' has a respond.body with a 'base64' key alongside 'gzip': a binary body is written " +
        '{ base64: ... } and nothing else',
    );
  });

  it('rejects a body JSON cannot hold', () => {
    const issue = only(
      parse(withRules('  - id: a\n    match: { url: "**" }\n    respond: { status: 200, body: { n: .nan } }\n')),
    );
    expect(issue.code).toBe('invalid-body');
    expect(issue.message).toBe(
      "rule 'a' has a respond.body that is not JSON at n: NaN is not a number JSON can hold. A " +
        'body is an object, a string, or { base64: ... } for binary',
    );
  });

  it('warns about a null body rather than silently sending the four bytes "null"', () => {
    const result = parse(
      withRules('  - id: a\n    match: { url: "**" }\n    respond: { status: 204, body: null }\n'),
    );
    expect(result.ok).toBe(true);
    expect(warningsOf(result)[0]?.code).toBe('null-body');
    expect(warningsOf(result)[0]?.message).toBe(
      "rule 'a' responds with a body of null, which sends the four bytes \"null\". Omit body " +
        'entirely for an empty response',
    );
  });
});

describe('unreachable rules (mocking spec §5, "first match wins in file order")', () => {
  it('warns when an earlier rule already covers a later one', () => {
    const result = parse(
      withRules(
        `  - id: everything
    match: { url: "**" }
    abort: true
  - id: forecast
    match: { url: "**" }
    patch: { a: 1 }
`,
      ),
    );
    expect(result.ok).toBe(true);
    const warning = warningsOf(result)[0];
    expect(warning?.code).toBe('unreachable-rule');
    expect(warning?.message).toBe(
      "rule 'forecast' can never match: rule 'everything' at rules[0] already matches the same " +
        'requests, and the first match wins in file order',
    );
    expect(warning?.at.key).toBe('rules[1].match');
  });

  it('does not warn when the earlier rule is narrower', () => {
    const byNth = parse(
      withRules(
        `  - id: first-only
    match: { url: "**/a", nth: 1 }
    abort: true
  - id: rest
    match: { url: "**/a" }
    patch: { a: 1 }
`,
      ),
    );
    expect(warningsOf(byNth)).toEqual([]);

    const byMethod = parse(
      withRules(
        `  - id: get-only
    match: { url: "**/a", method: GET }
    abort: true
  - id: post-only
    match: { url: "**/a", method: POST }
    patch: { a: 1 }
`,
      ),
    );
    expect(warningsOf(byMethod)).toEqual([]);
  });

  it('treats a method-less earlier rule as covering a later method-specific one', () => {
    const result = parse(
      withRules(
        `  - id: any
    match: { url: "**/a" }
    abort: true
  - id: get-only
    match: { url: "**/a", method: GET }
    patch: { a: 1 }
`,
      ),
    );
    expect(warningsOf(result)[0]?.code).toBe('unreachable-rule');
  });
});

describe('validateScenarioSpec — direct', () => {
  function spec(overrides: Partial<ScenarioSpecInput> = {}): ScenarioSpecInput {
    return {
      version: 1,
      scenario: 'empty-forecast',
      rules: [{ id: 'a', match: { url: '**' }, abort: true }],
      ...overrides,
    } as ScenarioSpecInput;
  }

  it('accepts a well-formed spec with no warnings', () => {
    const { issues: found, warnings } = validateScenarioSpec(spec(), echo);
    expect(found).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('reports the offending key path for every rule-level issue', () => {
    const { issues: found } = validateScenarioSpec(
      spec({
        rules: [
          { id: 'a', match: { url: '' }, abort: true },
          { id: 'a', match: { url: '**', nth: 0 }, abort: true },
        ],
      } as Partial<ScenarioSpecInput>),
      echo,
    );
    expect(found.map((issue) => [issue.code, issue.at.key])).toEqual([
      ['missing-url', 'rules[0].match.url'],
      ['duplicate-rule-id', 'rules[1].id'],
      ['invalid-nth', 'rules[1].match.nth'],
    ]);
  });
});

describe('findNonJson', () => {
  it('accepts every JSON shape', () => {
    expect(findNonJson({ a: [1, 'x', true, null, { b: 2 }] })).toBeNull();
    expect(findNonJson([])).toBeNull();
    expect(findNonJson('x')).toBeNull();
  });

  it('names the first offending path', () => {
    expect(findNonJson({ a: { b: [1, Number.NaN] } })).toEqual({
      where: ' at a.b[1]',
      reason: 'NaN is not a number JSON can hold',
    });
    expect(findNonJson(new Map())).toEqual({
      where: '',
      reason: 'a YAML complex-key mapping has no JSON form',
    });
  });

  it('refuses a structure that refers to itself, instead of recursing forever', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(findNonJson(cycle)?.reason).toBe(
      'it refers to itself, and a self-referencing document has no JSON form',
    );
  });
});
