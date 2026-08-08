import { describe, expect, it } from 'vitest';

import { splitFrontmatter, withFrontmatter, yamlList, yamlString } from './frontmatter.js';

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
