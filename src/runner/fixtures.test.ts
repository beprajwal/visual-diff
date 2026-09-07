import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXIT } from '../types.js';
import { resolveFixturePath, resolveFixturePaths } from './fixtures.js';

const ROOT = path.resolve('/project/.visual-diff');

describe('resolveFixturePath', () => {
  it('resolves a relative path inside .visual-diff', () => {
    expect(resolveFixturePath(ROOT, 'fixtures/spec.pdf')).toBe(path.join(ROOT, 'fixtures', 'spec.pdf'));
    expect(resolveFixturePath(ROOT, './fixtures/spec.pdf')).toBe(path.join(ROOT, 'fixtures', 'spec.pdf'));
  });

  it('refuses an absolute path, an empty one, and one that escapes the directory', () => {
    for (const bad of ['/etc/passwd', '', '   ', '../../.env', 'fixtures/../../secret']) {
      expect(() => resolveFixturePath(ROOT, bad)).toThrowError(
        expect.objectContaining({ exitCode: EXIT.CONFIG_ERROR }),
      );
    }
  });

  it('accepts one file or several, in the order written', () => {
    expect(resolveFixturePaths(ROOT, 'fixtures/a.pdf')).toEqual([path.join(ROOT, 'fixtures', 'a.pdf')]);
    expect(resolveFixturePaths(ROOT, ['fixtures/b.pdf', 'fixtures/a.pdf'])).toEqual([
      path.join(ROOT, 'fixtures', 'b.pdf'),
      path.join(ROOT, 'fixtures', 'a.pdf'),
    ]);
  });
});
