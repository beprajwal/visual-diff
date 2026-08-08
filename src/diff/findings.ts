/**
 * Step-scoped findings: structural (from stage 1), console and network (spec §8).
 *
 * These carry no viewport — they describe the step as a whole — and no region, so they never take
 * part in clustering or attribution.
 *
 * Findings are built here with an empty `id` and numbered by the engine once the whole `DiffResult`
 * exists, so ids run in the order a reader meets them: step by step, severity first.
 */

import type {
  ConsoleEntry,
  Finding,
  FlowDiffEntry,
  NetworkEntry,
  Severity,
  StepId,
} from '../types.js';

const STRUCTURAL: Record<string, { label: string; severity: Severity; reason: string } | undefined> = {
  added: { label: 'step added', severity: 'med', reason: 'step-added' },
  removed: { label: 'step removed', severity: 'med', reason: 'step-removed' },
  'spec-changed': { label: 'step spec changed', severity: 'med', reason: 'step-spec-changed' },
  // A failed step invalidates everything downstream (spec §7), so it ranks with the other highs.
  failed: { label: 'step failed', severity: 'high', reason: 'step-failed' },
  blocked: { label: 'step blocked', severity: 'med', reason: 'step-blocked' },
};

/** One structural finding per non-matched flow-diff entry. */
export function structuralFindings(entry: FlowDiffEntry): Finding[] {
  const spec = STRUCTURAL[entry.status];
  if (spec === undefined) return [];
  const label = entry.detail === undefined ? spec.label : `${spec.label}: ${entry.detail}`;
  return [
    {
      id: '',
      kind: 'structural',
      severity: spec.severity,
      step: entry.id,
      changes: [],
      label,
      reasons: [spec.reason],
    },
  ];
}

function consoleKey(e: ConsoleEntry): string {
  return `${e.level}\u0000${e.text.trim()}`;
}

/**
 * Console diff for one step. A new error is high severity per spec §8; a new warning is `med`, and
 * an error that disappeared is `low` — information, never hidden.
 */
export function consoleFindings(
  step: StepId,
  base: readonly ConsoleEntry[],
  head: readonly ConsoleEntry[],
): Finding[] {
  const interesting = (e: ConsoleEntry): boolean => e.level === 'error' || e.level === 'warn';
  const baseKeys = new Map<string, ConsoleEntry>();
  for (const e of base) if (interesting(e)) baseKeys.set(consoleKey(e), e);
  const headKeys = new Map<string, ConsoleEntry>();
  for (const e of head) if (interesting(e)) headKeys.set(consoleKey(e), e);

  const out: Finding[] = [];
  for (const [key, entry] of headKeys) {
    if (baseKeys.has(key)) continue;
    const isError = entry.level === 'error';
    out.push({
      id: '',
      kind: 'console',
      severity: isError ? 'high' : 'med',
      step,
      changes: [{ prop: 'text', from: null, to: entry.text }],
      label: isError ? 'new console error' : 'new console warning',
      reasons: [isError ? 'new-console-error' : 'new-console-warning'],
    });
  }
  for (const [key, entry] of baseKeys) {
    if (headKeys.has(key)) continue;
    if (entry.level !== 'error') continue;
    out.push({
      id: '',
      kind: 'console',
      severity: 'low',
      step,
      changes: [{ prop: 'text', from: entry.text, to: null }],
      label: 'console error resolved',
      reasons: ['console-error-resolved'],
    });
  }
  return out;
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i;

/**
 * The URL two runs are matched on.
 *
 * A spawned dev server gets a fresh ephemeral port on every run (spec §7), so the *authority* of a
 * loopback URL is an accident of the run, not a change in the app. Comparing it literally reports
 * "new request / request removed" for every single request of every spawn-path pair — precisely the
 * cry-wolf failure §8's noise control exists to prevent. The origin is therefore collapsed for
 * loopback hosts only; a real host or a changed path still differs, and the *displayed* URL stays
 * the literal one that was recorded.
 */
export function normalizeRequestUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!LOOPBACK.test(parsed.hostname)) return url;
    return `${parsed.protocol}//localhost${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function requestKey(e: NetworkEntry): string {
  return `${e.method} ${normalizeRequestUrl(e.url)}`;
}

/** Network diff for one step: requests appearing or disappearing, status changes, and HAR misses. */
export function networkFindings(
  step: StepId,
  base: readonly NetworkEntry[],
  head: readonly NetworkEntry[],
): Finding[] {
  const baseByKey = new Map<string, NetworkEntry>();
  for (const e of base) if (!baseByKey.has(requestKey(e))) baseByKey.set(requestKey(e), e);
  const headByKey = new Map<string, NetworkEntry>();
  for (const e of head) if (!headByKey.has(requestKey(e))) headByKey.set(requestKey(e), e);

  const out: Finding[] = [];
  for (const [key, entry] of headByKey) {
    const before = baseByKey.get(key);
    if (before === undefined) {
      out.push({
        id: '',
        kind: 'network',
        severity: 'med',
        step,
        changes: [{ prop: 'url', from: null, to: entry.url }],
        label: `new request ${entry.method} ${entry.url}`,
        reasons: ['request-added'],
      });
    } else if (before.status !== entry.status) {
      out.push({
        id: '',
        kind: 'network',
        severity: 'med',
        step,
        changes: [{ prop: 'status', from: before.status, to: entry.status }],
        label: `response status changed for ${entry.method} ${entry.url}`,
        reasons: ['status-changed'],
      });
    }
    if (entry.harMatch === 'miss' && before?.harMatch !== 'miss') {
      out.push({
        id: '',
        kind: 'network',
        severity: 'med',
        step,
        changes: [{ prop: 'harMatch', from: before?.harMatch ?? null, to: 'miss' }],
        label: `HAR miss for ${entry.method} ${entry.url}`,
        reasons: ['har-miss'],
      });
    }
  }
  for (const [key, entry] of baseByKey) {
    if (headByKey.has(key)) continue;
    out.push({
      id: '',
      kind: 'network',
      severity: 'low',
      step,
      changes: [{ prop: 'url', from: entry.url, to: null }],
      label: `request removed ${entry.method} ${entry.url}`,
      reasons: ['request-removed'],
    });
  }
  return out;
}
