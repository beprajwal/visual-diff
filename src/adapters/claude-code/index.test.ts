import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderManaged } from '../files.js';
import { splitFrontmatter } from '../frontmatter.js';
import { loadSkillBundle, type SkillBundle } from '../source.js';
import {
  CLAUDE_CODE_DIRS,
  CLAUDE_CODE_ID,
  CLAUDE_CODE_LABEL,
  claudeCodeAdapter,
  claudeCodeFiles,
  commandPath,
  composeCommand,
  composeSkill,
  installClaudeCode,
  skillPath,
} from './index.js';

let bundle: SkillBundle;

/** Every path this adapter writes, in install order. */
const EXPECTED_PATHS = [
  '.claude/skills/visual-diff/SKILL.md',
  '.claude/skills/visual-diff-flows/SKILL.md',
  '.claude/skills/visual-diff-review/SKILL.md',
  '.claude/commands/vdiff.md',
  '.claude/commands/vdiff-review.md',
];

function frontmatter(doc: string): Record<string, string> {
  const split = splitFrontmatter(doc);
  if (split === null) throw new Error('document has no frontmatter');
  return split.fields;
}

function bodyOf(doc: string): string {
  const split = splitFrontmatter(doc);
  if (split === null) throw new Error('document has no frontmatter');
  return split.body;
}

beforeEach(async () => {
  bundle = await loadSkillBundle();
});

describe('paths (spec §9)', () => {
  it('writes three skills and two commands, all under .claude/', async () => {
    const files = await claudeCodeFiles(bundle);
    expect(files.map((file) => file.path)).toEqual(EXPECTED_PATHS);
    for (const file of files) expect(file.path.startsWith('.claude/')).toBe(true);
  });

  it('derives its paths from the harness directories, not from hard-coded strings', () => {
    expect(skillPath('anything')).toBe(`${CLAUDE_CODE_DIRS.skills}/anything/SKILL.md`);
    expect(commandPath('anything')).toBe(`${CLAUDE_CODE_DIRS.commands}/anything.md`);
  });

  it('names one skill directory per manifest skill id', async () => {
    const files = await claudeCodeFiles(bundle);
    for (const skill of bundle.manifest.skills) {
      expect(files.map((f) => f.path)).toContain(skillPath(skill.id));
    }
  });
});

describe('skill composition', () => {
  it('carries name and description frontmatter straight from the manifest', async () => {
    for (const source of bundle.skills) {
      const file = composeSkill(source, bundle);
      const fields = frontmatter(file.body);
      expect(fields.name, source.entry.id).toBe(source.entry.name);
      expect(fields.description, source.entry.id).toBe(
        `"${source.entry.description.replace(/"/g, '\\"')}"`,
      );
      expect(fields.description, source.entry.id).not.toContain('\n');
    }
  });

  it('copies the shipped markdown verbatim rather than regenerating it', async () => {
    for (const source of bundle.skills) {
      const body = bodyOf(composeSkill(source, bundle).body);
      expect(body, source.entry.id).toContain(source.body.trim());
    }
  });

  it('points the entry skill at its companions and its slash commands', () => {
    const entry = bundle.skills.find((s) => s.entry.id === 'visual-diff');
    if (entry === undefined) throw new Error('visual-diff skill missing from the manifest');
    const body = bodyOf(composeSkill(entry, bundle).body);

    expect(body).toContain('`visual-diff-flows`');
    expect(body).toContain('`visual-diff-review`');
    expect(body).toContain('`/vdiff`');
  });

  it('adds no companion section to a skill that declares none', () => {
    const leaf = bundle.skills.find((s) => s.entry.id === 'visual-diff-flows');
    if (leaf === undefined) throw new Error('visual-diff-flows skill missing from the manifest');
    const body = bodyOf(composeSkill(leaf, bundle).body);
    expect(body).not.toContain('## Also installed');
    expect(body.trim()).toBe(leaf.body.trim());
  });

  it('quotes a description containing YAML-hostile characters', () => {
    const hostile: SkillBundle = {
      dir: bundle.dir,
      manifest: { skills: [], commands: [] },
      skills: [],
    };
    const file = composeSkill(
      {
        entry: {
          id: 'x',
          name: 'x',
          description: 'Use when: a "quoted" thing\nspans lines',
          entry: 'SKILL.md',
        },
        body: '# x',
      },
      hostile,
    );
    const fields = frontmatter(file.body);
    expect(fields.description).toBe('"Use when: a \\"quoted\\" thing spans lines"');
  });
});

describe('command composition', () => {
  it('renders one dispatcher per manifest command', async () => {
    for (const command of bundle.manifest.commands) {
      const file = composeCommand(command);
      expect(file.path).toBe(`.claude/commands/${command.id}.md`);

      const fields = frontmatter(file.body);
      expect(fields.description).toContain(command.description.slice(0, 20));
      expect(fields['argument-hint']).toBe('[flow]');
      expect(fields['allowed-tools']).toContain('Bash(vdiff:*)');

      const body = bodyOf(file.body);
      expect(body).toContain(`Load the \`${command.invokes}\` skill`);
      expect(body).toContain('$1');
    }
  });

  it('restates only the two rules that survive without the skill', () => {
    const command = bundle.manifest.commands[0];
    if (command === undefined) throw new Error('no commands in the manifest');
    const body = bodyOf(composeCommand(command).body);
    expect(body).toContain('--json');
    expect(body).toContain('exits 0');
  });
});

describe('neutrality of the shipped bodies', () => {
  /**
   * The SKILL.md files must stay harness-agnostic: everything Claude-Code-specific is composed at
   * install time. Without this guard the separation rots silently, and the Codex/opencode/pi
   * adapters stop being near-copies of one small file.
   */
  const FORBIDDEN: Array<[label: string, pattern: RegExp]> = [
    ['YAML frontmatter', /^---\n/],
    ['a slash command', /(^|\s)\/vdiff(-review)?\b/],
    ['an argument placeholder', /\$1|\$ARGUMENTS/],
    ['a frontmatter key', /\b(allowed-tools|argument-hint)\b/],
    ['a harness config path', /\.claude\/|\.codex\/|\.opencode\//],
    ['a harness name', /\bClaude Code\b|\bCLAUDE\.md\b|\bopencode\b/i],
    ['a tool name', /\bBash\(|\bTodoWrite\b|\bWebFetch\b/],
  ];

  it('keeps every shipped SKILL.md free of harness-specific syntax', async () => {
    const loaded = await loadSkillBundle();
    for (const skill of loaded.skills) {
      for (const [label, pattern] of FORBIDDEN) {
        expect(pattern.test(skill.body), `${skill.entry.id} must not contain ${label}`).toBe(false);
      }
    }
  });

  it('keeps the manifest descriptions neutral too', async () => {
    const loaded = await loadSkillBundle();
    const text = [
      ...loaded.manifest.skills.map((s) => s.description),
      ...loaded.manifest.commands.map((c) => c.description),
    ].join('\n');
    expect(/\.claude\/|allowed-tools|Claude Code/.test(text)).toBe(false);
  });

  it('is the composition, not the source, that introduces the harness syntax', async () => {
    const files = await claudeCodeFiles(bundle);
    const composed = files.map((file) => file.body).join('\n');
    expect(composed.startsWith('---\n')).toBe(true);
    expect(composed).toContain('allowed-tools');
    expect(composed).toContain('/vdiff');
  });
});

describe('adapter', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vdiff-claude-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('identifies itself', () => {
    expect(claudeCodeAdapter.id).toBe(CLAUDE_CODE_ID);
    expect(claudeCodeAdapter.id).toBe('claude-code');
    expect(claudeCodeAdapter.label).toBe(CLAUDE_CODE_LABEL);
  });

  it('writes exactly the expected paths', async () => {
    const result = await installClaudeCode(root);
    expect(result.id).toBe('claude-code');
    expect(result.written).toEqual(EXPECTED_PATHS);
    expect(result.skipped).toEqual([]);

    expect(await readdir(join(root, '.claude'))).toEqual(
      expect.arrayContaining(['commands', 'skills']),
    );
    expect(await readdir(join(root, '.claude/skills'))).toEqual(
      expect.arrayContaining(['visual-diff', 'visual-diff-flows', 'visual-diff-review']),
    );

    const files = await claudeCodeFiles(bundle);
    const skill = files.find((f) => f.path === EXPECTED_PATHS[0]);
    expect(await readFile(join(root, EXPECTED_PATHS[0] as string), 'utf8')).toBe(
      renderManaged(skill?.body ?? ''),
    );
  });

  it('creates nothing outside .claude/', async () => {
    await installClaudeCode(root);
    expect(await readdir(root)).toEqual(['.claude']);
  });

  it('is idempotent', async () => {
    await installClaudeCode(root);
    const second = await installClaudeCode(root);
    expect(second.written).toEqual([]);
    expect(second.skipped).toEqual(EXPECTED_PATHS);
  });

  it('never overwrites a user edit, and reports the skip', async () => {
    await installClaudeCode(root);
    const relative = '.claude/commands/vdiff.md';
    const path = join(root, relative);
    const edited = '---\ndescription: mine\n---\n\nmy own command\n';
    await writeFile(path, edited, 'utf8');

    const result = await installClaudeCode(root);

    expect(result.written).toEqual([]);
    expect(result.skipped).toContain(relative);
    expect(result.files).toContainEqual({ path: relative, status: 'preserved' });
    expect(await readFile(path, 'utf8')).toBe(edited);
  });

  it('restores its own file after the tool ships new content', async () => {
    await installClaudeCode(root);
    const relative = EXPECTED_PATHS[0] as string;
    const path = join(root, relative);
    await writeFile(path, renderManaged('# an older shipped skill\n'), 'utf8');

    const result = await installClaudeCode(root);

    expect(result.written).toContain(relative);
    expect(await readFile(path, 'utf8')).toContain('Verify UI you just built');
  });

  it('goes through the shared Adapter contract', async () => {
    const result = await claudeCodeAdapter.install(root);
    expect(result.written).toHaveLength(EXPECTED_PATHS.length);
  });

  it('describes its files without touching a project directory', async () => {
    const files = await claudeCodeAdapter.files();
    expect(files.map((f) => f.path)).toEqual(EXPECTED_PATHS);
    expect(await readdir(root)).toEqual([]);
  });
});
