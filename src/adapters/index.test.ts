import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ADAPTERS, getAdapter, installAdapter, listAdapters } from './index.js';
import { claudeCodeFiles } from './claude-code/index.js';

describe('adapter registry (spec §5)', () => {
  it('registers exactly one adapter in slice 1', () => {
    expect(listAdapters()).toEqual(['claude-code']);
  });

  it('exposes a label, an install and a files description for every adapter', () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.label.length).toBeGreaterThan(0);
      expect(typeof adapter.install).toBe('function');
      expect(typeof adapter.files).toBe('function');
    }
  });

  it('has no duplicate ids', () => {
    expect(new Set(listAdapters()).size).toBe(ADAPTERS.length);
  });

  it('resolves a known id and rejects an unknown one', () => {
    expect(getAdapter('claude-code')?.id).toBe('claude-code');
    expect(getAdapter('codex')).toBeUndefined();
  });

  it('every registered adapter ships the same three skills and two commands', async () => {
    for (const adapter of ADAPTERS) {
      const files = await adapter.files();
      expect(files.filter((f) => f.path.endsWith('SKILL.md')), adapter.id).toHaveLength(3);
      expect(files, adapter.id).toHaveLength(5);
    }
  });
});

describe('installAdapter', () => {
  let root: string;
  let expected: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vdiff-registry-'));
    expected = (await claudeCodeFiles()).map((file) => file.path);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('installs through the registry', async () => {
    const result = await installAdapter('claude-code', root);
    expect(result.id).toBe('claude-code');
    expect(result.written).toEqual(expected);
  });

  it('passes install options through', async () => {
    const result = await installAdapter('claude-code', root, { dryRun: true });
    expect(result.written).toEqual(expected);
    await expect(readdir(join(root, '.claude'))).rejects.toThrow();
  });

  it('throws a listing error for an unknown harness', async () => {
    await expect(installAdapter('opencode', root)).rejects.toThrow(
      /unknown adapter 'opencode'\. Available: claude-code/,
    );
  });
});
