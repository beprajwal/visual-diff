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
  planBlock,
  planFile,
  renderManaged,
  stampLine,
  writeManagedFiles,
} from './files.js';
import { BLOCK_END, BLOCK_START, MalformedBlockError } from './blocks.js';

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

describe('planBlock (D19)', () => {
  const body = 'managed content';

  it('creates when the file is absent', () => {
    const planned = planBlock(null, body, 'AGENTS.md');
    expect(planned.status).toBe('created');
    expect(planned.content).toBe(`${BLOCK_START}\n${body}\n${BLOCK_END}\n`);
  });

  it('updates a file with no block, keeping the existing bytes', () => {
    const planned = planBlock('# mine\n', body, 'AGENTS.md');
    expect(planned.status).toBe('updated');
    expect(planned.content.startsWith('# mine\n')).toBe(true);
  });

  it('reports unchanged when the block already says exactly this', () => {
    const once = planBlock('# mine\n', body, 'AGENTS.md').content;
    expect(planBlock(once, body, 'AGENTS.md').status).toBe('unchanged');
  });

  it('never returns preserved: nothing of the user is at risk', () => {
    const edited = `# mine\n\n${BLOCK_START}\nthey edited this\n${BLOCK_END}\n`;
    expect(planBlock(edited, body, 'AGENTS.md').status).toBe('updated');
    expect(planBlock(edited, body, 'AGENTS.md').content.startsWith('# mine\n')).toBe(true);
  });
});

describe('writeManagedFiles — block mode (D19)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vdiff-block-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const block = { path: 'AGENTS.md', body: 'vdiff instructions', mode: 'block' as const };

  it('creates AGENTS.md containing just the block', async () => {
    const report = await writeManagedFiles(root, [block]);
    expect(report.files).toEqual([{ path: 'AGENTS.md', status: 'created' }]);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(
      `${BLOCK_START}\nvdiff instructions\n${BLOCK_END}\n`,
    );
  });

  it('writes no stamp line: the file is the user, not this tool', async () => {
    await writeManagedFiles(root, [block]);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).not.toContain('vdiff:managed');
  });

  it('edits an existing AGENTS.md and leaves every other byte identical', async () => {
    const existing = '# House rules\n\nRun `make lint`.\n';
    await writeFile(join(root, 'AGENTS.md'), existing, 'utf8');

    await writeManagedFiles(root, [block]);
    const after = await readFile(join(root, 'AGENTS.md'), 'utf8');
    expect(after.startsWith(existing)).toBe(true);
    expect(after).toContain('vdiff instructions');
  });

  it('replaces the block on reinstall rather than appending a second one', async () => {
    await writeManagedFiles(root, [{ ...block, body: 'v1' }]);
    const report = await writeManagedFiles(root, [{ ...block, body: 'v2' }]);

    expect(report.files).toEqual([{ path: 'AGENTS.md', status: 'updated' }]);
    const after = await readFile(join(root, 'AGENTS.md'), 'utf8');
    expect(after.match(new RegExp(BLOCK_START, 'g'))).toHaveLength(1);
    expect(after).toContain('v2');
    expect(after).not.toContain('v1');
  });

  it('is idempotent', async () => {
    await writeManagedFiles(root, [block]);
    const before = await readFile(join(root, 'AGENTS.md'), 'utf8');
    const second = await writeManagedFiles(root, [block]);
    expect(second.written).toEqual([]);
    expect(second.skipped).toEqual(['AGENTS.md']);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(before);
  });

  it('refuses a start marker with no end marker, and writes nothing', async () => {
    const broken = `# notes\n\n${BLOCK_START}\nhalf a block\n`;
    await writeFile(join(root, 'AGENTS.md'), broken, 'utf8');

    await expect(writeManagedFiles(root, [block])).rejects.toThrow(MalformedBlockError);
    await expect(writeManagedFiles(root, [block])).rejects.toThrow(
      /AGENTS\.md has a malformed visual-diff block: a '<!-- vdiff:start -->' marker with no matching '<!-- vdiff:end -->'/,
    );
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(broken);
  });

  it('refuses a malformed block under --dry-run too, which is the point of a dry run', async () => {
    await writeFile(join(root, 'AGENTS.md'), `${BLOCK_START}\nx\n`, 'utf8');
    await expect(writeManagedFiles(root, [block], { dryRun: true })).rejects.toThrow(
      MalformedBlockError,
    );
  });

  it('dryRun on a clean tree reports the create without touching the disk', async () => {
    const report = await writeManagedFiles(root, [block], { dryRun: true });
    expect(report.files).toEqual([{ path: 'AGENTS.md', status: 'created' }]);
    await expect(readFile(join(root, 'AGENTS.md'), 'utf8')).rejects.toThrow();
  });
});
