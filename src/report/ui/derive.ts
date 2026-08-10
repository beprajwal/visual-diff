/**
 * Pure derivations from a `DiffResult`: step alignment, filmstrip cells, finding grouping.
 *
 * The diff engine aligns runs by step `id` (D4) and emits `flowDiff` entries carrying the index of
 * each step on either side. The report has to lay those out as one rectangular filmstrip in which a
 * step that only exists on the base side still occupies a slot — otherwise a removed step silently
 * disappears and the reader believes the flow is unchanged.
 */

import type {
  DiffResult,
  Finding,
  FlowDiffEntry,
  FlowDiffStatus,
  PairLabel,
  RunSummary,
  ScenarioName,
  Severity,
  StepDiff,
  StepId,
  ViewportDiff,
  ViewportId,
} from '../../types.js';
import { SCENARIO_NONE, SEVERITIES, SEVERITY_ORDER } from '../../types.js';
import { describeRuleHit, type StepAttribution } from '../attribution.js';
import {
  classifySourcePair,
  describeE2eOrigin,
  describeE2eRevision,
  describeSourcePair,
  e2eOriginOf,
  isE2eRun,
  isE2eWarningKind,
  isHighSeverityE2eWarningKind,
  isPixelsOnlyFinding,
  e2eDegradedSentences,
  sourceOf,
  PIXELS_ONLY_FINDING_NOTE,
  SOURCE_E2E,
  type RunSource,
  type SourcePair,
  type SourcePairLabel,
} from '../e2e.js';
import {
  classifyVariantPair,
  describeVariantHit,
  describeVariantPair,
  isKept,
  isVariantWarningKind,
  variantOf,
  VARIANT_NONE,
  type StepVariantAttribution,
  type VariantName,
  type VariantPairLabel,
} from '../variant.js';

/** Visual treatment of one filmstrip cell (spec §9). */
export type CellVariant =
  | 'failed'
  | 'blocked'
  | 'added'
  | 'removed'
  | 'spec-changed'
  | 'changed'
  | 'identical';

export interface FilmstripCell {
  id: StepId;
  status: FlowDiffStatus;
  detail?: string;
  baseIndex: number | null;
  headIndex: number | null;
  /** Position in the aligned strip, 0-based. */
  order: number;
  variant: CellVariant;
  /** Findings attributable to this cell for the active viewport. */
  findingsCount: number;
  /** Highest severity present, or null when there are no findings. */
  topSeverity: Severity | null;
  pixelChangedRatio: number;
  /** Badge glyph: a count for changed steps, a symbol for the categorical states. */
  badge: string;
  /** Run whose screenshot is the natural thumbnail: the head, except for removed steps. */
  thumbSide: 'head' | 'base';
  /** True when the step has no findings and no changed pixels. */
  identical: boolean;
}

/**
 * Orders aligned steps for display.
 *
 * Head order is the spine, because the head is what the reader is looking at. Steps that exist only
 * on the base side (removed) are spliced in after the base-side step that preceded them, so a
 * removal shows up where it used to be rather than being dumped at the end.
 */
export function alignFlowDiff(entries: readonly FlowDiffEntry[]): FlowDiffEntry[] {
  const spine = entries
    .filter((e) => e.headIndex !== null)
    .slice()
    .sort((a, b) => (a.headIndex ?? 0) - (b.headIndex ?? 0));

  const orphans = entries
    .filter((e) => e.headIndex === null)
    .slice()
    .sort((a, b) => (a.baseIndex ?? 0) - (b.baseIndex ?? 0));

  if (orphans.length === 0) return spine;

  const out: FlowDiffEntry[] = spine.slice();
  for (const orphan of orphans) {
    const baseIndex = orphan.baseIndex ?? -1;
    // Insert after the last already-placed entry whose base index precedes this one.
    let insertAt = 0;
    for (let i = 0; i < out.length; i += 1) {
      const candidate = out[i];
      if (!candidate) continue;
      const candidateBase = candidate.baseIndex;
      if (candidateBase !== null && candidateBase < baseIndex) insertAt = i + 1;
    }
    out.splice(insertAt, 0, orphan);
  }
  return out;
}

/** The viewport diff for a step, or undefined when that viewport was not captured. */
export function viewportDiffOf(
  step: StepDiff | undefined,
  viewport: ViewportId | null,
): ViewportDiff | undefined {
  if (!step) return undefined;
  if (viewport !== null) return step.viewports[viewport];
  const first = Object.keys(step.viewports)[0];
  return first === undefined ? undefined : step.viewports[first];
}

/**
 * Every finding attributable to a step for the active viewport: the viewport-scoped findings plus
 * the step-scoped ones (console, network), which have no viewport of their own and must not vanish
 * when a viewport tab is selected.
 */
export function findingsForStep(step: StepDiff | undefined, viewport: ViewportId | null): Finding[] {
  if (!step) return [];
  const out: Finding[] = [];
  if (viewport === null) {
    for (const key of Object.keys(step.viewports)) {
      const vd = step.viewports[key];
      if (vd) out.push(...vd.findings);
    }
  } else {
    const vd = step.viewports[viewport];
    if (vd) out.push(...vd.findings);
  }
  out.push(...step.findings);
  return out;
}

/** Sorts by severity, then by kind, then by id, so the list order is stable across renders. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return findings.slice().sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface SeverityGroup {
  severity: Severity;
  findings: Finding[];
}

/** Groups findings by severity in high → low order. Empty severities are omitted, never hidden. */
export function groupBySeverity(findings: readonly Finding[]): SeverityGroup[] {
  const groups: SeverityGroup[] = [];
  for (const severity of SEVERITIES) {
    const matching = findings.filter((f) => f.severity === severity);
    if (matching.length > 0) groups.push({ severity, findings: sortFindings(matching) });
  }
  return groups;
}

/** Highest severity present, or null for an empty list. */
export function topSeverity(findings: readonly Finding[]): Severity | null {
  let best: Severity | null = null;
  for (const f of findings) {
    if (best === null || SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[best]) best = f.severity;
  }
  return best;
}

function variantFor(status: FlowDiffStatus, findingsCount: number, ratio: number): CellVariant {
  switch (status) {
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'spec-changed':
      return 'spec-changed';
    case 'matched':
      return findingsCount === 0 && ratio === 0 ? 'identical' : 'changed';
    default:
      return 'changed';
  }
}

function badgeFor(variant: CellVariant, findingsCount: number): string {
  switch (variant) {
    case 'failed':
      return '!';
    case 'blocked':
      return '···';
    case 'added':
      return '+';
    case 'removed':
      return '−';
    case 'identical':
      return '=';
    case 'spec-changed':
      return findingsCount > 0 ? String(findingsCount) : '≠';
    case 'changed':
    default:
      return String(findingsCount);
  }
}

/** Builds one cell per aligned step, in display order. */
export function buildFilmstrip(diff: DiffResult, viewport: ViewportId | null): FilmstripCell[] {
  const byId = new Map<StepId, StepDiff>();
  for (const step of diff.steps) byId.set(step.id, step);

  return alignFlowDiff(diff.flowDiff).map((entry, order) => {
    const step = byId.get(entry.id);
    const findings = findingsForStep(step, viewport);
    const vd = viewportDiffOf(step, viewport);
    const ratio = vd ? vd.pixelChangedRatio : 0;
    const status = step?.status ?? entry.status;
    const variant = variantFor(status, findings.length, ratio);
    return {
      id: entry.id,
      status,
      detail: entry.detail ?? step?.detail,
      baseIndex: entry.baseIndex,
      headIndex: entry.headIndex,
      order,
      variant,
      findingsCount: findings.length,
      topSeverity: topSeverity(findings),
      pixelChangedRatio: ratio,
      badge: badgeFor(variant, findings.length),
      thumbSide: entry.headIndex === null ? 'base' : 'head',
      identical: variant === 'identical',
    };
  });
}

/** Cells the reader should see, honouring the findings-only filter (`f`). */
export function visibleCells(
  cells: readonly FilmstripCell[],
  findingsOnly: boolean,
): FilmstripCell[] {
  if (!findingsOnly) return cells.slice();
  const filtered = cells.filter((c) => c.findingsCount > 0 || c.variant === 'failed');
  // Never filter down to nothing: an empty strip has no navigation affordance at all.
  return filtered.length > 0 ? filtered : cells.slice();
}

/** Every viewport present in the diff, in the head run's declared order. */
export function viewportsOf(diff: DiffResult): ViewportId[] {
  const seen = new Set<ViewportId>();
  const out: ViewportId[] = [];
  const push = (v: ViewportId): void => {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  for (const v of diff.headMeta.viewports) push(v);
  for (const v of diff.baseMeta.viewports) push(v);
  for (const step of diff.steps) for (const v of Object.keys(step.viewports)) push(v);
  return out;
}

/** Short display label for a run: id, short SHA, ref, dirty marker. */
export function runLabel(run: RunSummary): string {
  const sha = run.revision.sha.slice(0, 7);
  const ref = run.revision.ref ? ` ${run.revision.ref}` : '';
  const dirty = run.revision.dirty ? ' *' : '';
  return `${run.runId}  ${sha}${ref}${dirty}`;
}

/* ------------------------------------------------------------------ scenarios (mocking §6, §7) */

/** The value the scenario selector uses for "every scenario", distinct from the reserved `none`. */
export const ALL_SCENARIOS = '*';

/** How a scenario name reads in the interface: the reserved `none` is an absence, not a name. */
export function scenarioLabel(scenario: ScenarioName): string {
  return scenario === SCENARIO_NONE ? 'no scenario' : scenario;
}

/**
 * Every scenario present in a run list, `none` first and the rest alphabetical.
 *
 * `none` leads because it is the ordinary case and, for a project that has never written a
 * scenario, the only one — putting it wherever the alphabet happens to place a scenario named
 * "a-something" would make the default selection jump around as scenarios are added.
 */
export function scenariosOf(runs: readonly RunSummary[]): ScenarioName[] {
  const seen = new Set<ScenarioName>();
  for (const run of runs) seen.add(run.scenario);
  const rest = [...seen].filter((name) => name !== SCENARIO_NONE).sort();
  return seen.has(SCENARIO_NONE) ? [SCENARIO_NONE, ...rest] : rest;
}

/** Runs captured under `scenario`; every run for {@link ALL_SCENARIOS} or a null filter. */
export function runsForScenario(
  runs: readonly RunSummary[],
  scenario: ScenarioName | null,
): RunSummary[] {
  if (scenario === null || scenario === ALL_SCENARIOS) return runs.slice();
  return runs.filter((run) => run.scenario === scenario);
}

/**
 * The banners a pair carries (mocking spec §6), most severe first. Empty for a same-scenario pair,
 * and empty for a diff stored before this slice, which was same-scenario by construction.
 */
export function pairLabels(diff: DiffResult | null): PairLabel[] {
  const scenarios = diff?.scenarios;
  if (!scenarios) return [];
  const labels: PairLabel[] = [];
  if (scenarios.mockVsRecorded) labels.push('mock-vs-recorded');
  if (scenarios.crossScenario) labels.push('cross-scenario');
  return labels;
}

/** True when this run was captured with no recording behind it at all (D13). */
export function isMockOnly(meta: { network: string } | null | undefined): boolean {
  return meta?.network === 'mock';
}

/** One banner above the images, describing a pairing that is not an ordinary regression check. */
export interface PairBannerRow {
  label: PairLabel;
  /**
   * `cross-scenario` is a legitimate question — two states, not two revisions — so it is stated.
   * `mock-vs-recorded` compares a fiction to a measurement and is flagged high (mocking spec §6).
   */
  severity: 'high' | 'med';
  message: string;
}

const PAIR_SEVERITY: Record<PairLabel, 'high' | 'med'> = {
  'mock-vs-recorded': 'high',
  'cross-scenario': 'med',
};

/**
 * The banners a pair carries, most severe first (mocking spec §6).
 *
 * Lives here rather than in the component because it is the sentence a reviewer acts on, and the
 * report's rule is that everything carrying real meaning is a pure function with a test.
 */
export function pairBanners(diff: DiffResult | null): PairBannerRow[] {
  const scenarios = diff?.scenarios;
  if (!scenarios) return [];
  const base = scenarioLabel(scenarios.base);
  const head = scenarioLabel(scenarios.head);

  return pairLabels(diff).map((label) => ({
    label,
    severity: PAIR_SEVERITY[label],
    message:
      label === 'cross-scenario'
        ? `base ran ${base}, head ran ${head}. This compares two states, not two revisions —` +
          ' findings below describe the difference between the scenarios as much as the code.'
        : 'One side is a mock-only run: no recording stands behind it, so its responses are only' +
          ' as faithful as the scenario that invented them. This compares a fiction to a' +
          ' measurement.',
  }));
}

/** One annotation line under the toolbar, attached to the selected step (mocking spec §8). */
export interface ScenarioNoteRow {
  /** Stable across renders: rule id plus action, or the synthetic miss row. */
  key: string;
  side: 'base' | 'head';
  text: string;
  urls: string[];
  /** A mock-mode miss denied the page a response entirely, so it reads as a warning. */
  severity: 'high' | 'note';
}

/**
 * The annotation lines for one side of the pair at one step.
 *
 * Empty when that run had no scenario, or when its rules left this step alone — which is why the
 * component can render it unconditionally and still disappear on an ordinary run.
 */
export function scenarioNoteRows(
  side: 'base' | 'head',
  attribution: StepAttribution | undefined,
): ScenarioNoteRow[] {
  if (attribution === undefined) return [];

  const rows: ScenarioNoteRow[] = attribution.rules.map((hit) => ({
    key: `${side}-${hit.ruleId}-${hit.action}`,
    side,
    text: hit.requests > 1 ? `${describeRuleHit(hit)} ×${hit.requests}` : describeRuleHit(hit),
    urls: hit.urls,
    severity: 'note' as const,
  }));

  if (attribution.misses > 0) {
    const one = attribution.misses === 1;
    rows.push({
      key: `${side}-miss`,
      side,
      text:
        `${attribution.misses} ${one ? 'request' : 'requests'} matched no rule and ` +
        `${one ? 'was' : 'were'} aborted — this step rendered without ${one ? 'it' : 'them'}`,
      urls: [],
      severity: 'high',
    });
  }

  return rows;
}

/* ------------------------------------------------------------------ variants (§5, §7) */

/** The value the variant selector uses for "every variant", distinct from the reserved `none`. */
export const ALL_VARIANTS = '*';

/** How a variant name reads in the interface: the reserved `none` is an absence, not a name. */
export function variantLabel(variant: VariantName): string {
  return variant === VARIANT_NONE ? 'no variant' : variant;
}

/**
 * Every variant present in a run list, `none` first and the rest alphabetical — the same shape as
 * {@link scenariosOf}, because the two axes of run identity are shown the same way.
 */
export function variantsOf(runs: readonly RunSummary[]): VariantName[] {
  const seen = new Set<VariantName>();
  for (const run of runs) seen.add(variantOf(run));
  const rest = [...seen].filter((name) => name !== VARIANT_NONE).sort();
  return seen.has(VARIANT_NONE) ? [VARIANT_NONE, ...rest] : rest;
}

/**
 * Runs captured under `variant`; every run for {@link ALL_VARIANTS} or a null filter.
 *
 * Note what this deliberately does *not* do: hide unpromoted variant runs by default, the way
 * `vdiff runs` does (D24). That default exists because the CLI timeline is where regression history
 * is read and proposals would crowd it out; the report is a viewer with an explicit picker, and a
 * proposal that cannot be selected cannot be looked at — which is the entire point of running one.
 * They are badged instead, on the picker and in the banner.
 */
export function runsForVariant(
  runs: readonly RunSummary[],
  variant: VariantName | null,
): RunSummary[] {
  if (variant === null || variant === ALL_VARIANTS) return runs.slice();
  return runs.filter((run) => variantOf(run) === variant);
}

/** True when this timeline row is a proposal nobody promoted into the permanent timeline (D24). */
export function isEphemeralRun(run: RunSummary): boolean {
  return variantOf(run) !== VARIANT_NONE && !isKept(run);
}

/**
 * The banner a pair carries on the variant axis (variants spec §5, D24).
 *
 * Severity is where this differs from every other banner in the report, and the difference is the
 * decision: **the proposal comparison is the normal case**, so it is `note` — stated, calm, no
 * warning stripe. It is what a variant run exists to produce, and dressing it as an anomaly would
 * teach a reader to skip the row that also carries the two pairings that really are confounded.
 */
export interface VariantBannerRow {
  label: VariantPairLabel;
  /** `note` states a fact; `med` says the findings below mean something other than a regression. */
  severity: 'med' | 'note';
  message: string;
}

const VARIANT_BANNER_SEVERITY: Record<VariantPairLabel, 'med' | 'note'> = {
  'variant-proposal': 'note',
  'cross-variant': 'med',
  'variant-across-revisions': 'med',
};

/**
 * The variant banner for a pair, derived from the two runs' meta rather than from a field on the
 * stored diff — so a pair computed before variants existed still classifies correctly instead of
 * reading as "no variant information".
 */
export function variantBanners(diff: DiffResult | null): VariantBannerRow[] {
  if (diff === null) return [];
  const pair = classifyVariantPair(diff.baseMeta, diff.headMeta);
  const message = describeVariantPair(pair);
  if (pair.label === null || message === null) return [];
  return [{ label: pair.label, severity: VARIANT_BANNER_SEVERITY[pair.label], message }];
}

/** One annotation line under the toolbar, attached to the selected step (variants spec §7). */
export interface VariantNoteRow {
  /** Stable across renders: rule id plus verb, which is also what the fold is keyed by. */
  key: string;
  side: 'base' | 'head';
  /** The verb, rendered as a tag beside the sentence rather than conjugated into it. */
  verb: string;
  text: string;
  viewports: ViewportId[];
}

/**
 * The annotation lines for one side of the pair at one step: "element modified by `denser-forecast`
 * rule `tighter-cards`" (variants spec §7).
 *
 * Empty when that run had no variant, or when its rules changed nothing in this step — which is why
 * the component can render it unconditionally and still disappear on an ordinary run.
 *
 * Rules that matched nothing and rules reverted before capture are deliberately absent: they are
 * properties of the whole run, they are already run warnings naming their rule ids, and a rule that
 * matched nothing has no step to annotate. Saying it twice would make neither statement the one a
 * reader trusts.
 */
export function variantNoteRows(
  side: 'base' | 'head',
  attribution: StepVariantAttribution | undefined,
): VariantNoteRow[] {
  if (attribution === undefined) return [];
  return attribution.rules.map((hit) => ({
    key: `${side}-${hit.ruleId}-${hit.verb}`,
    side,
    verb: hit.verb,
    text: describeVariantHit(hit),
    viewports: hit.viewports,
  }));
}

/* ------------------------------------------------------------------ e2e (§4, §7, D27) */

/** The value the source selector uses for "either timeline". */
export const ALL_SOURCES = '*';

/** How a source reads in the interface. */
export function sourceLabel(source: RunSource): string {
  return source === SOURCE_E2E ? 'e2e' : 'replay';
}

/**
 * Every source present in a run list, `replay` first and `e2e` after — the fixed order rather than
 * the order they happen to appear in, so the picker does not reorder itself as runs arrive.
 */
export function sourcesOf(runs: readonly RunSummary[]): RunSource[] {
  const seen = new Set<RunSource>();
  for (const run of runs) seen.add(sourceOf(run));
  return (['replay', SOURCE_E2E] as RunSource[]).filter((source) => seen.has(source));
}

/**
 * Runs from `source`; every run for {@link ALL_SOURCES} or a null filter.
 *
 * Like {@link runsForVariant}, this deliberately does *not* hide ingested runs by default the way
 * `vdiff runs` does (D27). That CLI default exists because the timeline is where regression history
 * is read and a CI batch would bury it; the report is a viewer with an explicit picker, and a run
 * that cannot be selected cannot be looked at. They are badged instead.
 */
export function runsForSource(
  runs: readonly RunSummary[],
  source: RunSource | typeof ALL_SOURCES | null,
): RunSummary[] {
  if (source === null || source === ALL_SOURCES) return runs.slice();
  return runs.filter((run) => sourceOf(run) === source);
}

/** True when this timeline row was ingested from a test suite's artifact rather than replayed. */
export function isIngestedRun(run: RunSummary): boolean {
  return isE2eRun(run);
}

/**
 * One line of provenance for an ingested run: the test it came from, the browser, the versions.
 *
 * Null for a replay run and for an ingested one whose archive recorded nothing worth naming — which
 * is the ordinary case for a library-only trace, not a fault. The caller renders nothing rather than
 * an empty rail.
 */
export function e2eOriginLine(run: object | null | undefined): string | null {
  return describeE2eOrigin(e2eOriginOf(run));
}

/**
 * The "this run is not attributed to a commit" line, for an ingested run whose revision is unknown.
 *
 * Only for ingested runs: a *replay* with an empty revision means the tool failed to read git, which
 * is a different problem with a different remedy, and answering it with "traces carry no git
 * metadata" would send the reader somewhere useless.
 */
export function e2eRevisionNote(run: RunSummary | null | undefined): string | null {
  if (run === null || run === undefined || !isE2eRun(run)) return null;
  return describeE2eRevision(run.revision);
}

/**
 * The banner a pair carries on the source axis (e2e spec §4, D27).
 *
 * Two rows at most, and the split is the decision:
 *
 *  - `e2e-vs-replay` is **high**, the same severity as `mock-vs-recorded`, because the two sides
 *    came out of different machinery: a different browser, no frozen clock, no settle gate, and a
 *    lossy downscaled viewport frame compared against a full-page PNG. Almost every finding beneath
 *    it describes the capture rather than the application.
 *  - `e2e-pair` is a **note**. Both sides ingested is what e2e mode exists to produce, so it is
 *    stated calmly — but it is stated, because such a pair is a pixel comparison (§4): no finding
 *    below names an element or a property, and a reader who is not told will read a list of
 *    anonymous changed regions as the tool having examined the DOM and found nothing there.
 */
export interface SourceBannerRow {
  label: SourcePairLabel;
  severity: 'high' | 'note';
  message: string;
  /**
   * What this pair can and cannot report, carried on the row rather than folded into `message` so
   * the component can render it as a sub-list instead of one unreadable sentence. Empty when the
   * pair is not degraded, and worded for the pair in hand: an e2e pair is told it is pixels only, a
   * mixed pair is told its element names came from the replayed side.
   */
  details: readonly string[];
}

const SOURCE_BANNER_SEVERITY: Record<SourcePairLabel, 'high' | 'note'> = {
  'e2e-vs-replay': 'high',
  'e2e-pair': 'note',
};

/**
 * The source banner for a pair, derived from the two runs' meta rather than from a field on the
 * stored diff — so a pair computed before e2e mode existed classifies as replay-versus-replay
 * instead of reading as "no source information", and carries no banner at all.
 */
export function sourceBanners(diff: DiffResult | null): SourceBannerRow[] {
  if (diff === null) return [];
  const pair = classifySourcePair(diff.baseMeta, diff.headMeta);
  const message = describeSourcePair(pair);
  if (pair.label === null || message === null) return [];
  return [
    {
      label: pair.label,
      severity: SOURCE_BANNER_SEVERITY[pair.label],
      message,
      details: e2eDegradedSentences(pair),
    },
  ];
}

/**
 * Finding kinds *any* pair with an ingested side cannot produce (§4).
 *
 * `style` and `a11y` are gone the moment one side is a trace: no computed styles, no accessibility
 * tree, nothing to compare. An empty style section on such a diff is a capability limit, not a
 * clean bill of health.
 */
const DEGRADED_KIND_NOTES: ReadonlyMap<string, { layer: string; why: string }> = new Map([
  [
    'style',
    {
      layer: 'computed-style findings',
      why:
        'not available for an e2e pair: a Playwright trace records no computed styles, so there is' +
        ' nothing to compare property by property',
    },
  ],
  [
    'a11y',
    {
      layer: 'accessibility findings',
      why: 'not available for an e2e pair: a Playwright trace records no accessibility tree',
    },
  ],
]);

/**
 * Finding kinds that additionally disappear when **both** sides were ingested.
 *
 * A structural finding — this element was added, that one removed — reaches the report only by
 * being attributed to a changed region, and on a pair of ingested runs nothing attributes: a trace
 * snapshot carries no box metrics, so every node has a zero rect and no region intersects any of
 * them. The DOM difference may be perfectly real, as a heading renamed from "Saved locations" to
 * "Your places" is; it arrives as changed pixels with nothing attached.
 */
const PIXELS_ONLY_KIND_NOTES: ReadonlyMap<string, { layer: string; why: string }> = new Map([
  [
    'structural',
    {
      layer: 'added/removed element findings',
      why:
        'not available for an e2e pair: a trace snapshot carries no box metrics, so a DOM change' +
        ' cannot be located on the screenshot and is reported as a changed region instead',
    },
  ],
]);

/**
 * The headline of the rail on a pixels-only pair, and the sentence this whole slice turns on.
 *
 * It goes first because it changes how every finding *that is* present reads: not "the tool
 * examined the elements here and found this", but "these pixels differ, and nothing in the archive
 * could say why".
 */
const PIXELS_ONLY_ATTRIBUTION_NOTE =
  'element attribution: not available for an e2e pair: a trace snapshot carries no box metrics, so' +
  ' every finding below is a changed region of the screenshot with no element behind it — this is a' +
  ' pixel comparison, not an element-level one';

/** True when both sides were ingested, and therefore when nothing can be attributed at all. */
function isPixelsOnlyPair(diff: DiffResult | null): boolean {
  if (diff === null) return false;
  const pair: SourcePair = classifySourcePair(diff.baseMeta, diff.headMeta);
  return pair.base === SOURCE_E2E && pair.head === SOURCE_E2E;
}

/** The `Finding['kind']` values an ingested pair cannot produce, in §4's table order. */
export const E2E_UNAVAILABLE_FINDING_KINDS: readonly string[] = [
  ...DEGRADED_KIND_NOTES.keys(),
  ...PIXELS_ONLY_KIND_NOTES.keys(),
];

/**
 * Why a finding kind is empty on this pair, or null when it is empty because nothing changed.
 *
 * This is the whole point of §4's "marks these runs so the report can explain what it could not
 * look at rather than appear to have missed something": an empty list and an impossible list look
 * identical until one of them says so.
 */
export function unavailableKindNote(diff: DiffResult | null, kind: string): string | null {
  if (diff === null) return null;
  if (!classifySourcePair(diff.baseMeta, diff.headMeta).degraded) return null;
  const note = DEGRADED_KIND_NOTES.get(kind)?.why;
  if (note !== undefined) return note;
  return isPixelsOnlyPair(diff) ? (PIXELS_ONLY_KIND_NOTES.get(kind)?.why ?? null) : null;
}

/**
 * Every "this could not run" line for a pair, attribution first and then §4's table order.
 *
 * Rendered beside the findings rather than in the banner strip, because the rail is where a reader
 * decides the tool found nothing. "No findings for this step" and "no findings of that kind are
 * obtainable from a trace" look identical until one of them says so, and the difference between
 * them is the difference between a passing review and a review that never happened.
 *
 * Empty for a replay pair, so an ordinary review is unchanged.
 */
export function degradedLayerNotes(diff: DiffResult | null): string[] {
  const notes: string[] = [];
  if (isPixelsOnlyPair(diff)) notes.push(PIXELS_ONLY_ATTRIBUTION_NOTE);
  for (const [kind, entry] of [...DEGRADED_KIND_NOTES, ...PIXELS_ONLY_KIND_NOTES]) {
    const note = unavailableKindNote(diff, kind);
    if (note !== null) notes.push(`${entry.layer}: ${note}`);
  }
  return notes;
}

/**
 * The line a single finding earns when it explains nothing beyond its own pixels, or null.
 *
 * Per finding rather than only per pair, because a finding is what gets selected, linked, filtered
 * and pasted into a review: "no element was available for this pair" has to travel with it. Null
 * for every finding that names an element, and for every replay pair.
 */
export function pixelsOnlyFindingNote(finding: Finding | null | undefined): string | null {
  return isPixelsOnlyFinding(finding) ? PIXELS_ONLY_FINDING_NOTE : null;
}

/**
 * Run-warning kinds the rail renders as high severity.
 *
 * All of them share one property: they say the capture is not what its label claims. A HAR miss or
 * an unstable git state means a finding may be an artefact; a never-matched scenario rule or a
 * variant rule that matched nothing — or was reverted before capture (D22) — means the *screenshot*
 * is of something other than the state named above it. That is the worst thing this tool can do
 * quietly, so it is the loudest thing it says.
 */
export function isHighSeverityWarning(kind: string): boolean {
  return (
    HIGH_WARNING_KINDS.has(kind) ||
    isVariantWarningKind(kind) ||
    // Only one of the e2e kinds qualifies. A stale `e2e-map.yaml` entry means the step-id pin the
    // user wrote is not being applied, so the diff is aligning on something they did not choose —
    // the same failure as a never-matched scenario rule. Duplicate step titles and an unknown
    // revision are notices: both are ordinary, both were handled deterministically, and promoting
    // them would make the loud channel routine on every ingested run.
    isHighSeverityE2eWarningKind(kind)
  );
}

/** True for any run warning this slice's ingestion raises, whatever its severity. */
export function isE2eWarning(kind: string): boolean {
  return isE2eWarningKind(kind);
}

const HIGH_WARNING_KINDS: ReadonlySet<string> = new Set([
  'har-miss',
  'unstable-git',
  'console-error',
  'scenario-rule-unmatched',
  'mock-miss',
]);

/** Index of a run id within an ascending run list, or -1. */
export function runIndex(runs: readonly RunSummary[], runId: string | null): number {
  if (runId === null) return -1;
  return runs.findIndex((r) => r.runId === runId);
}
