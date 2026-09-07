import { describe, expect, it } from 'vitest';
import {
  envReferenceDetails,
  envReferences,
  flowEnvReferences,
  interpolateEnv,
  resolveFlowEnv,
} from './env-template.js';

const flow = {
  steps: [
    { id: 'login', fill: { '[name=email]': '${VDIFF_EMAIL}', '[name=password]': '${VDIFF_PASSWORD}' } },
    { id: 'search', fill: { '[name=q]': 'plain text with a $ sign and ${VDIFF_EMAIL} again' } },
  ],
} as never;

describe('envReferences', () => {
  it('finds uppercase ${NAME} references once each, in order', () => {
    expect(envReferences('${A} then ${B_2} then ${A}')).toEqual(['A', 'B_2']);
  });

  it('treats anything else with a dollar in it as literal text', () => {
    expect(envReferences('$HOME ${lower} ${1BAD} ${} $ {X}')).toEqual([]);
  });
});

describe('flowEnvReferences', () => {
  it('collects the references of every fill value across steps', () => {
    expect(flowEnvReferences(flow)).toEqual(['VDIFF_EMAIL', 'VDIFF_PASSWORD']);
  });
});

describe('resolveFlowEnv', () => {
  it('separates resolved values from missing names', () => {
    const resolution = resolveFlowEnv(flow, { VDIFF_EMAIL: 'me@example.com' });
    expect(resolution.values).toEqual(['me@example.com']);
    expect(resolution.missing).toEqual(['VDIFF_PASSWORD']);
  });
});

describe('interpolateEnv', () => {
  it('substitutes every reference and leaves literal dollars alone', () => {
    expect(interpolateEnv('$5 for ${WHO}, ${WHO}!', { WHO: 'you' })).toBe('$5 for you, you!');
  });

  it('names the unset variable', () => {
    expect(() => interpolateEnv('${MISSING}', {})).toThrow('environment variable MISSING is not set');
  });
});

describe('defaults and goto references (D44)', () => {
  const portable = {
    steps: [
      { id: 'open', goto: '/projects/${VDIFF_PROJECT:-proj-local}/orders' },
      { id: 'thread', goto: '/projects/${VDIFF_PROJECT:-9b9f9847-local}/agent?thread=${VDIFF_THREAD}' },
      { id: 'login', fill: { '[name=email]': '${VDIFF_EMAIL:-dev@example.com}' } },
    ],
  } as never;

  it('parses a shell-style default and keeps the bare form', () => {
    expect(envReferenceDetails('${A:-x} ${B} ${C:-}')).toEqual([
      { name: 'A', default: 'x' },
      { name: 'B' },
      { name: 'C', default: '' },
    ]);
    expect(envReferences('${A:-x} ${B} ${A}')).toEqual(['A', 'B']);
  });

  it('collects goto references after fill ones', () => {
    expect(flowEnvReferences(portable)).toEqual(['VDIFF_EMAIL', 'VDIFF_PROJECT', 'VDIFF_THREAD']);
  });

  it('reports as missing only the references with neither a value nor a default', () => {
    expect(resolveFlowEnv(portable, {})).toEqual({ values: [], missing: ['VDIFF_THREAD'] });
    expect(resolveFlowEnv(portable, { VDIFF_THREAD: 't1' }).missing).toEqual([]);
  });

  it('hands the scrubber only what the environment supplied for fill values, never a default or a goto', () => {
    const resolution = resolveFlowEnv(portable, {
      VDIFF_EMAIL: 'me@example.com',
      VDIFF_PROJECT: 'proj-ci',
      VDIFF_THREAD: 't1',
    });
    expect(resolution.values).toEqual(['me@example.com']);
    expect(resolveFlowEnv(portable, { VDIFF_THREAD: 't1' }).values).toEqual([]);
  });

  it('interpolates the environment first, the default second, and still names a bare unset one', () => {
    expect(interpolateEnv('/p/${VDIFF_PROJECT:-local}/x', {})).toBe('/p/local/x');
    expect(interpolateEnv('/p/${VDIFF_PROJECT:-local}/x', { VDIFF_PROJECT: 'ci' })).toBe('/p/ci/x');
    expect(() => interpolateEnv('/p/${VDIFF_PROJECT}/x', {})).toThrow('VDIFF_PROJECT is not set');
  });
});

describe('empty variables (D44)', () => {
  it('treats an empty variable like an unset one when a default exists, as the shell does', () => {
    expect(interpolateEnv('/p/${VDIFF_PROJECT:-local}/x', { VDIFF_PROJECT: '' })).toBe('/p/local/x');
    // Bare form: set-but-empty is a value, exactly as in the shell.
    expect(interpolateEnv('a${X}b', { X: '' })).toBe('ab');
  });
});
