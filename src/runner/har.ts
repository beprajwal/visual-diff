/**
 * HAR handling (spec §6 "Git boundary", §7 "Network", D9).
 *
 * HAR files are committed for cross-machine determinism, so they are scrubbed on record:
 * `Authorization`, `Cookie` and `Set-Cookie` are always dropped, along with any header, cookie or
 * query field named in `network.redact`. Writing an unscrubbed HAR requires an explicit
 * `--no-scrub`, which is why scrubbing is the default path and the flag only skips this call.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { DEFAULTS } from '../types.js';

/** Placeholder left in place of a redacted value, so the shape of the request survives. */
export const REDACTED = '__REDACTED__';

export interface ScrubOptions {
  /** Extra header/cookie/query names to redact, from `config.network.redact`. */
  redact?: readonly string[];
}

export interface ScrubResult {
  har: string;
  /** Number of values replaced. */
  redacted: number;
}

interface NameValue {
  name?: unknown;
  value?: unknown;
}

function namesToRedact(options: ScrubOptions): Set<string> {
  const set = new Set<string>(DEFAULTS.alwaysRedactHeaders.map((name) => name.toLowerCase()));
  for (const name of options.redact ?? []) set.add(name.toLowerCase());
  return set;
}

function scrubList(list: unknown, names: Set<string>, drop: boolean): number {
  if (!Array.isArray(list)) return 0;
  let count = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = list[i] as NameValue | undefined;
    if (entry === undefined || typeof entry.name !== 'string') continue;
    if (!names.has(entry.name.toLowerCase())) continue;
    if (drop) list.splice(i, 1);
    else entry.value = REDACTED;
    count += 1;
  }
  return count;
}

/**
 * Scrub a parsed HAR in place. Headers and cookies named in the redact set are removed outright
 * (leaving a placeholder header would still leak its presence-shaped metadata into the repo);
 * query and post parameters keep their name with a `__REDACTED__` value, because a missing query
 * parameter changes the request identity that replay matches on.
 */
export function scrubHarObject(har: unknown, options: ScrubOptions = {}): number {
  const names = namesToRedact(options);
  let redacted = 0;
  const log = (har as { log?: { entries?: unknown } } | undefined)?.log;
  const entries = log?.entries;
  if (!Array.isArray(entries)) return 0;

  for (const entry of entries) {
    const record = entry as {
      request?: { headers?: unknown; cookies?: unknown; queryString?: unknown; postData?: unknown };
      response?: { headers?: unknown; cookies?: unknown };
    };
    if (record.request !== undefined) {
      redacted += scrubList(record.request.headers, names, true);
      redacted += scrubList(record.request.cookies, names, true);
      redacted += scrubList(record.request.queryString, names, false);
      const postData = record.request.postData as { params?: unknown } | undefined;
      if (postData !== undefined) redacted += scrubList(postData.params, names, false);
    }
    if (record.response !== undefined) {
      redacted += scrubList(record.response.headers, names, true);
      redacted += scrubList(record.response.cookies, names, true);
    }
  }
  return redacted;
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i;

/** True for a URL served by a dev server on this machine. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Point a recorded HAR at the origin this run is actually using.
 *
 * A spawned dev server gets a fresh ephemeral port every run (spec §7), and Playwright's
 * `routeFromHAR` matches on the request URL — so a HAR recorded on port A serves *nothing* on port
 * B, every request becomes a HAR miss, and the frozen network D9 promises silently stops working.
 * Rewriting the loopback authority (never the path, never a real host) is what makes a committed
 * HAR portable across runs and across machines, which is the whole reason §6 commits it.
 */
export function retargetHar(source: string, targetOrigin: string): { har: string; rewritten: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { har: source, rewritten: 0 };
  }
  const entries = (parsed as { log?: { entries?: unknown } } | undefined)?.log?.entries;
  if (!Array.isArray(entries)) return { har: source, rewritten: 0 };

  let target: URL;
  try {
    target = new URL(targetOrigin);
  } catch {
    return { har: source, rewritten: 0 };
  }

  let rewritten = 0;
  for (const entry of entries) {
    const request = (entry as { request?: { url?: unknown } }).request;
    if (request === undefined || typeof request.url !== 'string') continue;
    if (!isLoopbackUrl(request.url)) continue;
    const url = new URL(request.url);
    if (url.host === target.host && url.protocol === target.protocol) continue;
    url.protocol = target.protocol;
    url.host = target.host;
    request.url = url.toString();
    rewritten += 1;
  }
  return { har: `${JSON.stringify(parsed, null, 2)}\n`, rewritten };
}

/**
 * Write a run-local copy of `file` whose loopback URLs point at `targetOrigin`, and return its
 * path — or the original path when nothing needed rewriting. The committed HAR is never modified.
 */
export async function retargetHarFile(
  file: string,
  targetOrigin: string,
  outFile: string,
): Promise<string> {
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch {
    return file;
  }
  const { har, rewritten } = retargetHar(source, targetOrigin);
  if (rewritten === 0) return file;
  await writeFile(outFile, har, 'utf8');
  return outFile;
}

export function scrubHar(source: string, options: ScrubOptions = {}): ScrubResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    // A HAR we cannot parse is a HAR we cannot promise is clean: refuse to rewrite it.
    return { har: source, redacted: 0 };
  }
  const redacted = scrubHarObject(parsed, options);
  return { har: `${JSON.stringify(parsed, null, 2)}\n`, redacted };
}

/** Scrub a HAR that Playwright just wrote. Returns the number of redacted values. */
export async function scrubHarFile(file: string, options: ScrubOptions = {}): Promise<number> {
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch {
    return 0;
  }
  const result = scrubHar(source, options);
  if (result.har !== source) await writeFile(file, result.har, 'utf8');
  return result.redacted;
}
