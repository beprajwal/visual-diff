import { describe, expect, it } from 'vitest';
import { envReferences, flowEnvReferences, interpolateEnv, resolveFlowEnv } from './env-template.js';

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
