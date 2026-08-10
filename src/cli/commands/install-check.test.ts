/**
 * Drift classification, against doubles.
 *
 * `install.test.ts` proves the statuses against the real registry and a real directory. This file
 * covers the parts a real install cannot easily produce on demand: an adapter edge that throws, a
 * roll-up over a deliberately mixed set of statuses, and the exact wording of the one line a
 * command prints when it notices drift — which is the only remedy D17 permits.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT } from '../../types.js';
import type { FileStatus, HarnessInstallDetail, InstallScope } from '../../adapters/index.js';
import type { CommandContext } from '../command.js';
import type { HarnessInfo, Ports } from '../ports.js';
import { createTestPorts, fakeManagedFiles } from '../testing.js';
import { checkScope, driftNotice, installCheck, isInstalled, statusLabel } from './install-check.js';

const HARNESS: HarnessInfo = {
  id: 'claude-code',
  label: 'Claude Code',
  notes: ['a personal copy overrides the project one'],
};

const PATHS = fakeManagedFiles().map((file) => file.path);

/** Ports whose install edge reports exactly the statuses a test asks for. */
function portsReporting(
  statuses: readonly FileStatus[],
  overrides: Partial<Ports> = {},
): Ports {
  return createTestPorts({
    listAdapters: async () => [HARNESS],
    installAdapter: async (id: string): Promise<HarnessInstallDetail> => ({
      id: id as HarnessInstallDetail['id'],
      written: [],
      skipped: [],
      files: PATHS.map((path, index) => ({
        path,
        status: statuses[index] ?? statuses[statuses.length - 1] ?? 'created',
      })),
    }),
    ...overrides,
  });
}

function context(ports: Ports, version = '1.0.0'): CommandContext {
  return {
    cwd: '/project',
    home: '/home/u',
    ports,
    version,
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    waitForShutdown: async () => undefined,
  };
}

describe('checkScope', () => {
  it('maps every write outcome onto exactly one drift status', async () => {
    const scope = await checkScope(
      context(portsReporting(['created', 'unchanged', 'updated'])),
      'claude-code',
      'project',
      '/project',
    );

    expect(scope.files.map((file) => file.status)).toEqual(['missing', 'current', 'stale']);
    expect(scope.error).toBeNull();
  });

  it('reports a preserved file as modified locally, which outranks everything else', async () => {
    const scope = await checkScope(
      context(portsReporting(['unchanged', 'updated', 'preserved'])),
      'claude-code',
      'project',
      '/project',
    );

    expect(scope.files.map((file) => file.status)).toEqual([
      'current',
      'stale',
      'modified-locally',
    ]);
    expect(scope.status).toBe('modified-locally');
  });

  it('rolls a scope up to the worst case present: stale outranks missing outranks current', async () => {
    const rollUp = async (statuses: readonly FileStatus[]): Promise<string> =>
      (await checkScope(context(portsReporting(statuses)), 'claude-code', 'project', '/project'))
        .status;

    await expect(rollUp(['unchanged', 'unchanged', 'unchanged'])).resolves.toBe('current');
    await expect(rollUp(['created', 'created', 'created'])).resolves.toBe('missing');
    await expect(rollUp(['unchanged', 'created', 'unchanged'])).resolves.toBe('missing');
    await expect(rollUp(['unchanged', 'updated', 'created'])).resolves.toBe('stale');
    await expect(rollUp(['created', 'preserved', 'updated'])).resolves.toBe('modified-locally');
  });

  it('reports an adapter that throws as an unreadable scope, carrying its message', async () => {
    const ports = portsReporting(['created'], {
      installAdapter: async () => {
        throw new Error("AGENTS.md has a malformed visual-diff block: a '<!-- vdiff:start -->' …");
      },
    });

    const scope = await checkScope(context(ports), 'claude-code', 'project', '/project');
    expect(scope.status).toBe('unreadable');
    expect(scope.error).toContain('malformed visual-diff block');
    expect(scope.files).toEqual([]);
    expect(isInstalled(scope)).toBe(false);
  });

  it('survives a composition edge that throws, too', async () => {
    const ports = portsReporting(['unchanged'], {
      adapterFiles: async () => {
        throw new Error('skills/ is missing from this build');
      },
    });

    const scope = await checkScope(context(ports), 'claude-code', 'global', '/home/u');
    expect(scope.status).toBe('unreadable');
    expect(scope.error).toBe('skills/ is missing from this build');
  });

  it('asks the adapter for a dry run, and for the scope it was told to check', async () => {
    const seen: Array<{ root: string; scope?: InstallScope; dryRun?: boolean }> = [];
    const ports = portsReporting(['unchanged'], {
      installAdapter: async (id: string, root: string, options): Promise<HarnessInstallDetail> => {
        const entry: { root: string; scope?: InstallScope; dryRun?: boolean } = { root };
        if (options.scope !== undefined) entry.scope = options.scope;
        if (options.dryRun !== undefined) entry.dryRun = options.dryRun;
        seen.push(entry);
        return { id: id as HarnessInstallDetail['id'], written: [], skipped: [], files: [] };
      },
    });

    await checkScope(context(ports), 'claude-code', 'global', '/home/u');
    expect(seen).toEqual([{ root: '/home/u', scope: 'global', dryRun: true }]);
  });

  /**
   * The stamp is read off the installed bytes, so this needs a real file. It is the one case where
   * `unchanged` is not the final answer: a harness or a human can rewrite frontmatter around a body
   * we would still write verbatim, and the stamp is the thing `--check` exists to compare.
   */
  it('believes a stamp that names another version even when the bytes match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vdiff-check-stamp-'));
    try {
      for (const path of PATHS) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), 'metadata:\n  x-vdiff-version: "0.0.1"\n', 'utf8');
      }

      const scope = await checkScope(
        context(portsReporting(['unchanged'])),
        'claude-code',
        'project',
        root,
      );
      expect(scope.files.every((file) => file.status === 'stale')).toBe(true);
      expect(scope.files[0]?.installedVersion).toBe('0.0.1');
      expect(scope.status).toBe('stale');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves a file whose stamp matches the running version alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vdiff-check-stamp-'));
    try {
      for (const path of PATHS) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), 'metadata:\n  x-vdiff-version: "1.0.0"\n', 'utf8');
      }

      const scope = await checkScope(
        context(portsReporting(['unchanged'])),
        'claude-code',
        'project',
        root,
      );
      expect(scope.status).toBe('current');
      expect(scope.files[0]?.installedVersion).toBe('1.0.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('installCheck', () => {
  it('reports both scopes for every harness and always exits 0', async () => {
    const result = await installCheck(
      context(portsReporting(['created'])),
      [HARNESS],
      '/home/u',
    );

    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.data.harnesses).toHaveLength(1);
    expect(result.data.harnesses[0]?.scopes.map((scope) => scope.scope)).toEqual([
      'project',
      'global',
    ]);
    expect(result.data.harnesses[0]?.notes).toEqual(HARNESS.notes);
    expect(result.data.version).toBe('1.0.0');
  });

  it('calls a missing install "not drift" and a modified one drift', async () => {
    const missing = await installCheck(context(portsReporting(['created'])), [HARNESS], '/home/u');
    expect(missing.data.drift).toBe(false);

    const modified = await installCheck(
      context(portsReporting(['preserved'])),
      [HARNESS],
      '/home/u',
    );
    expect(modified.data.drift).toBe(true);

    const stale = await installCheck(context(portsReporting(['updated'])), [HARNESS], '/home/u');
    expect(stale.data.drift).toBe(true);
  });

  it('flags the duplication on both scopes when both hold an install', async () => {
    const result = await installCheck(
      context(portsReporting(['unchanged'])),
      [HARNESS],
      '/home/u',
    );
    expect(result.data.harnesses[0]?.scopes.every((scope) => scope.duplicate)).toBe(true);
    expect(result.human.join('\n')).toContain('installed in both scopes');
    expect(result.human.join('\n')).toContain('a personal copy overrides the project one');
  });

  it('does not flag duplication when only one scope holds an install', async () => {
    const ports = portsReporting(['unchanged'], {
      installAdapter: async (id: string, root: string, options): Promise<HarnessInstallDetail> => ({
        id: id as HarnessInstallDetail['id'],
        written: [],
        skipped: [],
        files: PATHS.map((path) => ({
          path,
          status: options.scope === 'project' ? ('unchanged' as const) : ('created' as const),
        })),
      }),
    });

    const result = await installCheck(context(ports), [HARNESS], '/home/u');
    expect(result.data.harnesses[0]?.scopes.map((scope) => scope.duplicate)).toEqual([
      false,
      false,
    ]);
    expect(result.human.join('\n')).not.toContain('installed in both scopes');
  });

  it('prints the version it compared against and never claims to have fixed anything', async () => {
    const human = (
      await installCheck(context(portsReporting(['updated'])), [HARNESS], '/home/u')
    ).human.join('\n');

    expect(human).toContain('compared against vdiff 1.0.0');
    expect(human).toContain('Refresh a harness with `vdiff install <harness>`');
    expect(human).toContain('--check reports, it never rewrites');
  });
});

describe('driftNotice', () => {
  it('names the harness, the scope and the status, and points at --check', () => {
    expect(driftNotice('Codex', 'global', 'stale')).toBe(
      'the global install of Codex is stale — run `vdiff install --check` to see what differs',
    );
    expect(driftNotice('pi', 'project', 'modified-locally')).toContain('is modified locally');
  });

  it('offers no way to fix anything: noticing is the whole remedy (D17)', () => {
    const notice = driftNotice('Claude Code', 'global', 'stale');
    expect(notice).not.toMatch(/--force|rewrit|automatically/i);
  });
});

describe('statusLabel', () => {
  it('reads as English for every status the payload can carry', () => {
    expect(statusLabel('missing')).toBe('not installed');
    expect(statusLabel('modified-locally')).toBe('modified locally');
    expect(statusLabel('unreadable')).toBe('unreadable');
    expect(statusLabel('current')).toBe('current');
    expect(statusLabel('stale')).toBe('stale');
  });
});
