import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ADAPTERS,
  CLAUDE_CODE,
  HARNESSES,
  HARNESS_IDS,
  HARNESS_NOTES,
  getAdapter,
  installAdapter,
  listAdapters,
} from './index.js';
import { claudeCodeAdapter, claudeCodeFiles } from './claude-code/index.js';
import { loadSkillBundle, type SkillBundle } from './source.js';
import type { HarnessId, InstallScope } from './harnesses.js';

let bundle: SkillBundle;

beforeEach(async () => {
  bundle = await loadSkillBundle();
});

describe('adapter registry (spec §5, harness-packaging spec §4)', () => {
  it('registers the four harnesses of subsystem 1, in table order', () => {
    expect(listAdapters()).toEqual(['claude-code', 'codex', 'opencode', 'pi']);
    expect(listAdapters()).toEqual([...HARNESS_IDS]);
  });

  it('is generated from the table, so the two can never disagree', () => {
    expect(ADAPTERS.map((adapter) => adapter.id)).toEqual(HARNESSES.map((harness) => harness.id));
    expect(ADAPTERS.map((adapter) => adapter.label)).toEqual(
      HARNESSES.map((harness) => harness.label),
    );
  });

  it('exposes a label, an install, a files description and its targets for every adapter', () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.label.length, adapter.id).toBeGreaterThan(0);
      expect(typeof adapter.install, adapter.id).toBe('function');
      expect(typeof adapter.files, adapter.id).toBe('function');
      expect(typeof adapter.targets, adapter.id).toBe('function');
    }
  });

  it('carries each harness caveats, so install output need not look them up', () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.notes, adapter.id).toBe(HARNESS_NOTES[adapter.id]);
      expect(adapter.notes.length, adapter.id).toBeGreaterThan(0);
    }
  });

  it('has no duplicate ids', () => {
    expect(new Set(listAdapters()).size).toBe(ADAPTERS.length);
  });

  it('resolves a known id and rejects an unknown one', () => {
    expect(getAdapter('claude-code')?.id).toBe('claude-code');
    expect(getAdapter('codex')?.id).toBe('codex');
    expect(getAdapter('opencode')?.id).toBe('opencode');
    expect(getAdapter('pi')?.id).toBe('pi');
    expect(getAdapter('cursor')).toBeUndefined();
  });

  it('hands back the same adapter object for a harness, however it is reached', () => {
    expect(getAdapter('claude-code')).toBe(claudeCodeAdapter);
    expect(ADAPTERS[0]).toBe(claudeCodeAdapter);
  });

  it('ships the same three skills to every harness, at that harness own path', async () => {
    for (const adapter of ADAPTERS) {
      const files = await adapter.files();
      const skills = files.filter((file) => file.path.endsWith('SKILL.md'));
      expect(skills, adapter.id).toHaveLength(bundle.skills.length);

      const dir = adapter.targets().skills;
      expect(dir, adapter.id).not.toBeNull();
      for (const skill of bundle.manifest.skills) {
        expect(skills.map((file) => file.path), adapter.id).toContain(
          `${dir as string}/${skill.id}/SKILL.md`,
        );
      }
    }
  });

  it('writes commands only for the harnesses that have a commands target', async () => {
    for (const adapter of ADAPTERS) {
      const files = await adapter.files();
      const commandDir = adapter.targets().commands;
      const commands = files.filter((file) => !file.path.endsWith('SKILL.md') && file.path.endsWith('.md') && file.path !== 'AGENTS.md');

      if (commandDir === null) {
        expect(commands, `${adapter.id} has no commands target`).toEqual([]);
      } else {
        expect(commands.map((file) => file.path), adapter.id).toEqual(
          bundle.manifest.commands.map((command) => `${commandDir}/${command.id}.md`),
        );
      }
    }
  });

  it('writes an instructions block only for the harnesses that read AGENTS.md', async () => {
    const withInstructions: HarnessId[] = [];
    for (const adapter of ADAPTERS) {
      const files = await adapter.files();
      const blocks = files.filter((file) => file.mode === 'block');
      if (blocks.length > 0) withInstructions.push(adapter.id);
      expect(blocks.length, adapter.id).toBeLessThanOrEqual(1);
      expect(blocks.map((file) => file.path), adapter.id).toEqual(
        adapter.targets().instructions === null ? [] : [adapter.targets().instructions],
      );
    }
    expect(withInstructions).toEqual(['codex', 'opencode', 'pi']);
  });

  it('composes every path relative and inside the root, for both scopes', async () => {
    for (const scope of ['project', 'global'] as InstallScope[]) {
      for (const adapter of ADAPTERS) {
        for (const file of await adapter.files(scope)) {
          expect(file.path.startsWith('/'), `${adapter.id}/${scope}: ${file.path}`).toBe(false);
          expect(file.path.startsWith('~'), `${adapter.id}/${scope}: ${file.path}`).toBe(false);
          expect(file.path.split('/'), `${adapter.id}/${scope}`).not.toContain('..');
        }
      }
    }
  });
});

describe('path map (harness-packaging spec §4)', () => {
  /** The exact file list each harness writes, project scope. This table is the coverage. */
  const PROJECT: Record<HarnessId, string[]> = {
    'claude-code': [
      '.claude/skills/visual-diff/SKILL.md',
      '.claude/skills/visual-diff-flows/SKILL.md',
      '.claude/skills/visual-diff-review/SKILL.md',
      '.claude/commands/vdiff.md',
      '.claude/commands/vdiff-review.md',
    ],
    codex: [
      '.agents/skills/visual-diff/SKILL.md',
      '.agents/skills/visual-diff-flows/SKILL.md',
      '.agents/skills/visual-diff-review/SKILL.md',
      'AGENTS.md',
    ],
    opencode: [
      '.agents/skills/visual-diff/SKILL.md',
      '.agents/skills/visual-diff-flows/SKILL.md',
      '.agents/skills/visual-diff-review/SKILL.md',
      '.opencode/commands/vdiff.md',
      '.opencode/commands/vdiff-review.md',
      'AGENTS.md',
    ],
    pi: [
      '.agents/skills/visual-diff/SKILL.md',
      '.agents/skills/visual-diff-flows/SKILL.md',
      '.agents/skills/visual-diff-review/SKILL.md',
      'AGENTS.md',
    ],
  };

  /** Global scope. Relative to `$HOME`, which is why none of these start with `~`. */
  const GLOBAL: Record<HarnessId, string[]> = {
    'claude-code': PROJECT['claude-code'],
    codex: [
      '.agents/skills/visual-diff/SKILL.md',
      '.agents/skills/visual-diff-flows/SKILL.md',
      '.agents/skills/visual-diff-review/SKILL.md',
      '.codex/AGENTS.md',
    ],
    opencode: [
      '.agents/skills/visual-diff/SKILL.md',
      '.agents/skills/visual-diff-flows/SKILL.md',
      '.agents/skills/visual-diff-review/SKILL.md',
      '.config/opencode/commands/vdiff.md',
      '.config/opencode/commands/vdiff-review.md',
      '.config/opencode/AGENTS.md',
    ],
    // pi documents no user-level AGENTS.md, so a global install writes skills and nothing else.
    pi: [
      '.agents/skills/visual-diff/SKILL.md',
      '.agents/skills/visual-diff-flows/SKILL.md',
      '.agents/skills/visual-diff-review/SKILL.md',
    ],
  };

  for (const id of HARNESS_IDS) {
    it(`${id}: writes the documented project paths`, async () => {
      const adapter = getAdapter(id);
      expect(adapter).toBeDefined();
      const files = await (adapter as NonNullable<typeof adapter>).files('project');
      expect(files.map((file) => file.path)).toEqual(PROJECT[id]);
    });

    it(`${id}: writes the documented global paths`, async () => {
      const adapter = getAdapter(id);
      expect(adapter).toBeDefined();
      const files = await (adapter as NonNullable<typeof adapter>).files('global');
      expect(files.map((file) => file.path)).toEqual(GLOBAL[id]);
    });
  }

  it('shares .agents/skills between Codex, opencode and pi (D18)', async () => {
    for (const id of ['codex', 'opencode', 'pi'] as HarnessId[]) {
      expect(getAdapter(id)?.targets('project').skills, id).toBe('.agents/skills');
      expect(getAdapter(id)?.targets('global').skills, id).toBe('.agents/skills');
    }
    // Claude Code does not read `.agents/skills`, so it keeps its native path.
    expect(getAdapter('claude-code')?.targets('project').skills).toBe('.claude/skills');
    expect(CLAUDE_CODE.skills?.project).toBe('.claude/skills');
  });

  it('names the real directory written, which is what install output prints (D18)', () => {
    const codex = getAdapter('codex')?.targets('project');
    expect(codex).toEqual({
      scope: 'project',
      skills: '.agents/skills',
      commands: null,
      instructions: 'AGENTS.md',
    });
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
    const expected = (await claudeCodeFiles()).map((file) => file.path);
    const result = await installAdapter('claude-code', root);
    expect(result.id).toBe('claude-code');
    expect(result.written).toEqual(expected);
  });

  it('passes install options through', async () => {
    const expected = (await claudeCodeFiles()).map((file) => file.path);
    const result = await installAdapter('claude-code', root, { dryRun: true });
    expect(result.written).toEqual(expected);
    await expect(readdir(join(root, '.claude'))).rejects.toThrow();
  });

  it('throws a listing error naming every supported harness', async () => {
    await expect(installAdapter('cursor', root)).rejects.toThrow(
      /unknown adapter 'cursor'\. Available: claude-code, codex, opencode, pi/,
    );
  });

  for (const id of HARNESS_IDS) {
    it(`${id}: a real install writes exactly what files() described, and is idempotent`, async () => {
      const adapter = getAdapter(id);
      const planned = await (adapter as NonNullable<typeof adapter>).files('project');

      const first = await installAdapter(id, root);
      expect(first.written).toEqual(planned.map((file) => file.path));
      expect(first.skipped).toEqual([]);

      for (const file of planned) {
        const onDisk = await readFile(join(root, file.path), 'utf8');
        expect(onDisk.length, file.path).toBeGreaterThan(0);
      }

      const second = await installAdapter(id, root);
      expect(second.written, `${id} rewrote files on a second install`).toEqual([]);
      expect(second.skipped).toEqual(planned.map((file) => file.path));
    });
  }

  it('installs every harness into one project without any of them colliding', async () => {
    const seen = new Map<string, HarnessId[]>();
    for (const id of HARNESS_IDS) {
      const result = await installAdapter(id, root);
      for (const path of [...result.written, ...result.skipped]) {
        seen.set(path, [...(seen.get(path) ?? []), id]);
      }
    }

    // Only the deliberately shared artifacts are touched by more than one harness, and Claude Code
    // shares nothing: everything it writes is under `.claude/`.
    const shared = [...seen.entries()].filter(([, ids]) => ids.length > 1);
    for (const [path, ids] of shared) {
      expect(path.startsWith('.agents/skills/') || path === 'AGENTS.md', path).toBe(true);
      expect(ids.every((id) => id !== 'claude-code'), path).toBe(true);
    }

    const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
    expect(agents.match(/<!-- vdiff:start -->/g), 'one block, however many harnesses wrote it')
      .toHaveLength(1);
  });

  it('does not let the .agents/skills harnesses rewrite each other files (D18)', async () => {
    const codex = await installAdapter('codex', root);
    expect(codex.written.filter((path) => path.startsWith('.agents/skills/'))).toHaveLength(3);

    for (const id of ['opencode', 'pi'] as HarnessId[]) {
      const later = await installAdapter(id, root);
      expect(
        later.written.filter((path) => path.startsWith('.agents/skills/')),
        `${id} rewrote the shared skill files Codex had already installed`,
      ).toEqual([]);
    }
  });
});
