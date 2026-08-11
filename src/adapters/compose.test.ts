import { beforeEach, describe, expect, it } from 'vitest';

import { readBlock } from './blocks.js';
import {
  MAX_DESCRIPTION_LENGTH,
  blockStampLine,
  commandFilePath,
  composeCommandFile,
  composeFiles,
  composeInstructionsFile,
  composeSkillFile,
  harnessTargets,
  instructionsContent,
  sharesSkillsDirectory,
  readBlockStamp,
  readFrontmatterStamp,
  readInstalledVersion,
  skillFilePath,
  validateSkillMeta,
  type ComposeContext,
} from './compose.js';
import { splitFrontmatter } from './frontmatter.js';
import {
  CLAUDE_CODE,
  CODEX,
  HARNESSES,
  OPENCODE,
  PI,
  VDIFF_SOURCE,
  type Harness,
  type InstallScope,
  type SkillMeta,
} from './harnesses.js';
import { loadSkillBundle, type SkillBundle } from './source.js';

let bundle: SkillBundle;

beforeEach(async () => {
  bundle = await loadSkillBundle();
});

function ctx(harness: Harness, scope: InstallScope = 'project'): ComposeContext {
  return { harness, scope, bundle, version: '9.9.9' };
}

function bodyOf(doc: string): string {
  const split = splitFrontmatter(doc);
  if (split === null) throw new Error('composed document has no frontmatter');
  return split.body;
}

/* ------------------------------------------------------------------ validation */

describe('validateSkillMeta', () => {
  const valid: SkillMeta = {
    kind: 'skill',
    id: 'visual-diff',
    name: 'visual-diff',
    description: 'Does a thing.',
  };

  it('accepts the shipped skills unchanged', () => {
    for (const skill of bundle.manifest.skills) {
      expect(() =>
        validateSkillMeta({
          kind: 'skill',
          id: skill.id,
          name: skill.name,
          description: skill.description,
        }),
      ).not.toThrow();
    }
  });

  it('rejects a name that disagrees with the skill directory, naming both', () => {
    expect(() => validateSkillMeta({ ...valid, name: 'Visual Diff' })).toThrow(
      "skill 'visual-diff': frontmatter name 'Visual Diff' must equal the skill directory name " +
        "'visual-diff' — opencode rejects a skill whose name and directory disagree",
    );
  });

  it('rejects a name outside the Agent Skills charset', () => {
    expect(() => validateSkillMeta({ id: 'a_b', name: 'a_b', kind: 'skill', description: 'x' })).toThrow(
      /name 'a_b' must match \^\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*\$ — lowercase letters, digits and single interior hyphens only/,
    );
    for (const bad of ['-lead', 'trail-', 'double--hyphen', 'UPPER']) {
      expect(() =>
        validateSkillMeta({ id: bad, name: bad, kind: 'skill', description: 'x' }),
      ).toThrow(/must match/);
    }
  });

  it('rejects an empty description, because pi drops such a skill silently', () => {
    expect(() => validateSkillMeta({ ...valid, description: '   ' })).toThrow(
      "skill 'visual-diff': description must not be empty — pi silently drops a skill that has none",
    );
  });

  it('rejects a description past the spec cap, naming the actual length', () => {
    const long = 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1);
    expect(() => validateSkillMeta({ ...valid, description: long })).toThrow(
      `skill 'visual-diff': description is ${MAX_DESCRIPTION_LENGTH + 1} characters; the Agent ` +
        `Skills spec caps it at ${MAX_DESCRIPTION_LENGTH}`,
    );
  });

  it('does not require a command id to match anything, since it is a filename stem', () => {
    expect(() =>
      validateSkillMeta({ kind: 'command', id: 'vdiff', name: 'vdiff', description: 'x' }),
    ).not.toThrow();
  });
});

/* ------------------------------------------------------------------ paths */

describe('path construction', () => {
  it('derives every path from the table, not from a hard-coded string', () => {
    expect(skillFilePath(CODEX, 'project', 'anything')).toBe('.agents/skills/anything/SKILL.md');
    expect(skillFilePath(CLAUDE_CODE, 'global', 'anything')).toBe(
      '.claude/skills/anything/SKILL.md',
    );
    expect(commandFilePath(OPENCODE, 'global', 'vdiff')).toBe(
      '.config/opencode/commands/vdiff.md',
    );
  });

  it('refuses to invent a path for a target the harness does not have', () => {
    expect(() => commandFilePath(CODEX, 'project', 'vdiff')).toThrow(
      "Codex has no project commands directory, so there is no path for command 'vdiff'",
    );
    expect(() => commandFilePath(PI, 'global', 'vdiff')).toThrow(
      "pi has no global commands directory, so there is no path for command 'vdiff'",
    );
  });

  it('reports the real directories install output must name (D18)', () => {
    expect(harnessTargets(PI, 'global')).toEqual({
      scope: 'global',
      skills: '.agents/skills',
      commands: null,
      instructions: null,
      // Never a workflow: `.github/workflows` belongs to a CI target, not to an agent (CI spec D34).
      workflows: null,
    });
  });
});

/* ------------------------------------------------------------------ skills */

describe('skill composition', () => {
  it('copies the shipped body verbatim for every harness', () => {
    for (const harness of HARNESSES) {
      for (const source of bundle.skills) {
        const body = bodyOf(composeSkillFile(ctx(harness), source).body);
        expect(body, `${harness.id}/${source.entry.id}`).toContain(source.body.trim());
      }
    }
  });

  it('mentions slash commands in a private skills directory, but never in the shared one', () => {
    const entry = bundle.skills.find((s) => s.entry.id === 'visual-diff');
    if (entry === undefined) throw new Error('visual-diff skill missing from the manifest');

    // `.claude/skills` is Claude Code's alone, so its skill body may name `/vdiff`.
    expect(bodyOf(composeSkillFile(ctx(CLAUDE_CODE), entry).body)).toContain('`/vdiff`');

    // opencode has commands, but writes into `.agents/skills`, which Codex and pi also read — so
    // its commands are named in its AGENTS.md block instead, and the shared file stays shared.
    for (const harness of [CODEX, OPENCODE, PI]) {
      const body = bodyOf(composeSkillFile(ctx(harness), entry).body);
      expect(body, harness.id).not.toContain('/vdiff');
      expect(body, harness.id).not.toContain('Slash commands');
      // Companions are still pointed at — that part is harness-neutral.
      expect(body, harness.id).toContain('`visual-diff-flows`');
    }
  });

  it('writes byte-identical skill files for every harness sharing a skills directory (D18)', () => {
    for (const scope of ['project', 'global'] as InstallScope[]) {
      const shared = HARNESSES.filter((harness) => sharesSkillsDirectory(harness, scope));
      expect(shared.map((harness) => harness.id)).toEqual(['codex', 'opencode', 'pi']);

      const [first, ...rest] = shared;
      if (first === undefined) throw new Error('no harness shares a skills directory');
      const reference = composeFiles(ctx(first, scope)).filter((file) => file.mode !== 'block');
      for (const harness of rest) {
        const other = composeFiles(ctx(harness, scope)).filter((file) => file.mode !== 'block');
        const shareable = other.filter((file) => file.path.startsWith('.agents/skills/'));
        for (const file of shareable) {
          const twin = reference.find((candidate) => candidate.path === file.path);
          expect(twin, `${harness.id}: ${file.path} has no counterpart in ${first.id}`).toBeDefined();
          expect(file.body, `${harness.id} vs ${first.id}: ${file.path}`).toBe(twin?.body);
        }
      }
    }
  });

  it('does not share Claude Code directory, so it keeps its own pointer', () => {
    for (const scope of ['project', 'global'] as InstallScope[]) {
      expect(sharesSkillsDirectory(CLAUDE_CODE, scope), scope).toBe(false);
    }
  });

  it('adds no pointer section to a skill with neither companions nor commands', () => {
    const leaf = bundle.skills.find((s) => s.entry.id === 'visual-diff-flows');
    if (leaf === undefined) throw new Error('visual-diff-flows skill missing from the manifest');
    for (const harness of HARNESSES) {
      const body = bodyOf(composeSkillFile(ctx(harness), leaf).body);
      expect(body.trim(), harness.id).toBe(leaf.body.trim());
    }
  });

  it('puts the skill in a directory whose name equals its frontmatter name', () => {
    for (const harness of HARNESSES) {
      for (const source of bundle.skills) {
        const file = composeSkillFile(ctx(harness), source);
        const parts = file.path.split('/');
        const directory = parts[parts.length - 2];
        const fields = splitFrontmatter(file.body)?.fields ?? {};
        expect(directory, `${harness.id}/${source.entry.id}`).toBe(fields['name']);
      }
    }
  });
});

/* ------------------------------------------------------------------ commands */

describe('command composition', () => {
  it('renders one dispatcher per manifest command, for the harnesses that take them', () => {
    for (const harness of [CLAUDE_CODE, OPENCODE]) {
      for (const command of bundle.manifest.commands) {
        const file = composeCommandFile(ctx(harness), command);
        const body = bodyOf(file.body);
        expect(body, harness.id).toContain(`Load the \`${command.invokes}\` skill`);
        expect(body, harness.id).toContain('$1');
        expect(body, harness.id).toContain('--json');
        expect(body, harness.id).toContain('exits 0');
      }
    }
  });
});

/* ------------------------------------------------------------------ AGENTS.md */

describe('instructions block (D19)', () => {
  it('is composed only for the harnesses with an instructions target', () => {
    expect(composeInstructionsFile(ctx(CLAUDE_CODE))).toBeNull();
    expect(composeInstructionsFile(ctx(PI, 'global'))).toBeNull();

    const codex = composeInstructionsFile(ctx(CODEX));
    expect(codex?.path).toBe('AGENTS.md');
    expect(codex?.mode).toBe('block');
  });

  it('names the real skills directory, so `vdiff install codex` is not baffling (D18)', () => {
    expect(instructionsContent(ctx(CODEX))).toContain('`.agents/skills/`');
    expect(instructionsContent(ctx(OPENCODE, 'global'))).toContain('`.agents/skills/`');
  });

  it('names the install command that wrote it, scope included', () => {
    expect(instructionsContent(ctx(CODEX))).toContain('`vdiff install codex`');
    expect(instructionsContent(ctx(OPENCODE, 'global'))).toContain(
      '`vdiff install opencode --global`',
    );
  });

  it('lists every shipped skill, and the two rules that survive without them', () => {
    const content = instructionsContent(ctx(PI));
    for (const skill of bundle.manifest.skills) expect(content).toContain(`\`${skill.id}\``);
    expect(content).toContain('--json');
    expect(content).toContain('`vdiff diff` exits 0 even when it finds things.');
  });

  it('mentions slash commands only where the harness has them', () => {
    expect(instructionsContent(ctx(OPENCODE))).toContain('.opencode/commands/');
    expect(instructionsContent(ctx(CODEX))).not.toContain('Slash commands');
    expect(instructionsContent(ctx(PI))).not.toContain('Slash commands');
  });

  it('falls back to CLI instructions when a harness has no skill mechanism (D15)', () => {
    // Every shipped harness has skills today; the fallback is data-driven, so it is exercised with
    // a table row rather than a code path — which is exactly how a fifth harness would arrive.
    const skill_less: Harness = {
      ...CODEX,
      id: 'codex',
      label: 'Skill-less Harness',
      skills: null,
    };
    const content = instructionsContent(ctx(skill_less));
    expect(content).toContain('Skill-less Harness has no skill mechanism');
    expect(content).toContain('`vdiff run <flow>`');
    expect(content).not.toContain('Skills are installed in');

    const files = composeFiles(ctx(skill_less));
    expect(files.map((file) => file.path)).toEqual(['AGENTS.md']);
  });

  it('round-trips through the block markers', () => {
    const file = composeInstructionsFile(ctx(CODEX));
    const written = `# user notes\n\n<!-- vdiff:start -->\nold\n<!-- vdiff:end -->\n`;
    const applied = written.replace('old', file?.body ?? '');
    expect(readBlock(applied)?.trim()).toBe(file?.body.trim());
  });
});

/* ------------------------------------------------------------------ version stamp (D17) */

describe('version stamp', () => {
  it('is readable back off a composed skill file', () => {
    for (const harness of HARNESSES) {
      const source = bundle.skills[0];
      if (source === undefined) throw new Error('no skills in the manifest');
      const doc = composeSkillFile(ctx(harness), source).body;
      expect(readFrontmatterStamp(doc), harness.id).toEqual({
        version: '9.9.9',
        source: VDIFF_SOURCE,
      });
      expect(readInstalledVersion(doc), harness.id).toBe('9.9.9');
    }
  });

  it('is readable back off an AGENTS.md block', () => {
    const content = instructionsContent(ctx(CODEX));
    expect(blockStampLine('9.9.9')).toBe(
      `<!-- vdiff:stamp version=9.9.9 source=${VDIFF_SOURCE} -->`,
    );
    expect(readBlockStamp(content)).toEqual({ version: '9.9.9', source: VDIFF_SOURCE });
    expect(readInstalledVersion(content)).toBe('9.9.9');
  });

  it('is null for a file this tool never wrote', () => {
    expect(readFrontmatterStamp('# not ours\n')).toBeNull();
    expect(readFrontmatterStamp('---\nname: x\n---\n\nbody\n')).toBeNull();
    expect(readBlockStamp('# not ours\n')).toBeNull();
    expect(readInstalledVersion('# not ours\n')).toBeNull();
  });

  it('survives a version that YAML would otherwise reinterpret', () => {
    const source = bundle.skills[0];
    if (source === undefined) throw new Error('no skills in the manifest');
    for (const version of ['1.0', '0.2.0', '1.0.0-rc.1']) {
      const doc = composeSkillFile(
        { harness: CODEX, scope: 'project', bundle, version },
        source,
      ).body;
      expect(doc).toContain(`x-vdiff-version: "${version}"`);
      expect(readInstalledVersion(doc)).toBe(version);
    }
  });
});

/* ------------------------------------------------------------------ neutrality (spec §7.5) */

describe('everything harness-specific arrives via frontmatter or the AGENTS.md block', () => {
  /**
   * The shipped bodies stay neutral (see `claude-code/index.test.ts`). This is the other half:
   * whatever a harness needs must be introduced during composition, and the composed skill body
   * must differ from the shipped one *only* by the "## Also installed" pointer.
   */
  it('changes a skill body by nothing but the composed pointer section', () => {
    for (const harness of HARNESSES) {
      for (const source of bundle.skills) {
        const body = bodyOf(composeSkillFile(ctx(harness), source).body).trim();
        const [shipped, ...pointer] = body.split('\n## Also installed\n');
        expect((shipped ?? '').trim(), `${harness.id}/${source.entry.id}`).toBe(
          source.body.trim(),
        );
        expect(pointer.length, `${harness.id}/${source.entry.id}`).toBeLessThanOrEqual(1);
      }
    }
  });

  const HARNESS_SPECIFIC = [
    /\.claude\//,
    /\.codex\//,
    /\.opencode\//,
    /\.agents\//,
    /\bClaude Code\b/,
    /\bCLAUDE\.md\b/,
    /\bAGENTS\.md\b/,
    /\bopencode\b/,
    /\ballowed-tools\b/,
    /\bargument-hint\b/,
  ];

  it('keeps every harness name and config path out of composed skill bodies', () => {
    for (const harness of HARNESSES) {
      for (const source of bundle.skills) {
        const body = bodyOf(composeSkillFile(ctx(harness), source).body);
        for (const pattern of HARNESS_SPECIFIC) {
          expect(pattern.test(body), `${harness.id}/${source.entry.id} leaked ${pattern}`).toBe(
            false,
          );
        }
      }
    }
  });

  it('introduces the harness-specific syntax in the frontmatter and the block, and nowhere else', () => {
    const files = composeFiles(ctx(CLAUDE_CODE));
    const composed = files.map((file) => file.body).join('\n');
    expect(composed).toContain('allowed-tools');
    expect(composed).toContain('/vdiff');

    // …and the directory names live only in the AGENTS.md block.
    const codex = composeFiles(ctx(CODEX));
    const block = codex.find((file) => file.mode === 'block');
    const skills = codex.filter((file) => file.mode !== 'block');
    expect(block?.body).toContain('.agents/skills');
    for (const file of skills) expect(file.body, file.path).not.toContain('.agents/skills');
  });
});
