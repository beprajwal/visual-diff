import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLI, LOOP, SKILL_NAME } from '../content.js';
import { renderManaged } from '../files.js';
import {
  CLAUDE_CODE_ID,
  CLAUDE_CODE_LABEL,
  CLAUDE_CODE_PATHS,
  claudeCodeAdapter,
  claudeCodeFiles,
  installClaudeCode,
} from './index.js';
import { reviewCommandDoc, runCommandDoc, skillDoc } from './templates.js';

/** Minimal frontmatter reader — enough to assert the harness will accept these files. */
function frontmatter(doc: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(doc);
  if (!match) throw new Error('document has no frontmatter');
  const fields: Record<string, string> = {};
  for (const line of (match[1] as string).split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fields;
}

describe('paths (spec §9)', () => {
  it('writes one skill and two commands, all under .claude/', () => {
    expect(Object.values(CLAUDE_CODE_PATHS)).toEqual([
      `.claude/skills/${SKILL_NAME}/SKILL.md`,
      '.claude/commands/vdiff.md',
      '.claude/commands/vdiff-review.md',
    ]);
    for (const path of Object.values(CLAUDE_CODE_PATHS)) {
      expect(path.startsWith('.claude/')).toBe(true);
    }
  });

  it('exposes the same three files it installs', () => {
    expect(claudeCodeFiles().map((file) => file.path)).toEqual(Object.values(CLAUDE_CODE_PATHS));
  });
});

describe('skill document', () => {
  const doc = skillDoc();

  it('carries name and description frontmatter', () => {
    const fields = frontmatter(doc);
    expect(fields.name).toBe(SKILL_NAME);
    expect(fields.description?.startsWith('"')).toBe(true);
    expect(fields.description).toContain('Use when');
    expect(fields.description).not.toContain('\n');
  });

  it('documents every stage of the loop with its command', () => {
    for (const stage of LOOP) {
      expect(doc, `stage ${stage.key}`).toContain(stage.title);
      for (const command of stage.commands) {
        expect(doc, `command ${command}`).toContain(command);
      }
    }
  });

  it('names the four commands the spec calls out for the loop', () => {
    expect(doc).toContain(`${CLI} run <flow> --json`);
    expect(doc).toContain(`${CLI} diff <flow> --json`);
    expect(doc).toContain(`${CLI} serve --json`);
    expect(doc).toContain(`${CLI} feedback --json --ack`);
  });

  it('puts prose ownership on the agent (spec §8)', () => {
    expect(doc).toContain('structured findings only');
    expect(doc).toMatch(/no API key, no model/);
  });

  it('shows the findings shape so the agent never guesses it', () => {
    expect(doc).toContain('"flowDiff"');
    expect(doc).toContain('"spec-changed"');
    expect(doc).toContain('"pixelChangedRatio"');
    expect(doc).toContain("selector '#pay' -> '[data-test=pay]'");
  });

  it('lists the finding kinds and severities from the spec', () => {
    for (const kind of ['content', 'style', 'layout', 'structural', 'a11y', 'console', 'network']) {
      expect(doc, `kind ${kind}`).toContain(`\`${kind}\``);
    }
    expect(doc).toContain('`high`, `med`, or `low`');
  });

  it('describes the partial-run behaviour rather than inventing a retry', () => {
    expect(doc).toContain('`partial`');
    expect(doc).toContain('`blocked`');
    expect(doc).toContain('--continue-on-error');
  });

  it('contains no instruction to run anything from the report page (D6)', () => {
    expect(doc).toContain('The page executes nothing');
  });

  it('never suggests a sleep', () => {
    expect(doc.toLowerCase()).not.toContain('sleep <');
    expect(doc).toContain('There is no `sleep`');
  });
});

describe('slash commands', () => {
  it('/vdiff drives capture through hand-off', () => {
    const doc = runCommandDoc();
    const fields = frontmatter(doc);
    expect(fields['argument-hint']).toBe('[flow]');
    expect(fields['allowed-tools']).toContain(`Bash(${CLI}:*)`);
    expect(doc).toContain(`${CLI} flow check $1 --json`);
    expect(doc).toContain(`${CLI} run $1 --json`);
    expect(doc).toContain(`${CLI} diff $1 --json`);
    expect(doc).toContain(`${CLI} serve --json`);
    expect(doc).toContain(`\`${SKILL_NAME}\` skill`);
  });

  it('/vdiff-review serves the report and acks the feedback', () => {
    const doc = reviewCommandDoc();
    const fields = frontmatter(doc);
    expect(fields.description).toContain('review comments');
    expect(doc).toContain(`${CLI} serve --json`);
    expect(doc).toContain(`${CLI} feedback --json --ack`);
    expect(doc).toContain('crop');
    expect(doc).toContain('do not invent review comments');
  });

  it('both commands defer to the skill instead of restating the rules', () => {
    for (const doc of [runCommandDoc(), reviewCommandDoc()]) {
      expect(doc).toContain(`Follow the \`${SKILL_NAME}\` skill`);
    }
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
    expect(result.written).toEqual(Object.values(CLAUDE_CODE_PATHS));
    expect(result.skipped).toEqual([]);

    expect(await readdir(join(root, '.claude'))).toEqual(expect.arrayContaining(['commands', 'skills']));
    expect(await readFile(join(root, CLAUDE_CODE_PATHS.skill), 'utf8')).toBe(renderManaged(skillDoc()));
  });

  it('creates nothing outside .claude/', async () => {
    await installClaudeCode(root);
    expect(await readdir(root)).toEqual(['.claude']);
  });

  it('is idempotent', async () => {
    await installClaudeCode(root);
    const second = await installClaudeCode(root);
    expect(second.written).toEqual([]);
    expect(second.skipped).toEqual(Object.values(CLAUDE_CODE_PATHS));
  });

  it('never overwrites a user edit, and reports the skip', async () => {
    await installClaudeCode(root);
    const path = join(root, CLAUDE_CODE_PATHS.runCommand);
    const edited = '---\ndescription: mine\n---\n\nmy own command\n';
    await writeFile(path, edited, 'utf8');

    const result = await installClaudeCode(root);

    expect(result.written).toEqual([]);
    expect(result.skipped).toContain(CLAUDE_CODE_PATHS.runCommand);
    expect(result.files).toContainEqual({ path: CLAUDE_CODE_PATHS.runCommand, status: 'preserved' });
    expect(await readFile(path, 'utf8')).toBe(edited);
  });

  it('restores its own file after the tool ships new content', async () => {
    await installClaudeCode(root);
    const path = join(root, CLAUDE_CODE_PATHS.skill);
    await writeFile(path, renderManaged('# an older shipped skill\n'), 'utf8');

    const result = await installClaudeCode(root);

    expect(result.written).toContain(CLAUDE_CODE_PATHS.skill);
    expect(await readFile(path, 'utf8')).toBe(renderManaged(skillDoc()));
  });

  it('goes through the shared Adapter contract', async () => {
    const result = await claudeCodeAdapter.install(root);
    expect(result.written).toHaveLength(3);
  });
});
