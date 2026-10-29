/**
 * Which flows a set of changed files reaches (selection spec §3).
 *
 * The answer is built from four kinds of evidence, each named in the result so the step summary
 * can say *why* a flow replays: the flow's own file changed; a scenario or fixture it depends on
 * changed; a file matched one of its `covers:` globs; or a changed source file is imported, through
 * any number of hops, by a page one of its routes visits. Some changes answer for every flow at
 * once (D59) and short-circuit the rest.
 *
 * Nothing here decides anything about the run. The result names flows; the action replays them.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { parseFlowFile } from '../flow/index.js';
import { scenariosDir } from '../mocking/index.js';
import { globMatches } from '../scenario/index.js';
import { paths } from '../store/index.js';
import type { SelectConfig } from '../types.js';
import { buildImportGraph, filesReaching, readSources, toPosix, type ImportGraph, type SourceMap } from './graph.js';
import { flowRoutes, pageForRoute, routerFor, type Route, type Router } from './routes.js';

export type SelectionMode = 'all' | 'some' | 'none';

export interface SelectReason {
  /** The flow's own spec changed, or is new. */
  changed: boolean;
  /** Scenarios the flow is served by that changed. */
  scenarios: string[];
  /** Files under `.visual-diff/` the flow or its scenario names that changed. */
  fixtures: string[];
  /** `covers:` globs a changed file matched. */
  covers: string[];
  /** Route pattern -> the changed files that reach the page answering it. */
  routes: Record<string, string[]>;
}

export interface FlowSelection {
  mode: SelectionMode;
  /** The flows to replay, sorted. Every CI flow when `mode` is `all`. */
  flows: string[];
  /** Why every flow replays, when it does. */
  everything: string | null;
  /** Per replayed flow, what reached it. Empty when `everything` is set. */
  reasons: Record<string, SelectReason>;
  /** Flows reached but declaring `ci: false`: reported for a local replay, never run here. */
  skipped: Record<string, SelectReason>;
  /** Changed source no flow reaches. The gap the summary shows a reviewer. */
  unattributed: string[];
  warnings: string[];
}

export interface SelectRequest {
  /** Absolute project root: the directory holding `.visual-diff/`. */
  root: string;
  /** The project's `select:` block. Absent, every flow replays and the result says so. */
  config: SelectConfig | undefined;
  /** Repo-relative paths, as `git diff --name-only` prints them. */
  changed: readonly string[];
  /** A reason to replay everything that the caller already knows: a label on the pull request. */
  all?: string;
}

/** Files that define what a replay means. A change to one is a change to every flow. */
const HARNESS = [
  '.visual-diff/config.yaml',
  '.github/workflows/visual-diff.yml',
  '.github/workflows/visual-diff-baseline.yml',
] as const;

const VISUAL_DIFF = '.visual-diff/';

interface FlowFacts {
  name: string;
  ci: boolean;
  scenario: string | null;
  covers: string[];
  routes: Route[];
  /** The spec's text, for naming the files under `.visual-diff/` it uploads. */
  text: string;
}

async function readFlows(root: string, basePath: string | undefined, warnings: string[]): Promise<FlowFacts[]> {
  const directory = paths.flowsDir(root);
  if (!existsSync(directory)) return [];
  const flows: FlowFacts[] = [];
  for (const entry of readdirSync(directory).sort()) {
    if (!entry.endsWith('.yaml')) continue;
    const name = entry.slice(0, -'.yaml'.length);
    const file = path.join(directory, entry);
    const text = readFileSync(file, 'utf8');
    const parsed = await parseFlowFile(file);
    if (!parsed.ok) {
      // Still a flow: a change that reaches it by name should replay it, and `vdiff run` will say
      // what is wrong with it. It just has no routes to be reached through.
      warnings.push(`flow '${name}' did not parse, so it is reached by name only — vdiff flow check ${name}`);
      flows.push({ name, ci: true, scenario: null, covers: [], routes: [], text });
      continue;
    }
    const spec = parsed.value;
    flows.push({
      name,
      ci: spec.ci !== false,
      scenario: spec.scenario ?? null,
      covers: spec.covers ?? [],
      routes: flowRoutes(spec, basePath),
      text,
    });
  }
  return flows;
}

function scenarioText(root: string, name: string): string {
  const file = path.join(scenariosDir(root), `${name}.yaml`);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

const matchesAny = (file: string, globs: readonly string[]): string | undefined =>
  globs.find((glob) => globMatches(glob, file));

function emptyReason(): SelectReason {
  return { changed: false, scenarios: [], fixtures: [], covers: [], routes: {} };
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

export async function selectFlows(request: SelectRequest): Promise<FlowSelection> {
  const { root, config } = request;
  const warnings: string[] = [];
  const changed = [...new Set(request.changed.map((file) => toPosix(file).replace(/^\.\//, '')))].filter(
    (file) => file !== '',
  );
  const flows = await readFlows(root, config?.pages.basePath, warnings);
  const reasons = new Map<string, SelectReason>();
  const unattributed: string[] = [];

  const reasonFor = (name: string): SelectReason => {
    let reason = reasons.get(name);
    if (reason === undefined) {
      reason = emptyReason();
      reasons.set(name, reason);
    }
    return reason;
  };

  const finish = (everything: string | null): FlowSelection => {
    const byName = new Map(flows.map((flow) => [flow.name, flow]));
    const selected = [...reasons.keys()].sort();
    const replayable = selected.filter((name) => byName.get(name)?.ci !== false);
    const entries = (names: string[]): Record<string, SelectReason> =>
      Object.fromEntries(names.map((name) => [name, reasons.get(name) as SelectReason]));
    const ciFlows = flows.filter((flow) => flow.ci).map((flow) => flow.name);
    return {
      mode: everything !== null ? 'all' : replayable.length > 0 ? 'some' : 'none',
      flows: everything !== null ? ciFlows : replayable,
      everything,
      reasons: everything !== null ? {} : entries(replayable),
      skipped: entries(selected.filter((name) => byName.get(name)?.ci === false)),
      unattributed,
      warnings,
    };
  };

  if (request.all !== undefined) return finish(request.all);
  if (config === undefined) {
    return finish('config.yaml has no select: section, so nothing narrows the set');
  }

  for (const file of changed) {
    if ((HARNESS as readonly string[]).includes(file)) {
      return finish(`${file} is part of the visual-diff harness`);
    }
    const glob = matchesAny(file, config.all);
    if (glob !== undefined) return finish(`${file} matches ${glob} in select.all`);
  }

  const router = routerFor(config.pages.router, config.pages.dir);
  let graph: ImportGraph | null = null;
  let sources: SourceMap | null = null;
  let pages: string[] | null = null;
  const prepare = (): { graph: ImportGraph; sources: SourceMap; pages: string[] } => {
    sources ??= readSources(root, config.sources);
    graph ??= buildImportGraph(root, sources, config.aliases);
    pages ??= [...sources.keys()].filter((file) => router.isPage(file)).sort();
    return { graph, sources, pages };
  };
  const flowsVisiting = (page: string, pageList: string[], router_: Router): FlowFacts[] =>
    flows.filter((flow) =>
      flow.routes.some((route) => pageForRoute(route, pageList, router_) === page),
    );

  const flowsDirectory = `${toPosix(path.relative(root, paths.flowsDir(root)))}/`;
  const scenariosDirectory = `${toPosix(path.relative(root, scenariosDir(root)))}/`;

  for (const file of changed) {
    if (file.startsWith(flowsDirectory) && file.endsWith('.yaml')) {
      const name = path.posix.basename(file, '.yaml');
      // A deleted flow has nothing to run; a renamed one shows up as its new name.
      if (flows.some((flow) => flow.name === name)) reasonFor(name).changed = true;
      continue;
    }
    if (file.startsWith(scenariosDirectory) && file.endsWith('.yaml')) {
      const scenario = path.posix.basename(file, '.yaml');
      for (const flow of flows) {
        if (flow.scenario === scenario) pushUnique(reasonFor(flow.name).scenarios, scenario);
      }
      continue;
    }
    if (file.startsWith(VISUAL_DIFF)) {
      // A fixture: a flow uploads it, or a scenario serves it. Both name it relative to
      // `.visual-diff/`, so the mention is looked for in their text.
      const relative = file.slice(VISUAL_DIFF.length);
      for (const flow of flows) {
        const named =
          flow.text.includes(relative) ||
          (flow.scenario !== null && scenarioText(root, flow.scenario).includes(relative));
        if (named) pushUnique(reasonFor(flow.name).fixtures, file);
      }
      continue;
    }

    let reached = false;
    for (const flow of flows) {
      const glob = matchesAny(file, flow.covers);
      if (glob === undefined) continue;
      pushUnique(reasonFor(flow.name).covers, glob);
      reached = true;
    }

    if (!config.sources.some((directory) => file.startsWith(`${directory}/`))) continue;
    if (matchesAny(file, config.ignore) !== undefined) continue;
    if (router.isServerOnly(file)) continue;

    const prepared = prepare();
    const seeds = seedsFor(file, config, prepared.sources);
    const reachedPages = [...filesReaching(prepared.graph, seeds)]
      .filter((candidate) => router.isPage(candidate))
      .sort();
    for (const page of reachedPages) {
      const route = `/${router.routeOf(page).join('/')}`;
      for (const flow of flowsVisiting(page, prepared.pages, router)) {
        reached = true;
        const routes = reasonFor(flow.name).routes;
        const files = (routes[route] ??= []);
        pushUnique(files, file);
      }
    }
    if (!reached) unattributed.push(file);
  }

  return finish(null);
}

/**
 * Where the walk starts for a changed file: the file itself, unless a `named` rule says its users
 * mention it by name (D61), in which case those users are the seeds and the file's own importers
 * — an index that imports every namespace — are not followed.
 */
function seedsFor(file: string, config: SelectConfig, sources: SourceMap): string[] {
  for (const rule of config.named) {
    const match = new RegExp(rule.files).exec(file);
    if (match === null) continue;
    const name = match[1];
    if (name === undefined) return [file];
    const mentioned = new RegExp(rule.mentioned.replaceAll('$1', escapeRegExp(name)));
    const except = rule.except === undefined ? null : new RegExp(rule.except);
    const filesRule = new RegExp(rule.files);
    return [...sources]
      .filter(
        ([candidate, text]) =>
          !filesRule.test(candidate) &&
          (except === null || !except.test(candidate)) &&
          mentioned.test(text),
      )
      .map(([candidate]) => candidate);
  }
  return [file];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function describe(reason: SelectReason): string {
  const parts: string[] = [];
  if (reason.changed) parts.push('the flow changed');
  for (const scenario of reason.scenarios) parts.push(`scenario ${scenario} changed`);
  for (const fixture of reason.fixtures) parts.push(`${path.posix.basename(fixture)} changed`);
  for (const glob of reason.covers) parts.push(`a change matches covers ${glob}`);
  for (const [route, files] of Object.entries(reason.routes)) {
    const names = files.slice(0, 3).map((file) => path.posix.basename(file));
    const more = files.length > 3 ? ` +${files.length - 3}` : '';
    parts.push(`${route} via ${names.join(', ')}${more}`);
  }
  return parts.join('; ');
}

/** The selection as markdown: the step summary CI shows, and the human output of the command. */
export function summarizeSelection(selection: FlowSelection): string[] {
  const lines = ['## Visual diff flows', ''];
  if (selection.everything !== null) {
    lines.push(`Every flow replays: ${selection.everything}.`);
  } else if (selection.mode === 'none') {
    lines.push('No flow reaches what changed, so nothing replays.');
  } else {
    const count = selection.flows.length;
    lines.push(`${count} ${count === 1 ? 'flow replays' : 'flows replay'}.`, '');
    for (const [flow, reason] of Object.entries(selection.reasons)) {
      lines.push(`- \`${flow}\`: ${describe(reason)}`);
    }
  }
  const skipped = Object.keys(selection.skipped);
  if (skipped.length > 0) {
    lines.push(
      '',
      `Reached but \`ci: false\`, so replay locally: ${skipped.map((flow) => `\`${flow}\``).join(', ')}.`,
    );
  }
  if (selection.unattributed.length > 0) {
    lines.push('', 'Changed source no flow reaches:', '');
    for (const file of selection.unattributed) lines.push(`- \`${file}\``);
  }
  return lines;
}
