/**
 * `vdiff run` CI overrides (CI spec D41): the flag wins, the environment is the fallback, and
 * nothing is sent when neither says anything — so a local run keeps meaning what the file says.
 */

import { describe, expect, it } from 'vitest';

import type { RunOptions } from '../../types.js';
import type { CommandContext } from '../command.js';
import { createTestPorts } from '../testing.js';
import { run } from './run.js';

function harness(env: Record<string, string | undefined>): {
  ctx: CommandContext;
  calls: RunOptions[];
} {
  const calls: RunOptions[] = [];
  const ports = createTestPorts();
  const runFlow = ports.runFlow;
  ports.runFlow = async (options) => {
    calls.push(options);
    return runFlow(options);
  };
  return {
    ctx: {
      cwd: '/project',
      env,
      ports,
      version: '0.10.0',
      spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
      waitForShutdown: async () => undefined,
    },
    calls,
  };
}

const invocation = {
  kind: 'run' as const,
  flow: 'checkout',
  keep: false,
  continueOnError: false,
  noScrub: false,
  json: false,
};

describe('vdiff run — CI overrides', () => {
  it('sends nothing when neither flag nor environment names an override', async () => {
    const h = harness({});
    await run(h.ctx, invocation);
    const options = h.calls[0]!;
    expect('baseUrl' in options).toBe(false);
    expect('readyOn' in options).toBe(false);
    expect('ignoreHTTPSErrors' in options).toBe(false);
  });

  it('reads VDIFF_BASE_URL, VDIFF_READY_ON and VDIFF_IGNORE_HTTPS_ERRORS from the environment', async () => {
    const h = harness({
      VDIFF_BASE_URL: 'https://e2e.dev.example.test/core',
      VDIFF_READY_ON: 'https://e2e.dev.example.test/core/403',
      VDIFF_IGNORE_HTTPS_ERRORS: 'true',
    });
    await run(h.ctx, invocation);
    expect(h.calls[0]).toMatchObject({
      baseUrl: 'https://e2e.dev.example.test/core',
      readyOn: 'https://e2e.dev.example.test/core/403',
      ignoreHTTPSErrors: true,
    });
  });

  it('treats an empty variable as unset and a flag as final', async () => {
    const h = harness({ VDIFF_BASE_URL: '  ', VDIFF_READY_ON: 'http://env.test/', VDIFF_IGNORE_HTTPS_ERRORS: '0' });
    await run(h.ctx, { ...invocation, readyOn: 'http://flag.test/', ignoreHttpsErrors: true });
    const options = h.calls[0]!;
    expect('baseUrl' in options).toBe(false);
    expect(options.readyOn).toBe('http://flag.test/');
    expect(options.ignoreHTTPSErrors).toBe(true);
  });
});
