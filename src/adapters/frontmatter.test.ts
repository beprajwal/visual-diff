import { describe, expect, it } from 'vitest';

import {
  splitFrontmatter,
  withFrontmatter,
  yamlList,
  yamlString,
  yamlUnquote,
} from './frontmatter.js';

describe('yamlString', () => {
  it('quotes and escapes so a description can never change the parse', () => {
    expect(yamlString('plain')).toBe('"plain"');
    expect(yamlString('has: a colon')).toBe('"has: a colon"');
    expect(yamlString('a "quoted" word')).toBe('"a \\"quoted\\" word"');
    expect(yamlString('back\\slash')).toBe('"back\\\\slash"');
  });

  it('flattens newlines and collapses runs of whitespace', () => {
    expect(yamlString('two\nlines')).toBe('"two lines"');
    expect(yamlString('  padded   out  ')).toBe('"padded out"');
    expect(yamlString('a\tb')).toBe('"a b"');
  });
});

describe('yamlList', () => {
  it('emits a flow sequence of quoted scalars', () => {
    expect(yamlList(['a', 'b'])).toBe('["a", "b"]');
    expect(yamlList([])).toBe('[]');
  });
});

describe('withFrontmatter', () => {
  it('puts the fields above the body, separated by a blank line', () => {
    expect(withFrontmatter([['name', 'x']], '# body')).toBe('---\nname: x\n---\n\n# body\n');
  });

  it('trims the body and ends with exactly one newline', () => {
    const doc = withFrontmatter([['name', 'x']], '\n\n# body\n\n\n');
    expect(doc.endsWith('# body\n')).toBe(true);
    expect(doc.endsWith('\n\n')).toBe(false);
  });

  it('round-trips through splitFrontmatter', () => {
    const doc = withFrontmatter(
      [
        ['name', 'visual-diff'],
        ['description', yamlString('Use when: things')],
      ],
      '# body\n\nmore',
    );
    const split = splitFrontmatter(doc);
    expect(split?.fields).toEqual({
      name: 'visual-diff',
      description: '"Use when: things"',
    });
    expect(split?.body.trim()).toBe('# body\n\nmore');
  });
});

describe('splitFrontmatter', () => {
  it('returns null for a document with no frontmatter', () => {
    expect(splitFrontmatter('# just a heading\n')).toBeNull();
  });

  it('tolerates CRLF input', () => {
    expect(splitFrontmatter('---\r\nname: x\r\n---\r\nbody\r\n')?.fields).toEqual({ name: 'x' });
  });
});

describe('yamlUnquote', () => {
  it('undoes yamlString', () => {
    for (const value of ['plain', 'has: a colon', 'a "quoted" word', 'back\\slash']) {
      expect(yamlUnquote(yamlString(value))).toBe(value);
    }
  });

  it('leaves a bare scalar alone', () => {
    expect(yamlUnquote('0.2.0')).toBe('0.2.0');
    expect(yamlUnquote('  [flow]  ')).toBe('[flow]');
    expect(yamlUnquote('"')).toBe('"');
  });
});

describe('withFrontmatter — nested maps (D17)', () => {
  it('emits a map as an indented block under a bare key', () => {
    const doc = withFrontmatter(
      [
        ['name', 'x'],
        ['metadata', { 'x-vdiff-version': '"0.2.0"', 'x-vdiff-source': '"pkg"' }],
      ],
      '# body',
    );
    expect(doc).toBe(
      '---\nname: x\nmetadata:\n  x-vdiff-version: "0.2.0"\n  x-vdiff-source: "pkg"\n---\n\n# body\n',
    );
  });

  it('drops an empty map rather than emitting a bare key YAML reads as null', () => {
    expect(withFrontmatter([['name', 'x'], ['metadata', {}]], '# body')).toBe(
      '---\nname: x\n---\n\n# body\n',
    );
  });

  it('round-trips a nested field as a dotted key', () => {
    const doc = withFrontmatter(
      [
        ['name', 'visual-diff'],
        ['metadata', { 'x-vdiff-version': yamlString('0.2.0') }],
      ],
      '# body',
    );
    const split = splitFrontmatter(doc);
    expect(split?.fields).toEqual({
      name: 'visual-diff',
      metadata: '',
      'metadata.x-vdiff-version': '"0.2.0"',
    });
    expect(yamlUnquote(split?.fields['metadata.x-vdiff-version'] ?? '')).toBe('0.2.0');
    expect(split?.body.trim()).toBe('# body');
  });

  it('does not mistake a later top-level key for a child of the map', () => {
    const doc = withFrontmatter(
      [
        ['metadata', { a: '"1"' }],
        ['description', '"after"'],
      ],
      '# body',
    );
    const split = splitFrontmatter(doc);
    expect(split?.fields['metadata.a']).toBe('"1"');
    expect(split?.fields['description']).toBe('"after"');
    expect(split?.fields['metadata.description']).toBeUndefined();
  });
});
