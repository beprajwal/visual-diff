import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MANAGED_STAMP_VERSION,
  bodyHash,
  isUnmodifiedManaged,
  normalizeBody,
  parseManaged,
  planFile,
  renderManaged,
  stampLine,
  writeManagedFiles,
} from './files.js';

describe('normalizeBody', () => {
  it('converts CRLF to LF and ends with exactly one newline', () => {
    expect(normalizeBody('a\r\nb\r\n')).toBe('a\nb\n');
    expect(normalizeBody('a\n\n\n')).toBe('a\n');
    expect(normalizeBody('a')).toBe('a\n');
  });

  it('leaves interior blank lines alone', () => {
    expect(normalizeBody('a\n\nb')).toBe('a\n\nb\n');
  });
});

describe('renderManaged / parseManaged', () => {
  it('appends a stamp carrying the sha256 of the body', () => {
    const rendered = renderManaged('# hello\n');
    const lines = rendered.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toBe(stampLine(bodyHash('# hello')));
    expect(rendered.startsWith('# hello\n')).toBe(true);
    expect(rendered.endsWith('-->\n')).toBe(true);
  });

  it('round-trips the body it wrote', () => {
    const body = '# title\n\nsome *markdown* with `backticks`\n';
    const parsed = parseManaged(renderManaged(body));
    expect(parsed).not.toBeNull();
    expect(parsed?.body).toBe(normalizeBody(body));
    expect(parsed?.hash).toBe(bodyHash(body));
  });

  it('returns null for a file with no stamp', () => {
    expect(parseManaged('# just markdown\n')).toBeNull();
    expect(parseManaged('<!-- vdiff:managed -->')).toBeNull();
  });

  it('is stable across renders of identical content', () => {
    expect(renderManaged('same')).toBe(renderManaged('same\n'));
  });

  it('uses the declared stamp version', () => {
    expect(stampLine('0'.repeat(64))).toContain(` ${MANAGED_STAMP_VERSION} `);
  });
});

describe('isUnmodifiedManaged', () => {
  it('is true for freshly rendered content', () => {
    expect(isUnmodifiedManaged(renderManaged('body'))).toBe(true);
  });

  it('is false once the body is edited but the stamp is left behind', () => {
    const edited = renderManaged('body').replace('body', 'body edited by a human');
    expect(isUnmodifiedManaged(edited)).toBe(false);
  });

  it('is false when the stamp is removed entirely', () => {
    expect(isUnmodifiedManaged('body\n')).toBe(false);
  });

  it('tolerates CRLF rewriting by an editor', () => {
    const crlf = renderManaged('line one\nline two').replace(/\n/g, '\r\n');
    expect(isUnmodifiedManaged(crlf)).toBe(true);
  });
});

describe('planFile', () => {
  const body = '# doc\n';

  it('creates when nothing is there', () => {
    expect(planFile(null, body)).toBe('created');
  });

  it('reports unchanged when the bytes already match', () => {
    expect(planFile(renderManaged(body), body)).toBe('unchanged');
  });

  it('updates a stale file this tool wrote', () => {
    expect(planFile(renderManaged('# old doc\n'), body)).toBe('updated');
  });

  it('preserves a human-edited file', () => {
    const edited = `${renderManaged('# old doc\n').trimEnd()}\n\nmy own notes\n`;
    expect(planFile(edited, body)).toBe('preserved');
  });

  it('preserves a file that was never ours', () => {
    expect(planFile('# hand written\n', body)).toBe('preserved');
  });

  it('overwrites a human-edited file only when forced', () => {
    expect(planFile('# hand written\n', body, true)).toBe('updated');
  });
});

describe('writeManagedFiles', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vdiff-adapter-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const files = [
    { path: 'a/one.md', body: '# one\n' },
    { path: 'b/two.md', body: '# two\n' },
  ];

  it('creates every file, making parent directories', async () => {
    const report = await writeManagedFiles(root, files);
    expect(report.written).toEqual(['a/one.md', 'b/two.md']);
    expect(report.skipped).toEqual([]);
    expect(await readFile(join(root, 'a/one.md'), 'utf8')).toBe(renderManaged('# one\n'));
  });

  it('is idempotent: a second install writes nothing', async () => {
    await writeManagedFiles(root, files);
    const second = await writeManagedFiles(root, files);
    expect(second.written).toEqual([]);
    expect(second.skipped).toEqual(['a/one.md', 'b/two.md']);
    expect(second.files.map((f) => f.status)).toEqual(['unchanged', 'unchanged']);
  });

  it('refreshes its own file when the shipped content changes', async () => {
    await writeManagedFiles(root, files);
    const next = await writeManagedFiles(root, [{ path: 'a/one.md', body: '# one, revised\n' }]);
    expect(next.files).toEqual([{ path: 'a/one.md', status: 'updated' }]);
    expect(await readFile(join(root, 'a/one.md'), 'utf8')).toContain('# one, revised');
  });

  it('never overwrites a human edit, and reports it as skipped', async () => {
    await writeManagedFiles(root, files);
    const edited = `${(await readFile(join(root, 'a/one.md'), 'utf8')).trimEnd()}\n\nhuman note\n`;
    await writeFile(join(root, 'a/one.md'), edited, 'utf8');

    const report = await writeManagedFiles(root, [{ path: 'a/one.md', body: '# one, revised\n' }]);

    expect(report.written).toEqual([]);
    expect(report.skipped).toEqual(['a/one.md']);
    expect(report.files).toEqual([{ path: 'a/one.md', status: 'preserved' }]);
    expect(await readFile(join(root, 'a/one.md'), 'utf8')).toBe(edited);
  });

  it('overwrites a human edit under force', async () => {
    await writeManagedFiles(root, files);
    await writeFile(join(root, 'a/one.md'), '# mine now\n', 'utf8');

    const report = await writeManagedFiles(root, [{ path: 'a/one.md', body: '# one\n' }], {
      force: true,
    });

    expect(report.files).toEqual([{ path: 'a/one.md', status: 'updated' }]);
    expect(await readFile(join(root, 'a/one.md'), 'utf8')).toBe(renderManaged('# one\n'));
  });

  it('dryRun computes outcomes without touching the disk', async () => {
    const report = await writeManagedFiles(root, files, { dryRun: true });
    expect(report.written).toEqual(['a/one.md', 'b/two.md']);
    await expect(readFile(join(root, 'a/one.md'), 'utf8')).rejects.toThrow();
  });

  it('refuses to escape the project root', async () => {
    await expect(
      writeManagedFiles(root, [{ path: '../escaped.md', body: 'x' }]),
    ).rejects.toThrow(/escape|inside the project root/i);

    await expect(
      writeManagedFiles(root, [{ path: '/etc/passwd', body: 'x' }]),
    ).rejects.toThrow(/inside the project root/i);
  });

  it('treats a pre-existing directory of the same shape as an update target', async () => {
    await mkdir(join(root, 'a'), { recursive: true });
    await writeFile(join(root, 'a/one.md'), renderManaged('# one\n'), 'utf8');
    const report = await writeManagedFiles(root, [{ path: 'a/one.md', body: '# one\n' }]);
    expect(report.files).toEqual([{ path: 'a/one.md', status: 'unchanged' }]);
  });
});
