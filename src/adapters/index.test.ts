import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ADAPTERS, getAdapter, installAdapter, listAdapters } from './index.js';
import { CLAUDE_CODE_PATHS } from './claude-code/index.js';

describe('adapter registry (spec §5)', () => {
  it('registers exactly one adapter in slice 1', () => {
    expect(listAdapters()).toEqual(['claude-code']);
  });

  it('exposes a label for every adapter', () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.label.length).toBeGreaterThan(0);
      expect(typeof adapter.install).toBe('function');
    }
  });

  it('has no duplicate ids', () => {
    expect(new Set(listAdapters()).size).toBe(ADAPTERS.length);
  });

  it('resolves a known id and rejects an unknown one', () => {
    expect(getAdapter('claude-code')?.id).toBe('claude-code');
    expect(getAdapter('codex')).toBeUndefined();
  });
});

describe('installAdapter', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vdiff-registry-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('installs through the registry', async () => {
    const result = await installAdapter('claude-code', root);
    expect(result.id).toBe('claude-code');
    expect(result.written).toEqual(Object.values(CLAUDE_CODE_PATHS));
  });

  it('passes install options through', async () => {
    const result = await installAdapter('claude-code', root, { dryRun: true });
    expect(result.written).toHaveLength(3);
    await expect(readdir(join(root, '.claude'))).rejects.toThrow();
  });

  it('throws a listing error for an unknown harness', async () => {
    await expect(installAdapter('opencode', root)).rejects.toThrow(
      /unknown adapter 'opencode'\. Available: claude-code/,
    );
  });
});
