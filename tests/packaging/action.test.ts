/**
 * The composite action and the workflows that call it (CI spec §10, D34).
 *
 * D34 trades one failure mode for another: writing thin workflows and keeping the pipeline in
 * `action.yml` means a fix reaches every repository on the next tag, but it also means the file a
 * user has on disk and the action it calls can disagree — a workflow passing `fail-on:` to an action
 * that renamed the input fails at the runner, in someone else's repository, with a message about a
 * key nobody recognises.
 *
 * That is exactly the kind of thing a review misses and a test does not, so this parses both and
 * asserts they agree: every input a written workflow passes is an input the action declares, the
 * version the workflow pins is the version this build is, and the steps that need a token are the
 * only ones that take one.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it, beforeAll } from 'vitest';

import {
  ACTION_REF,
  BASELINE_WORKFLOW_PATH,
  PR_WORKFLOW_PATH,
  baselineWorkflow,
  prWorkflow,
} from '../../src/adapters/github-actions/index.js';
import { TOOL_VERSION } from '../../src/version.js';

interface ActionYaml {
  name: string;
  description: string;
  inputs: Record<string, { description: string; required?: boolean; default?: string }>;
  outputs: Record<string, { description: string; value: string }>;
  runs: {
    using: string;
    steps: Array<{
      name?: string;
      id?: string;
      uses?: string;
      shell?: string;
      run?: string;
      if?: string;
      with?: Record<string, string>;
      env?: Record<string, string>;
    }>;
  };
}

interface WorkflowYaml {
  name: string;
  on: unknown;
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    { steps: Array<{ uses?: string; with?: Record<string, string> }>; 'runs-on': string }
  >;
}

const actionPath = fileURLToPath(new URL('../../action.yml', import.meta.url));

let action: ActionYaml;

beforeAll(async () => {
  action = parseYaml(await readFile(actionPath, 'utf8')) as ActionYaml;
});

/** Every `with:` key any written workflow passes to the action. */
function passedInputs(source: string): string[] {
  const parsed = parseYaml(source) as WorkflowYaml;
  const keys: string[] = [];
  for (const job of Object.values(parsed.jobs)) {
    for (const step of job.steps) {
      if (step.uses?.startsWith(ACTION_REF) !== true) continue;
      keys.push(...Object.keys(step.with ?? {}));
    }
  }
  return keys;
}

describe('action.yml', () => {
  it('is a composite action with a description', () => {
    expect(action.runs.using).toBe('composite');
    expect(action.name).toBe('visual-diff');
    expect(action.description.length).toBeGreaterThan(20);
  });

  it('declares every input the spec documents', () => {
    // The table in CI spec §8. A renamed input is a breaking change for every installed workflow, so
    // the set is pinned rather than merely non-empty.
    expect(Object.keys(action.inputs).sort()).toEqual(
      [
        'artifact',
        'artifact-name',
        'base-ref',
        'baseline',
        'cli',
        'comment',
        'fail-on',
        'flows',
        'github-token',
        'images',
        'install',
        'mode',
        'node-version',
        'publish-branch',
        'version',
        'working-directory',
      ].sort(),
    );
  });

  it('defaults the gate to none and the baseline to auto (D30, D32)', () => {
    expect(action.inputs['fail-on']?.default).toBe('none');
    expect(action.inputs['baseline']?.default).toBe('auto');
    expect(action.inputs['mode']?.default).toBe('pr');
    // No publish branch by default: pushing images into someone's repository is opt-in (D31).
    expect(action.inputs['publish-branch']?.default).toBe('');
  });

  it('installs the version of the package this build is', () => {
    expect(action.inputs['version']?.default).toBe(TOOL_VERSION);
  });

  it('reports the numbers a caller would gate or badge on', () => {
    expect(Object.keys(action.outputs).sort()).toEqual(
      ['artifact-url', 'bundle-dir', 'changed-steps', 'comment-file', 'findings', 'gate', 'high'].sort(),
    );
  });

  it('takes the token in exactly the two steps that talk to GitHub (D29)', () => {
    const withToken = action.runs.steps.filter((step) => {
      // A `with:`/`env:` value can be a boolean or a number in YAML, so stringify before matching.
      const values = [...Object.values(step.with ?? {}), ...Object.values(step.env ?? {})];
      return values.some((value) => String(value).includes('inputs.github-token'));
    });
    expect(withToken.map((step) => step.name ?? step.uses)).toEqual([
      'Publish diff images',
      'Post the comment',
    ]);
  });

  it('posts the comment before it enforces the gate (D35)', () => {
    const names = action.runs.steps.map((step) => step.name ?? step.uses ?? '');
    const upload = names.indexOf('Upload the evidence bundle');
    const render = names.indexOf('Render the comment');
    const post = names.indexOf('Post the comment');
    const gate = names.indexOf('Enforce the gate');
    expect(upload).toBeGreaterThan(-1);
    // The artifact is uploaded before the body is rendered, because the body links it (D33).
    expect(upload).toBeLessThan(render);
    expect(render).toBeLessThan(post);
    expect(post).toBeLessThan(gate);
    expect(gate).toBe(names.length - 1);
  });

  it('never asks vdiff to post anything itself (D29)', () => {
    const shellSteps = action.runs.steps.filter((step) => typeof step.run === 'string');
    for (const step of shellSteps) {
      expect(step.run, step.name).not.toMatch(/vdiff[^\n]*--post/);
      // The CLI holds no credential: no shell step may hand it one.
      expect(step.env?.['GITHUB_TOKEN'], step.name).toBeUndefined();
    }
  });

  it('invokes the CLI through the `cli` input, never as a bare command', () => {
    // Every CLI call has to honour `cli`, or dogfooding this action against a locally packed tarball
    // silently tests the published version instead — which is the one thing a dogfood run cannot do.
    for (const step of action.runs.steps) {
      if (typeof step.run !== 'string') continue;

      // No line may start a command with a bare `vdiff` — `${CLI:-vdiff}` is the only legal form.
      // Prose mentioning the binary inside a comment or an echoed message is not a call.
      for (const call of step.run.matchAll(/^\s*(?!#)(\S*)vdiff\s+\S/gm)) {
        expect(call[1], `${step.name ?? ''}: ${call[0].trim()}`).toMatch(/CLI:-$/);
      }

      // A step that calls the CLI at all has to receive the input to call it with.
      if (/(\$cli|\$\{CLI:-vdiff\})\s/.test(step.run)) {
        expect(step.env?.['CLI'], step.name).toBe('${{ inputs.cli }}');
      }
    }
  });

  it('pins every third-party action it uses to a major version', () => {
    const used = action.runs.steps.map((step) => step.uses).filter((uses): uses is string => !!uses);
    expect(used.length).toBeGreaterThan(0);
    for (const uses of used) expect(uses, uses).toMatch(/@v\d+$/);
  });
});

describe("this repository's own workflows", () => {
  /**
   * The dogfood workflow is a caller like any other, and it drifts the same way: it pins inputs by
   * name, and it is dispatched by hand rarely enough that a renamed input could sit broken for
   * months. Same assertion as for the installed workflows, against the file in this repository.
   */
  it('pass only inputs the action declares', async () => {
    const path = fileURLToPath(new URL('../../.github/workflows/dogfood-action.yml', import.meta.url));
    const source = await readFile(path, 'utf8');
    const parsed = parseYaml(source) as WorkflowYaml;
    const declared = Object.keys(action.inputs);

    const localCalls: Array<Record<string, string>> = [];
    for (const job of Object.values(parsed.jobs)) {
      for (const step of job.steps) {
        // `uses: ./` is the local action — the whole point of the workflow.
        if (step.uses !== './') continue;
        localCalls.push(step.with ?? {});
      }
    }

    expect(localCalls.length, 'the dogfood workflow must call the local action').toBeGreaterThan(0);
    for (const call of localCalls) {
      for (const key of Object.keys(call)) {
        expect(declared, `dogfood workflow passes an undeclared input: ${key}`).toContain(key);
      }
      // It has to run the packed build rather than the published release, or a green run proves
      // nothing about the branch it ran on.
      expect(call['cli']).toBe('vdiff');
    }
  });

  it('exercises both modes, and the cache restore on an empty runs directory', async () => {
    const path = fileURLToPath(new URL('../../.github/workflows/dogfood-action.yml', import.meta.url));
    const source = await readFile(path, 'utf8');
    const parsed = parseYaml(source) as WorkflowYaml;
    const calls = Object.values(parsed.jobs).flatMap((job) =>
      job.steps.filter((step) => step.uses === './').map((step) => step.with ?? {}),
    );

    expect(calls.map((call) => call['mode'])).toEqual(['baseline', 'pr']);
    // `baseline: cache` is what makes the cache key the thing under test: a save/restore mismatch
    // fails the job instead of silently falling back to replaying the base revision.
    expect(calls[1]?.['baseline']).toBe('cache');
    expect(source).toContain('rm -rf "$FIXTURE/.visual-diff/runs"');
  });
});

describe('the workflows vdiff install github-actions writes', () => {
  const composed = { version: TOOL_VERSION };

  it('parse as workflows with a job', () => {
    for (const [path, source] of [
      [PR_WORKFLOW_PATH, prWorkflow(composed)],
      [BASELINE_WORKFLOW_PATH, baselineWorkflow(composed)],
    ] as const) {
      const parsed = parseYaml(source) as WorkflowYaml;
      expect(Object.keys(parsed.jobs), path).toHaveLength(1);
      expect(parsed.on, path).toBeDefined();
    }
  });

  it('pass only inputs the action declares — the drift D34 trades for', () => {
    const declared = Object.keys(action.inputs);
    for (const source of [prWorkflow(composed), baselineWorkflow(composed)]) {
      for (const key of passedInputs(source)) {
        expect(declared, `workflow passes an input the action does not declare: ${key}`).toContain(
          key,
        );
      }
    }
  });

  it('pin the action to this build, so a run is reproducible', () => {
    for (const source of [prWorkflow(composed), baselineWorkflow(composed)]) {
      expect(source).toContain(`uses: ${ACTION_REF}@v${TOOL_VERSION}`);
    }
  });

  it('mention every input they comment out, so a user can discover one without opening the action', () => {
    const source = prWorkflow(composed);
    const declared = Object.keys(action.inputs);
    // Commented-out suggestions are how the file documents itself; a suggestion for an input that
    // does not exist is worse than no suggestion.
    const suggested = [...source.matchAll(/^\s*#\s*([a-z][a-z-]*):/gm)].map((match) => match[1]);
    for (const key of suggested) {
      if (key === undefined) continue;
      expect(declared, `commented-out input does not exist: ${key}`).toContain(key);
    }
  });

  it('request pull-requests: write only in the workflow that comments', () => {
    const pr = parseYaml(prWorkflow(composed)) as WorkflowYaml;
    const baseline = parseYaml(baselineWorkflow(composed)) as WorkflowYaml;
    expect(pr.permissions?.['pull-requests']).toBe('write');
    expect(baseline.permissions).toEqual({ contents: 'read' });
  });
});
