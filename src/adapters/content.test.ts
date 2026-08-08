import { describe, expect, it } from 'vitest';

import { FORBIDDEN_STEP_VERBS, STEP_VERBS } from '../types.js';
import {
  CLI,
  COMMAND_REFERENCE,
  LOOP,
  RULES,
  SKILL_NAME,
  renderCommandReference,
  renderLoop,
  renderLoopOutline,
  renderRules,
  withFrontmatter,
  yamlString,
} from './content.js';

describe('the loop (spec §9)', () => {
  it('is the six stages of the spec, in order', () => {
    expect(LOOP.map((stage) => stage.key)).toEqual([
      'flow',
      'run',
      'diff',
      'summarize',
      'serve',
      'feedback',
    ]);
  });

  it('names the exact command for each stage the spec names one for', () => {
    const commandsFor = (key: string) => LOOP.find((s) => s.key === key)?.commands.join('\n') ?? '';
    expect(commandsFor('flow')).toContain(`${CLI} flow check`);
    expect(commandsFor('run')).toContain(`${CLI} run <flow> --json`);
    expect(commandsFor('run')).toContain('--at <ref>');
    expect(commandsFor('diff')).toContain(`${CLI} diff <flow> --json`);
    expect(commandsFor('serve')).toContain(`${CLI} serve --json`);
    expect(commandsFor('feedback')).toBe(`${CLI} feedback --json --ack`);
  });

  it('leaves the summary stage to the agent rather than to a command', () => {
    expect(LOOP.find((s) => s.key === 'summarize')?.commands).toEqual([]);
  });

  it('gives every stage at least one note', () => {
    for (const stage of LOOP) {
      expect(stage.notes.length, `stage ${stage.key}`).toBeGreaterThan(0);
    }
  });
});

describe('command reference (spec §9)', () => {
  const commands = COMMAND_REFERENCE.map((entry) => entry.command);

  it('covers every command in the spec CLI surface, in spec order', () => {
    expect(commands.map((c) => c.split(' ')[1])).toEqual([
      'install',
      'init',
      'flow',
      'run',
      'runs',
      'diff',
      'serve',
      'feedback',
      'pin|prune',
      'install-browser',
    ]);
  });

  it('renders a markdown table with one row per command', () => {
    const table = renderCommandReference().split('\n');
    expect(table[0]).toBe('| Command | Purpose |');
    expect(table[1]).toBe('|---|---|');
    expect(table).toHaveLength(COMMAND_REFERENCE.length + 2);
  });

  it('escapes the pipes inside a cell so the table does not break', () => {
    const table = renderCommandReference();
    expect(table).toContain('`vdiff pin\\|prune <run>`');
    expect(table).toContain('`vdiff flow new\\|check <name>`');
    for (const row of table.split('\n').slice(2)) {
      // leading, column separator, trailing — and nothing else unescaped
      expect(row.replace(/\\\|/g, '').match(/\|/g), row).toHaveLength(3);
    }
  });
});

describe('rules', () => {
  const all = RULES.join('\n');

  it('states the exit codes from the spec', () => {
    expect(all).toContain('`0` success');
    expect(all).toContain('`1` run or replay failure');
    expect(all).toContain('`2` config or spec error');
  });

  it('states that diff exits 0 with findings present', () => {
    expect(all).toMatch(/diff` exits `0`\s*\n?\s*even when findings exist/);
  });

  it('forbids sleep by name, matching the validator', () => {
    expect(all).toContain('There is no `sleep`');
    expect(FORBIDDEN_STEP_VERBS).toContain('sleep');
  });

  it('protects stable step ids (D4)', () => {
    expect(all).toContain('Never rename a step `id`');
    expect(all).toContain('spec-changed');
  });
});

describe('renderers', () => {
  it('numbers the loop and emits a fenced block only where commands exist', () => {
    const md = renderLoop(3);
    expect(md).toContain('### 1. Ensure a flow exists for the feature under work');
    expect(md).toContain('### 6. Pull the human comments back');
    expect((md.match(/```bash/g) ?? []).length).toBe(
      LOOP.filter((stage) => stage.commands.length > 0).length,
    );
  });

  it('honours the requested heading level', () => {
    expect(renderLoop(2)).toContain('## 1. Ensure a flow exists');
    expect(renderLoop(4)).toContain('#### 1. Ensure a flow exists');
  });

  it('renders the outline as one numbered line per stage', () => {
    const lines = renderLoopOutline().split('\n');
    expect(lines).toHaveLength(LOOP.length);
    expect(lines[0]).toBe(`1. **${LOOP[0]?.title}**`);
  });

  it('renders rules as bullets', () => {
    expect(renderRules().split('\n')).toHaveLength(RULES.length);
    expect(renderRules().startsWith('- ')).toBe(true);
  });
});

describe('frontmatter helpers', () => {
  it('quotes and flattens a description so the YAML stays single-line', () => {
    expect(yamlString('a "quoted"\n  multi line')).toBe('"a \\"quoted\\" multi line"');
  });

  it('escapes backslashes', () => {
    expect(yamlString('back\\slash')).toBe('"back\\\\slash"');
  });

  it('wraps a body in fenced frontmatter', () => {
    const doc = withFrontmatter([['name', SKILL_NAME]], '# body');
    expect(doc).toBe(`---\nname: ${SKILL_NAME}\n---\n\n# body\n`);
  });
});

describe('vocabulary agreement with src/types.ts', () => {
  it('documents exactly the closed step vocabulary', () => {
    const flowStage = LOOP.find((stage) => stage.key === 'flow');
    const notes = flowStage?.notes.join(' ') ?? '';
    for (const verb of STEP_VERBS) {
      expect(notes, `verb ${verb}`).toContain(`\`${verb}\``);
    }
  });
});
