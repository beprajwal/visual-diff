/**
 * `e2e/playwright` — the trace format version policy (e2e spec §8, §10).
 *
 * §10 leaves "which Playwright trace format versions to support, and the policy when a newer one
 * appears" open. This is the answer, and the reasoning is measured rather than chosen.
 *
 * The version is a single integer on the first line of each `*.trace` file, inside
 * `context-options`. Nothing else in the archive is versioned. Reading the recorder out of every
 * published tarball gives the mapping:
 *
 * | version | Playwright |
 * |---|---|
 * | 3 | 1.16 – 1.31 |
 * | 4 | 1.32 – 1.38 |
 * | 5 | 1.39 |
 * | 6 | 1.40 – 1.44 |
 * | 7 | 1.45 – 1.52 |
 * | 8 | 1.53 – 1.62 |
 *
 * **We accept 7 and 8.** Version 8 has been stable across roughly ten releases and covers every
 * Playwright from mid-2023's successor onward; version 7 is one field rename away from it and is
 * handled in `modernize.ts`.
 *
 * **We refuse below 7 rather than modernizing down to it.** Playwright's own loader will happily
 * upgrade a version 3 trace through eight successive rewrites, but the pre-v7 events carry no
 * `stepId` and no reliable `origin`, so the title-to-step-id mapping D26 depends on cannot be done
 * correctly on them. A partial ingest that silently mis-keys every step is worse than a refusal,
 * and §8 already establishes refusal as the response to a version we cannot read.
 *
 * **A trace with no version field is version 6** — that is Playwright's own default in the
 * modernizer dispatcher — which is below the floor, so it is refused with the same message.
 */

import { traceVersionUnsupported } from '../errors.js';

/** Accepted format versions, lowest first. */
export const SUPPORTED_TRACE_VERSIONS = [7, 8] as const;

/** The version Playwright assumes when a trace declares none. */
export const UNDECLARED_TRACE_VERSION = 6;

/** The lowest version whose events carry what D26's mapping needs. */
export const MIN_TRACE_VERSION = SUPPORTED_TRACE_VERSIONS[0];
export const MAX_TRACE_VERSION = SUPPORTED_TRACE_VERSIONS[SUPPORTED_TRACE_VERSIONS.length - 1] as number;

export function isSupportedTraceVersion(version: number): boolean {
  return (SUPPORTED_TRACE_VERSIONS as readonly number[]).includes(version);
}

/**
 * Resolves the version an archive declares, refusing anything outside the supported range with the
 * §8 message: the version found, and the versions supported.
 */
export function assertSupportedTraceVersion(file: string, declared: number | undefined): number {
  if (declared === undefined) {
    throw traceVersionUnsupported(file, UNDECLARED_TRACE_VERSION, SUPPORTED_TRACE_VERSIONS, {
      declared: false,
    });
  }
  if (!Number.isInteger(declared) || !isSupportedTraceVersion(declared)) {
    throw traceVersionUnsupported(file, declared, SUPPORTED_TRACE_VERSIONS);
  }
  return declared;
}
