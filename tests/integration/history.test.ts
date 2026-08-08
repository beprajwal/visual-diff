/**
 * The scripted fixture history (spec §11.2): "A small Vite app in the repository with roughly six
 * commits containing known UI changes: label edit, restyle, layout shift, added step, renamed
 * selector, introduced console error."
 *
 * This drives `fixtures/build-history.mjs` for real — `git init` in a throwaway directory, seven
 * commits, then verification through `git show`. It is the check that D4 rests on: every revision
 * must hand its *own* flow spec back out of history, or replaying an old iteration silently uses
 * today's selectors.
 *
 * The builder pins `GIT_DIR`/`GIT_WORK_TREE` at the throwaway directory and refuses any output path
 * outside `fixtures/.tmp` or the OS temp dir, so it cannot reach this repository's working tree —
 * the §10 non-negotiable, enforced rather than intended.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

// The builder is plain ESM JavaScript, deliberately runnable as `node fixtures/build-history.mjs`.
// @ts-expect-error -- no type declarations for a fixture script
import * as history from '../../fixtures/build-history.mjs';

interface BuiltCommit {
  order: number;
  name: string;
  change: string;
  message: string;
  sha: string | null;
  files: string[];
}

interface BuildResult {
  dir: string;
  branch: string;
  dryRun: boolean;
  commits: BuiltCommit[];
}

interface VerifyResult {
  ok: boolean;
  failures: string[];
}

const builder = history as {
  buildFixtureHistory(options?: { out?: string; dryRun?: boolean }): Promise<BuildResult>;
  verifyFixtureHistory(result: BuildResult): Promise<VerifyResult>;
  verifyOverlaySources(): Promise<VerifyResult>;
  CHANGE_SEQUENCE: string[];
  FLOW_PATH: string;
  showAt(dir: string, sha: string, path: string): Promise<string>;
};

const dirs: string[] = [];

afterAll(async () => {
  // Retried and swallowed: the fixture repository's git may still be flushing when we tear down.
  await Promise.all(
    dirs.map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(
        () => undefined,
      ),
    ),
  );
});

async function scratch(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'vdiff-history-')), 'checkout-history');
  dirs.push(dir);
  return dir;
}

describe('the fixture overlays', () => {
  it('apply cleanly and cumulatively, and each commit means what it claims', async () => {
    const result = await builder.verifyOverlaySources();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('cover the six changes the spec names', () => {
    expect(builder.CHANGE_SEQUENCE).toEqual([
      'baseline',
      'label edit',
      'restyle',
      'layout shift',
      'added step',
      'renamed selector',
      'introduced console error',
    ]);
  });
});

describe('building the history', () => {
  it('materialises seven commits in a throwaway repository', async () => {
    const out = await scratch();
    const result = await builder.buildFixtureHistory({ out });

    expect(result.dir).toBe(out);
    expect(result.commits).toHaveLength(7);
    expect(result.commits.map((commit) => commit.change)).toEqual(builder.CHANGE_SEQUENCE);
    for (const commit of result.commits) {
      expect(commit.sha, `${commit.name} has no sha`).toMatch(/^[0-9a-f]{40}$/);
    }

    const verified = await builder.verifyFixtureHistory(result);
    expect(verified.failures).toEqual([]);
    expect(verified.ok).toBe(true);
  }, 120_000);

  it('lets every revision hand back its own flow spec (D4)', async () => {
    const out = await scratch();
    const result = await builder.buildFixtureHistory({ out });

    const at = async (name: string): Promise<string> => {
      const commit = result.commits.find((entry) => entry.name === name);
      if (commit?.sha == null) throw new Error(`no commit named ${name}`);
      return builder.showAt(result.dir, commit.sha, builder.FLOW_PATH);
    };

    // The renamed-selector commit is the D4 drift signal: same step id, different selector.
    expect(await at('base')).toContain('click: "#pay"');
    expect(await at('05-renamed-selector')).toContain('[data-test=pay]');
    expect(await at('05-renamed-selector')).toContain('- id: pay-click');
    // The added-step commit adds a step id that does not exist in the baseline spec.
    expect(await at('base')).not.toContain('id: receipt');
    expect(await at('04-added-step')).toContain('id: receipt');
  }, 120_000);
});
