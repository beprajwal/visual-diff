import { describe, expect, it } from 'vitest';

import { isE2eError } from '../errors.js';
import {
  assertSupportedTraceVersion,
  isSupportedTraceVersion,
  MAX_TRACE_VERSION,
  MIN_TRACE_VERSION,
  SUPPORTED_TRACE_VERSIONS,
  UNDECLARED_TRACE_VERSION,
} from './version.js';

const FILE = '/tmp/traces/checkout.zip';

describe('the supported version range', () => {
  it('accepts 7 and 8, the versions Playwright 1.45 onward writes', () => {
    expect([...SUPPORTED_TRACE_VERSIONS]).toEqual([7, 8]);
    expect(MIN_TRACE_VERSION).toBe(7);
    expect(MAX_TRACE_VERSION).toBe(8);
    expect(isSupportedTraceVersion(7)).toBe(true);
    expect(isSupportedTraceVersion(8)).toBe(true);
  });

  it('rejects everything outside it', () => {
    for (const version of [0, 3, 6, 9, 42, 7.5]) {
      expect(isSupportedTraceVersion(version)).toBe(false);
    }
  });
});

describe('assertSupportedTraceVersion', () => {
  it('returns the version when it is supported', () => {
    expect(assertSupportedTraceVersion(FILE, 8)).toBe(8);
    expect(assertSupportedTraceVersion(FILE, 7)).toBe(7);
  });

  it('names the version found and the versions supported when the trace is newer', () => {
    const error = catchError(() => assertSupportedTraceVersion(FILE, 9));
    expect(error.message).toBe(
      'trace format version 9 is newer than the supported versions (7, 8); this build of visual-diff cannot read it: /tmp/traces/checkout.zip',
    );
    expect(error.hint).toBe('upgrade visual-diff; the highest trace version it reads is 8');
    expect(error.code).toBe('e2e-trace-version-unsupported');
    // §8: every ingestion refusal is a bad input, which is exit 2 and never a run failure.
    expect(error.exitCode).toBe(2);
  });

  it('explains why an older trace is refused rather than modernized', () => {
    const error = catchError(() => assertSupportedTraceVersion(FILE, 6));
    expect(error.message).toBe(
      'trace format version 6 is older than the supported versions (7, 8); it was written by ' +
        'Playwright 1.44 or earlier, which records no step ids and no reliable origin, so titles ' +
        'cannot be mapped to step ids: /tmp/traces/checkout.zip',
    );
    expect(error.hint).toBe(
      'upgrade the suite to Playwright 1.45 or later and re-record the trace (version 7 first shipped there)',
    );
  });

  it('reads a trace with no version field as version 6, and says so', () => {
    // Playwright's own modernizer dispatcher defaults to 6 when a trace declares nothing.
    expect(UNDECLARED_TRACE_VERSION).toBe(6);
    const error = catchError(() => assertSupportedTraceVersion(FILE, undefined));
    expect(error.message).toBe(
      'the trace declares no format version, which Playwright reads as version 6, and 6 is older ' +
        'than the supported versions (7, 8); it was written by Playwright 1.44 or earlier, which ' +
        'records no step ids and no reliable origin, so titles cannot be mapped to step ids: ' +
        '/tmp/traces/checkout.zip',
    );
  });

  it('refuses a non-integer version rather than rounding it into range', () => {
    const error = catchError(() => assertSupportedTraceVersion(FILE, 7.5));
    expect(error.message).toContain('trace format version 7.5 is newer than the supported versions (7, 8)');
  });
});

function catchError(fn: () => unknown): { message: string; hint?: string; code: string; exitCode: number } {
  try {
    fn();
  } catch (error) {
    if (isE2eError(error)) return error;
    throw error;
  }
  throw new Error('expected assertSupportedTraceVersion to throw');
}
