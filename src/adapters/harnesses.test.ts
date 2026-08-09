import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE,
  CODEX,
  HARNESSES,
  HARNESS_IDS,
  HARNESS_NOTES,
  INSTALL_SCOPES,
  OPENCODE,
  PI,
  SOURCE_KEY,
  VDIFF_SOURCE,
  VERSION_KEY,
  getHarness,
  isHarnessId,
  targetPath,
  versionStamp,
  type Harness,
  type HarnessId,
  type InstallScope,
  type SkillMeta,
  type Target,
} from './harnesses.js';
import type { AdapterId } from '../types.js';
import { withFrontmatter, splitFrontmatter } from './frontmatter.js';

const KINDS = ['skills', 'commands', 'instructions'] as const;

function targetsOf(harness: Harness): Array<[kind: string, target: Target | null]> {
  return KINDS.map((kind) => [kind, harness[kind]]);
}

describe('the table itself', () => {
  it('holds one row per declared id, in the same order', () => {
    expect(HARNESSES.map((harness) => harness.id)).toEqual([...HARNESS_IDS]);
    expect(HARNESSES).toEqual([CLAUDE_CODE, CODEX, OPENCODE, PI]);
  });

  it('is the same set of ids the published `AdapterId` names', () => {
    // Assignable both ways, so neither union can gain or lose a harness without the other. The
    // published type is what a consumer of the package sees `vdiff install` accepting; a table row
    // added without widening it would make that type lie.
    const fromTable: AdapterId[] = [...HARNESS_IDS];
    const fromTypes: HarnessId[] = ['claude-code', 'codex', 'opencode', 'pi'];
    expect(fromTable.slice().sort()).toEqual(fromTypes.slice().sort());
    expect(fromTable).toEqual([...HARNESS_IDS]);
  });

  it('recognises exactly the four ids', () => {
    for (const id of HARNESS_IDS) expect(isHarnessId(id), id).toBe(true);
    expect(isHarnessId('cursor')).toBe(false);
    expect(isHarnessId('')).toBe(false);
    expect(getHarness('cursor')).toBeUndefined();
    expect(getHarness('pi')).toBe(PI);
  });

  it('gives every harness a non-empty label and at least one target', () => {
    for (const harness of HARNESSES) {
      expect(harness.label.trim().length, harness.id).toBeGreaterThan(0);
      const present = targetsOf(harness).filter(([, target]) => target !== null);
      expect(present.length, `${harness.id} would install nothing`).toBeGreaterThan(0);
    }
  });

  it('never declares a target that resolves to nothing in either scope', () => {
    for (const harness of HARNESSES) {
      for (const [kind, target] of targetsOf(harness)) {
        if (target === null) continue;
        const resolved = INSTALL_SCOPES.map((scope) => targetPath(target, scope));
        expect(
          resolved.some((path) => path !== null),
          `${harness.id}.${kind} is a Target with no path in either scope`,
        ).toBe(true);
      }
    }
  });

  it('keeps every path relative, so one root serves both scopes', () => {
    for (const harness of HARNESSES) {
      for (const [kind, target] of targetsOf(harness)) {
        if (target === null) continue;
        for (const scope of INSTALL_SCOPES) {
          const path = targetPath(target, scope);
          if (path === null) continue;
          const where = `${harness.id}.${kind}.${scope} = ${path}`;
          expect(path.startsWith('/'), where).toBe(false);
          expect(path.startsWith('~'), where).toBe(false);
          expect(path.includes('\\'), where).toBe(false);
          expect(path.split('/'), where).not.toContain('..');
          expect(path.endsWith('/'), where).toBe(false);
        }
      }
    }
  });
});

describe('the path map (harness-packaging spec §4, D18)', () => {
  it('gives Claude Code its native directories and no AGENTS.md', () => {
    expect(CLAUDE_CODE.skills).toEqual({ project: '.claude/skills', global: '.claude/skills' });
    expect(CLAUDE_CODE.commands).toEqual({
      project: '.claude/commands',
      global: '.claude/commands',
    });
    // Claude Code reads CLAUDE.md, never AGENTS.md, and its docs never mention `.agents/skills`.
    expect(CLAUDE_CODE.instructions).toBeNull();
  });

  it('routes Codex, opencode and pi through the shared .agents/skills directory', () => {
    for (const harness of [CODEX, OPENCODE, PI]) {
      expect(harness.skills, harness.id).toEqual({
        project: '.agents/skills',
        global: '.agents/skills',
      });
    }
  });

  it('gives Codex no commands target, because ~/.codex/prompts is deprecated', () => {
    expect(CODEX.commands).toBeNull();
    expect(CODEX.instructions).toEqual({ project: 'AGENTS.md', global: '.codex/AGENTS.md' });
  });

  it('gives opencode its plural commands directories and both AGENTS.md locations', () => {
    expect(OPENCODE.commands).toEqual({
      project: '.opencode/commands',
      global: '.config/opencode/commands',
    });
    expect(OPENCODE.instructions).toEqual({
      project: 'AGENTS.md',
      global: '.config/opencode/AGENTS.md',
    });
  });

  it('gives pi no commands target and no global AGENTS.md', () => {
    // pi invokes a skill as `/skill:<name>`, which needs no file, and documents no user-level
    // AGENTS.md — writing ~/AGENTS.md on a guess would be worse than writing nothing.
    expect(PI.commands).toBeNull();
    expect(PI.instructions).toEqual({ project: 'AGENTS.md', global: null });
  });
});

describe('frontmatter composition (D17)', () => {
  const skill: SkillMeta = {
    kind: 'skill',
    id: 'visual-diff',
    name: 'visual-diff',
    description: 'Verify UI you just built.',
  };
  const command: SkillMeta = {
    kind: 'command',
    id: 'vdiff',
    name: 'vdiff',
    description: 'Capture, diff, report.',
    invokes: 'visual-diff',
  };

  function fields(harness: Harness, meta: SkillMeta): Record<string, string> {
    const doc = withFrontmatter(harness.frontmatter(meta, '9.9.9'), '# body');
    const split = splitFrontmatter(doc);
    if (split === null) throw new Error('composed document has no frontmatter');
    return split.fields;
  }

  it('gives every harness the two fields the Agent Skills spec requires', () => {
    for (const harness of HARNESSES) {
      const composed = fields(harness, skill);
      expect(composed['name'], harness.id).toBe('visual-diff');
      expect(composed['description'], harness.id).toBe('"Verify UI you just built."');
    }
  });

  it('stamps the version under metadata, as quoted strings', () => {
    for (const harness of HARNESSES) {
      const composed = fields(harness, skill);
      expect(composed[`metadata.${VERSION_KEY}`], harness.id).toBe('"9.9.9"');
      expect(composed[`metadata.${SOURCE_KEY}`], harness.id).toBe(`"${VDIFF_SOURCE}"`);
      // Quoted, because a bare 0.2.0 or 1.0 does not survive a YAML parse as a string.
      expect(composed[`metadata.${VERSION_KEY}`]?.startsWith('"'), harness.id).toBe(true);
    }
  });

  it('never emits a top-level x-vdiff key, which no harness sanctions', () => {
    for (const harness of HARNESSES) {
      for (const meta of [skill, command]) {
        const composed = fields(harness, meta);
        for (const key of Object.keys(composed)) {
          if (key.startsWith('metadata.')) continue;
          expect(key.startsWith('x-vdiff'), `${harness.id}/${meta.kind}: ${key}`).toBe(false);
        }
      }
    }
  });

  it('keeps opencode inside the five fields it recognises', () => {
    // opencode: "only these fields are recognized" — name, description, license, compatibility,
    // metadata. Anything else is dead weight in the file.
    const allowed = new Set(['name', 'description', 'license', 'compatibility', 'metadata']);
    for (const key of Object.keys(fields(OPENCODE, skill))) {
      if (key.includes('.')) continue;
      expect(allowed.has(key), `opencode emitted an unrecognised field '${key}'`).toBe(true);
    }
  });

  it('keeps Codex to the narrowest documented field set', () => {
    const allowed = new Set(['name', 'description', 'metadata']);
    for (const key of Object.keys(fields(CODEX, skill))) {
      if (key.includes('.')) continue;
      expect(allowed.has(key), `codex emitted an unrecognised field '${key}'`).toBe(true);
    }
  });

  it('gives Claude Code commands the dispatcher fields it alone understands', () => {
    const composed = fields(CLAUDE_CODE, command);
    expect(composed['argument-hint']).toBe('[flow]');
    expect(composed['allowed-tools']).toBe('Bash(vdiff:*), Read, Glob');
    expect(composed['name']).toBeUndefined();
  });

  it('gives opencode commands only a description, plus the stamp', () => {
    const composed = fields(OPENCODE, command);
    expect(composed['description']).toBe('"Capture, diff, report."');
    expect(composed['argument-hint'], 'opencode does not recognise argument-hint').toBeUndefined();
    expect(composed[`metadata.${VERSION_KEY}`]).toBe('"9.9.9"');
  });

  it('emits the stamp as a nested map, not as a scalar', () => {
    const [key, value] = versionStamp('1.2.3');
    expect(key).toBe('metadata');
    expect(typeof value).toBe('object');
    expect(value).toEqual({ [VERSION_KEY]: '"1.2.3"', [SOURCE_KEY]: `"${VDIFF_SOURCE}"` });
  });
});

describe('install-output caveats', () => {
  it('carries a note for every harness', () => {
    for (const id of HARNESS_IDS) {
      const notes = HARNESS_NOTES[id];
      expect(notes.length, id).toBeGreaterThan(0);
      for (const note of notes) expect(note.trim().length, id).toBeGreaterThan(0);
    }
  });

  it('states the real precedence, which is not D16 project-wins, for each harness', () => {
    // D16's stated rationale is false for all three harnesses that document a resolution order.
    expect(HARNESS_NOTES['claude-code'].join(' ')).toContain('~/.claude/skills');
    expect(HARNESS_NOTES['claude-code'].join(' ')).toMatch(/overrides this project one/);
    expect(HARNESS_NOTES.pi.join(' ')).toMatch(/shadows this project one/);
    expect(HARNESS_NOTES.codex.join(' ')).toMatch(/does not hide duplicates/);
    expect(HARNESS_NOTES.opencode.join(' ')).toMatch(/not necessarily an active one/);
  });

  it('records that the global Codex path is documented rather than verified', () => {
    expect(HARNESS_NOTES.codex.join(' ')).toContain('has not been verified against a live Codex');
  });
});

describe('VDIFF_SOURCE', () => {
  it('is the published package name, so a stamp identifies what to reinstall', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      await readFile(resolve(here, '../../package.json'), 'utf8'),
    ) as { name: string };
    expect(VDIFF_SOURCE).toBe(pkg.name);
  });
});

describe('targetPath', () => {
  it('picks the side matching the scope, and null for an absent target', () => {
    const target: Target = { project: 'a', global: 'b' };
    expect(targetPath(target, 'project')).toBe('a');
    expect(targetPath(target, 'global')).toBe('b');
    expect(targetPath(null, 'project' as InstallScope)).toBeNull();
    expect(targetPath({ project: 'a', global: null }, 'global')).toBeNull();
  });
});
