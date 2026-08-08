/**
 * The slow path, end to end (spec §11.2, D3, D4, §10).
 *
 * `vdiff run --at <ref>` is the spine of the design and the one path nothing exercised whole:
 * `worktree.test.ts`, `git.test.ts` and the deps helpers each test a piece, but no test had ever
 * materialised a worktree at a historical SHA, installed that revision's dependencies into the
 * cache, spawned its dev server, replayed its *own* flow spec in a real browser, appended the run,
 * and then diffed two revisions against the change the commit is known to contain.
 *
 * This file does exactly that, across the scripted fixture history:
 *
 *   base → 01 label edit → 02 restyle → 03 layout shift → 04 added step → 05 renamed selector
 *        → 06 introduced console error
 *
 * and asserts the six consecutive diffs say what `fixtures/commits/*\/commit.json` claims they say.
 *
 * Three things it is built to prove that a unit test cannot:
 *
 *  1. **D3** — a historical ref really is replayable: worktree, dep cache, spawn, replay, append.
 *  2. **D4** — each revision replays with its *contemporaneous* flow spec, read out of git history.
 *     The working-tree spec is deliberately poisoned before the first replay with a step that
 *     matches nothing at any revision. Every run still succeeds, which is only possible if the
 *     runner never looked at it. Reading the snapshot back is the corroborating assertion; the
 *     poison is the one that cannot be satisfied by accident.
 *  3. **§10, non-negotiable** — "the tool never touches the user's working tree, index, stashes or
 *     HEAD". `git status --porcelain`, HEAD (both the resolved sha and the raw `.git/HEAD`), the
 *     stash list and the bytes of `.git/index` are captured before the first replay and compared
 *     after the last diff. The repository is deliberately left dirty *and* holding a stash entry
 *     first, so the assertion has something to lose rather than comparing two empty strings.
 *
 * Cost and gating: this installs from the network and drives headless Chromium seven times, so it
 * runs only under `npm run test:slow` (see `tests/slow/vitest.config.ts`) and never on the default
 * path. When Chromium or the npm registry is unreachable it prints a banner naming the reason and
 * skips; set `VDIFF_SLOW_REQUIRE=1` (CI) to turn that skip into a failure instead.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EXIT,
  type CliEnvelope,
  type DiffResult,
  type DomSnapshot,
  type Finding,
  type RunResult,
} from '../../src/types.js';
import { createPorts } from '../../src/cli/deps.js';
import { runCli, type CliRuntime } from '../../src/cli/main.js';
import { createBufferWriter } from '../../src/cli/output.js';
import type { DiffData } from '../../src/cli/shapes.js';
import { parseFlowSnapshot, paths } from '../../src/store/index.js';

// The fixture history builder is plain ESM JavaScript, deliberately runnable as `node`.
// @ts-expect-error -- no type declarations for a fixture script
import * as history from '../../fixtures/build-history.mjs';

/* ------------------------------------------------------------------ the fixture builder */

interface BuiltCommit {
  order: number;
  name: string;
  change: string;
  message: string;
  sha: string | null;
  files: string[];
}

interface BuildResult {
  dir: string;
  branch: string;
  dryRun: boolean;
  commits: BuiltCommit[];
}

const builder = history as {
  buildFixtureHistory(options?: { out?: string }): Promise<BuildResult>;
  verifyFixtureHistory(result: BuildResult): Promise<{ ok: boolean; failures: string[] }>;
  CHANGE_SEQUENCE: string[];
  FLOW_PATH: string;
  showAt(dir: string, sha: string, path: string): Promise<string>;
};

const FLOW = 'checkout';
/**
 * One viewport, not the spec's two. The second viewport is an independent full replay of the same
 * steps (spec §7) and would double a suite that is already minutes long without testing one more
 * line of the slow path; `runner-determinism.test.ts` and `src/runner/viewport.test.ts` cover the
 * multi-viewport pool. Overriding the viewport does not touch the *steps*, which is what D4 is
 * about.
 */
const VIEWPORT = '1280x800';

/* ------------------------------------------------------------------ preconditions */

const requireCjs = createRequire(import.meta.url);

function chromiumReason(): string | null {
  let path: string;
  try {
    const { chromium } = requireCjs('playwright') as typeof import('playwright');
    path = chromium.executablePath();
  } catch (error) {
    return `Playwright could not be loaded: ${(error as Error).message}`;
  }
  if (!existsSync(path)) {
    return `Chromium is not downloaded (expected at ${path}) — run \`vdiff install-browser\``;
  }
  return null;
}

/**
 * The slow path installs the revision's dependencies, so an offline machine cannot run this suite
 * at all. Probing the registry costs one request and turns a fifteen-minute install timeout into an
 * immediate, named skip.
 */
async function registryReason(): Promise<string | null> {
  const configured = process.env['npm_config_registry'] ?? 'https://registry.npmjs.org/';
  const base = configured.endsWith('/') ? configured : `${configured}/`;
  let url: URL;
  try {
    url = new URL('vite', base);
  } catch {
    return `npm_config_registry is not a URL: ${configured}`;
  }
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 500) return `${url.origin} answered ${response.status}`;
    return null;
  } catch (error) {
    return `${url.origin} is unreachable: ${(error as Error).message}`;
  }
}

const blockers: string[] = [];
const chromium = chromiumReason();
if (chromium !== null) blockers.push(chromium);
const registry = await registryReason();
if (registry !== null) blockers.push(registry);

const required = process.env['VDIFF_SLOW_REQUIRE'] === '1';
const ready = blockers.length === 0;

if (!ready) {
  // Loud on purpose. A silently skipped suite is indistinguishable from a passing one, and this is
  // the only test that covers `vdiff run --at`.
  const banner = [
    '',
    '='.repeat(78),
    '  SKIPPING the visual-diff slow-path end-to-end suite (tests/slow).',
    '  `vdiff run --at <ref>` — worktree, dep cache, spawn, replay — is NOT being tested.',
    ...blockers.map((reason) => `    - ${reason}`),
    '  Set VDIFF_SLOW_REQUIRE=1 to make these preconditions a failure instead of a skip.',
    '='.repeat(78),
    '',
  ].join('\n');
  process.stderr.write(`${banner}\n`);
}

const describeSlow = ready ? describe : describe.skip;

if (!ready && required) {
  describe('the slow-path suite, demanded by VDIFF_SLOW_REQUIRE=1', () => {
    it('has its preconditions met', () => {
      expect(blockers, 'the slow path cannot be exercised on this machine').toEqual([]);
    });
  });
}

/* ------------------------------------------------------------------ git probes */

const execFileAsync = promisify(execFile);

/**
 * Our own git calls, pinned at the fixture repository and neutralised the way the runner's are.
 *
 * `GIT_OPTIONAL_LOCKS=0` matters here specifically: without it a plain `git status` may refresh —
 * and therefore rewrite — `.git/index`, and the safety assertion below compares that file's bytes.
 * The probe would then be the thing that broke the invariant it is checking.
 */
function gitEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: join(dir, '.git'),
    GIT_WORK_TREE: dir,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
    TZ: 'UTC',
    GIT_AUTHOR_NAME: 'visual-diff fixtures',
    GIT_AUTHOR_EMAIL: 'fixtures@visual-diff.invalid',
    GIT_COMMITTER_NAME: 'visual-diff fixtures',
    GIT_COMMITTER_EMAIL: 'fixtures@visual-diff.invalid',
  };
}

async function git(dir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd: dir,
    env: gitEnv(dir),
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

/** Everything §10 promises not to move. */
interface WorkingTreeState {
  porcelain: string;
  head: string;
  headFile: string;
  stashList: string;
  indexDigest: string;
  indexBytes: number;
}

async function readWorkingTreeState(dir: string): Promise<WorkingTreeState> {
  // Sequential: two concurrent git processes on one repository is exactly the situation where an
  // index refresh would be tempting.
  const porcelain = await git(dir, ['status', '--porcelain']);
  const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const stashList = await git(dir, ['stash', 'list']);
  const headFile = await readFile(join(dir, '.git', 'HEAD'), 'utf8');
  const index = await readFile(join(dir, '.git', 'index'));
  return {
    porcelain,
    head,
    headFile,
    stashList,
    indexDigest: createHash('sha256').update(index).digest('hex'),
    indexBytes: index.byteLength,
  };
}

/* ------------------------------------------------------------------ the CLI, for real */

interface CliOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(cwd: string, argv: readonly string[]): Promise<CliOutcome> {
  const writer = createBufferWriter();
  const runtime: CliRuntime = {
    cwd,
    ports: createPorts(),
    version: '0.1.0',
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    waitForShutdown: async () => undefined,
    writer,
  };
  const code = await runCli(argv, runtime);
  return { code, stdout: writer.stdout(), stderr: writer.stderr() };
}

function envelopeOf<T>(outcome: CliOutcome): CliEnvelope<T> {
  const lines = outcome.stdout.trimEnd().split('\n');
  expect(lines, `--json must print exactly one object; got:\n${outcome.stdout}`).toHaveLength(1);
  return JSON.parse(lines[0] as string) as CliEnvelope<T>;
}

/* ------------------------------------------------------------------ finding helpers */

function allFindings(diff: DiffResult): Finding[] {
  return diff.steps.flatMap((step) => [
    ...step.findings,
    ...Object.values(step.viewports).flatMap((viewport) => viewport.findings),
  ]);
}

function findingsOn(diff: DiffResult, step: string): Finding[] {
  return allFindings(diff).filter((finding) => finding.step === step);
}

function changeOf(finding: Finding, prop: string): { from: unknown; to: unknown } | undefined {
  return finding.changes.find((change) => change.prop === prop);
}

/** Every finding that reports a text edit — the precise form of "nothing was relabelled". */
function textChanges(diff: DiffResult): string[] {
  return allFindings(diff)
    .filter((finding) => changeOf(finding, 'text') !== undefined)
    .map(
      (finding) =>
        `${finding.step} ${finding.element?.selector ?? '-'} ` +
        `${JSON.stringify(changeOf(finding, 'text')?.from)}->${JSON.stringify(changeOf(finding, 'text')?.to)}`,
    );
}

/** Everything about a diff a failure message needs, without dumping base64 images. */
function describeDiff(diff: DiffResult): string {
  return allFindings(diff)
    .map(
      (finding) =>
        `  ${finding.id} ${finding.severity} ${finding.kind} ${finding.step}` +
        `${finding.viewport === undefined ? '' : `@${finding.viewport}`}` +
        ` ${finding.element?.selector ?? '-'} :: ${finding.label}` +
        ` :: ${finding.changes.map((c) => `${c.prop} ${JSON.stringify(c.from)}->${JSON.stringify(c.to)}`).join(', ')}`,
    )
    .join('\n');
}

/**
 * The working-tree flow spec written before the first replay. It parses and validates — the runner
 * must reject it for the *right* reason (never reading it), not because it is malformed — and its
 * one step waits for an element that exists at no revision of the fixture app. If any historical
 * replay ever consulted the working tree, that run fails and `status` is `partial`.
 */
const POISONED_FLOW = `version: 1
flow: checkout
baseUrl: http://localhost:5173
viewports: [1280x800]
network:
  mode: "off"
steps:
  - id: poisoned-working-tree-step
    goto: /
    waitFor: "[data-test=this-element-exists-at-no-revision]"
    shoot: true
`;

/* ------------------------------------------------------------------ the run */

interface Replay {
  commit: BuiltCommit;
  run: RunResult;
}

let scratch = '';
let repo = '';
let built: BuildResult;
const replays: Replay[] = [];
const diffs = new Map<string, DiffResult>();
let before: WorkingTreeState;
let afterWork: WorkingTreeState;

function shaOf(name: string): string {
  const commit = built.commits.find((entry) => entry.name === name);
  if (commit?.sha == null) throw new Error(`the fixture history has no commit '${name}'`);
  return commit.sha;
}

function replayOf(name: string): Replay {
  const replay = replays.find((entry) => entry.commit.name === name);
  if (replay === undefined) throw new Error(`no replay for '${name}'`);
  return replay;
}

function diffOf(baseName: string, headName: string): DiffResult {
  const key = `${baseName}..${headName}`;
  const diff = diffs.get(key);
  if (diff === undefined) throw new Error(`no diff for ${key}`);
  return diff;
}

beforeAll(async () => {
  if (!ready) return;

  // The builder insists on a scratch parent it may wipe, so the repository is one level down.
  scratch = await mkdtemp(join(tmpdir(), 'vdiff-slow-'));
  repo = join(scratch, 'checkout-history');
  built = await builder.buildFixtureHistory({ out: repo });
  const verified = await builder.verifyFixtureHistory(built);
  expect(verified.failures, 'the fixture history is not what §11.2 describes').toEqual([]);

  // Give §10 something to lose: a stash entry and a dirty working tree, both of which must survive
  // seven worktree checkouts untouched.
  await writeFile(
    join(repo, 'src', 'styles.css'),
    `${await readFile(join(repo, 'src', 'styles.css'), 'utf8')}\n/* stash sentinel */\n`,
    'utf8',
  );
  await git(repo, ['stash', 'push', '--message', 'vdiff slow-path sentinel']);
  await writeFile(paths.flowFile(repo, FLOW), POISONED_FLOW, 'utf8');

  before = await readWorkingTreeState(repo);

  for (const commit of built.commits) {
    const sha = commit.sha as string;
    const outcome = await cli(repo, ['run', FLOW, '--at', sha, '--viewport', VIEWPORT, '--json']);
    const envelope = envelopeOf<RunResult>(outcome);
    expect(
      outcome.code,
      `vdiff run --at ${sha.slice(0, 7)} (${commit.change}) failed: ` +
        `${JSON.stringify(envelope.error)}\n${outcome.stderr}`,
    ).toBe(EXIT.OK);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toBeDefined();
    replays.push({ commit, run: envelope.data as RunResult });
  }

  const pairs: Array<[string, string]> = [
    ['base', '01-label-edit'],
    ['01-label-edit', '02-restyle'],
    ['02-restyle', '03-layout-shift'],
    ['03-layout-shift', '04-added-step'],
    ['04-added-step', '05-renamed-selector'],
    ['05-renamed-selector', '06-console-error'],
  ];
  for (const [baseName, headName] of pairs) {
    const base = replayOf(baseName).run.meta.runId;
    const head = replayOf(headName).run.meta.runId;
    const outcome = await cli(repo, ['diff', FLOW, base, head, '--json']);
    const envelope = envelopeOf<DiffData>(outcome);
    expect(outcome.code, `vdiff diff ${base}..${head} failed: ${outcome.stderr}`).toBe(EXIT.OK);
    expect(envelope.ok).toBe(true);
    diffs.set(`${baseName}..${headName}`, (envelope.data as DiffData).result);
  }

  afterWork = await readWorkingTreeState(repo);
});

afterAll(async () => {
  // Retried and swallowed: a just-killed Vite process may still hold a descriptor under `repo`.
  if (scratch !== '') {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
      () => undefined,
    );
  }
});

/* ------------------------------------------------------------------ D3: the slow path */

describeSlow('vdiff run --at <ref> (D3, spec §7 slow path)', () => {
  it('replays every commit of the scripted history and appends one run each', () => {
    expect(replays.map((replay) => replay.commit.change)).toEqual(builder.CHANGE_SEQUENCE);
    expect(replays.map((replay) => replay.run.meta.runId)).toEqual([
      '0000',
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
    ]);

    for (const { commit, run } of replays) {
      const where = `${commit.name} @ ${(commit.sha as string).slice(0, 7)}`;
      // A historical ref is never the working tree, so it is always the spawn path.
      expect(run.meta.mode, `${where}: expected the spawn path`).toBe('spawn');
      expect(run.meta.revision.sha, `${where}: replayed the wrong revision`).toBe(commit.sha);
      expect(run.meta.revision.dirty, `${where}: a checked-out sha is never dirty`).toBe(false);
      expect(run.meta.viewports).toEqual([VIEWPORT]);
      expect(run.meta.network).toBe('off');
      expect(run.meta.status, `${where}: ${JSON.stringify(run.meta.failedSteps)}`).toBe('ok');
      expect(run.meta.failedSteps).toEqual([]);
      expect(run.steps.length).toBeGreaterThanOrEqual(4);
      for (const step of run.steps) {
        expect(step.status, `${where}: step ${step.id}`).toBe('ok');
      }
    }
  });

  it('captures a real screenshot and DOM per shot step, keyed by step id (spec §6)', async () => {
    for (const { commit, run } of replays) {
      const shotSteps = run.steps.filter((step) => step.shoot);
      expect(shotSteps.length, `${commit.name} shoots nothing`).toBeGreaterThan(0);
      for (const step of shotSteps) {
        const shot = step.viewports[VIEWPORT];
        expect(shot, `${commit.name}: ${step.id} has no ${VIEWPORT} shot`).toBeDefined();
        // Directories are named by step id, never by ordinal (spec §6).
        expect(shot?.screenshot).toBe(`steps/${step.id}/${VIEWPORT}/screenshot.png`);
        const png = await readFile(join(run.runDir, shot?.screenshot as string));
        expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(shot?.nodeCount).toBeGreaterThan(10);
      }
    }
  });

  it('serves the revision from a worktree, not from the working tree (the whole point of D3)', async () => {
    // The working tree sits at commit 06, where the CTA is `data-test="pay"` and a receipt screen
    // exists. If the dev server had ever been pointed at it instead of at a detached worktree, the
    // baseline run's cart DOM would carry the *new* markup. It carries the old markup instead, so
    // the bytes the browser rendered came out of `cache/worktrees/<sha>`.
    const cartDom = async (name: string): Promise<DomSnapshot> =>
      JSON.parse(
        await readFile(join(replayOf(name).run.runDir, `steps/cart/${VIEWPORT}/dom.json`), 'utf8'),
      ) as DomSnapshot;

    const baseline = await cartDom('base');
    const oldCta = baseline.nodes.find((node) => node.attrs.id === 'pay');
    expect(oldCta, 'the baseline revision addresses the CTA by id').toBeDefined();
    expect(oldCta?.text?.trim()).toBe('Pay');
    expect(baseline.nodes.some((node) => node.testId === 'pay')).toBe(false);

    const latest = await cartDom('06-console-error');
    const newCta = latest.nodes.find((node) => node.testId === 'pay');
    expect(newCta, 'the latest revision addresses the CTA by data-test').toBeDefined();
    expect(newCta?.text?.trim()).toBe('Pay now');
    expect(latest.nodes.some((node) => node.attrs.id === 'pay')).toBe(false);
  });

  it('installs into the lockfile-keyed dep cache once and reuses it for every revision', async () => {
    const cacheRoot = paths.depsCacheRoot(repo);
    const entries = (await readdir(cacheRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    // Every commit ships the same package.json, so the cache key is the same for all seven — one
    // install, six cache hits. A second entry would mean the key is not the lockfile.
    expect(entries, `dep cache should hold one entry, holds: ${entries.join(', ')}`).toHaveLength(1);
    const entry = join(cacheRoot, entries[0] as string);
    expect(existsSync(join(entry, 'node_modules')), 'the cache entry has no node_modules').toBe(true);
    expect(existsSync(join(entry, 'vite.config.js')), 'installs happen in the cache, not the worktree').toBe(false);

    const marker = JSON.parse(await readFile(join(entry, '.vdiff-deps.json'), 'utf8')) as {
      lockfile: string;
      hash: string;
    };
    // The fixture ships no lockfile on purpose, so `package.json` is the documented last resort.
    expect(marker.lockfile).toBe('package.json');
    expect(marker.hash).toBe(entries[0]);
  });

  it('tears the worktrees back down and leaves git with none registered (spec §7, §10)', async () => {
    const worktrees = paths.worktreesRoot(repo);
    const left = existsSync(worktrees) ? await readdir(worktrees) : [];
    expect(left, `worktrees were left behind: ${left.join(', ')}`).toEqual([]);

    const registered = (await git(repo, ['worktree', 'list', '--porcelain']))
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim());
    // Only the main working tree, and it is still the repository root.
    expect(registered).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ D4 */

describeSlow('D4 — each revision replays with its contemporaneous flow spec', () => {
  it('snapshots the spec read out of git history at that sha, not the one on disk', async () => {
    for (const { commit, run } of replays) {
      const sha = commit.sha as string;
      const fromHistory = parseFlowSnapshot(await builder.showAt(repo, sha, builder.FLOW_PATH));
      const executed = parseFlowSnapshot(
        await readFile(join(run.runDir, 'flow.snapshot.yaml'), 'utf8'),
      );
      expect(
        executed.steps.map((step) => step.id),
        `${commit.name}: replayed a different step list than ${sha.slice(0, 7)} contains`,
      ).toEqual(fromHistory.steps.map((step) => step.id));
      expect(
        executed.steps.map((step) => (step as { click?: string }).click ?? null),
        `${commit.name}: replayed different selectors than ${sha.slice(0, 7)} contains`,
      ).toEqual(fromHistory.steps.map((step) => (step as { click?: string }).click ?? null));
    }
  });

  it('reads the historical selector rename, so old and new revisions use different selectors', async () => {
    const clickOf = async (name: string): Promise<string | undefined> => {
      const snapshot = parseFlowSnapshot(
        await readFile(join(replayOf(name).run.runDir, 'flow.snapshot.yaml'), 'utf8'),
      );
      const step = snapshot.steps.find((entry) => entry.id === 'pay-click');
      return (step as { click?: string } | undefined)?.click;
    };

    // The one commit whose whole purpose is D4 drift.
    expect(await clickOf('04-added-step')).toBe('#pay');
    expect(await clickOf('05-renamed-selector')).toBe('[data-test=pay]');
    expect(await clickOf('base')).toBe('#pay');

    // The baseline has no receipt step; the current tree's committed spec does.
    const baseline = parseFlowSnapshot(
      await readFile(join(replayOf('base').run.runDir, 'flow.snapshot.yaml'), 'utf8'),
    );
    expect(baseline.steps.map((step) => step.id)).toEqual([
      'cart',
      'pay-click',
      'pay-form',
      'fill-card',
    ]);
  });

  it('never reads the working-tree spec — it was poisoned before the first replay', async () => {
    // Still exactly as the test left it: nothing rewrote it, and nothing repaired it.
    expect(await readFile(paths.flowFile(repo, FLOW), 'utf8')).toBe(POISONED_FLOW);

    // And no run executed it. A single consultation of the working tree would have produced a
    // `poisoned-working-tree-step` step and a `partial` run.
    for (const { commit, run } of replays) {
      expect(
        run.steps.map((step) => step.id),
        `${commit.name} executed the working-tree spec`,
      ).not.toContain('poisoned-working-tree-step');
    }
  });
});

/* ------------------------------------------------------------------ the six known changes */

describeSlow('the diff across the scripted history (spec §11.2)', () => {
  it('commit 01 (label edit): a content finding on the cart CTA', () => {
    const diff = diffOf('base', '01-label-edit');
    expect(diff.flowDiff.map((entry) => entry.status)).toEqual([
      'matched',
      'matched',
      'matched',
      'matched',
    ]);

    const content = findingsOn(diff, 'cart').filter((finding) => finding.kind === 'content');
    expect(content, `no content finding on cart:\n${describeDiff(diff)}`).not.toHaveLength(0);

    const relabel = content.find((finding) => changeOf(finding, 'text')?.to === 'Pay now');
    expect(relabel, `no "Pay" -> "Pay now" finding:\n${describeDiff(diff)}`).toBeDefined();
    expect(changeOf(relabel as Finding, 'text')?.from).toBe('Pay');
    expect((relabel as Finding).element?.selector).toBe('#pay');
    expect((relabel as Finding).element?.role).toBe('button');

    // The CTA is wider now; the commit changes nothing else on the page.
    const layout = findingsOn(diff, 'cart').filter((finding) => finding.kind === 'layout');
    const widened = layout.find((finding) => changeOf(finding, 'width') !== undefined);
    expect(widened, `no width change on the relabelled CTA:\n${describeDiff(diff)}`).toBeDefined();
  });

  it('commit 02 (restyle): style findings on the CTA, no content change', () => {
    const diff = diffOf('01-label-edit', '02-restyle');
    const style = findingsOn(diff, 'cart').filter((finding) => finding.kind === 'style');
    expect(style, `no style finding on cart:\n${describeDiff(diff)}`).not.toHaveLength(0);

    const props = new Set(style.flatMap((finding) => finding.changes.map((change) => change.prop)));
    expect([...props].sort(), `restyle props:\n${describeDiff(diff)}`).toEqual(
      expect.arrayContaining(['backgroundColor', 'borderRadius']),
    );

    const button = style.find((finding) => finding.element?.selector === '#pay');
    expect(button, `the restyle was not attributed to #pay:\n${describeDiff(diff)}`).toBeDefined();

    // Paint only. Asserted as "no text moved" rather than "zero content findings": a purely
    // pixel-level region that the DOM cannot explain is also reported as `content` ("visual
    // change"), and that fallback is not what this commit is about.
    expect(textChanges(diff), `the restyle changed text:\n${describeDiff(diff)}`).toEqual([]);
    // Nor did anything move or resize: the commit changes background, border colour and radius.
    expect(diff.summary.byKind.layout, describeDiff(diff)).toBe(0);
  });

  it('commit 03 (layout shift): layout findings, everything below the cart list moves 40px', () => {
    const diff = diffOf('02-restyle', '03-layout-shift');
    const layout = findingsOn(diff, 'cart').filter((finding) => finding.kind === 'layout');
    expect(layout, `no layout finding on cart:\n${describeDiff(diff)}`).not.toHaveLength(0);

    const moved = layout.filter((finding) => {
      const y = changeOf(finding, 'y');
      return typeof y?.from === 'number' && typeof y.to === 'number' && y.to - y.from === 40;
    });
    expect(
      moved.length,
      `expected elements to move down exactly 40px:\n${describeDiff(diff)}`,
    ).toBeGreaterThan(0);
    // A 40px shift is past the layout-shift threshold, so it is high severity, never hidden.
    expect(moved.every((finding) => finding.severity === 'high')).toBe(true);
    expect(moved.every((finding) => finding.reasons.includes('layout-shift'))).toBe(true);

    // The summary block itself is one of them, and the responsible declaration is reported too.
    expect(moved.map((finding) => finding.element?.selector)).toContain('[data-test="summary"]');
    const margin = findingsOn(diff, 'cart').find(
      (finding) => changeOf(finding, 'margin')?.to === '56px 0px 0px',
    );
    expect(margin, `the summary margin change is missing:\n${describeDiff(diff)}`).toBeDefined();
    expect(margin?.kind).toBe('style');

    // Rect deltas only: nothing was relabelled.
    expect(textChanges(diff), `the layout shift changed text:\n${describeDiff(diff)}`).toEqual([]);
  });

  it('commit 04 (added step): flowDiff gains the receipt step as added', () => {
    const diff = diffOf('03-layout-shift', '04-added-step');
    const receipt = diff.flowDiff.find((entry) => entry.id === 'receipt');
    expect(receipt, `no receipt entry:\n${JSON.stringify(diff.flowDiff, null, 2)}`).toBeDefined();
    expect(receipt?.status).toBe('added');
    expect(receipt?.baseIndex).toBeNull();
    expect(receipt?.headIndex).toBe(4);

    // Every pre-existing step keeps its id and stays matched: an insert renames nothing (spec §6).
    expect(
      diff.flowDiff.filter((entry) => entry.id !== 'receipt').map((entry) => entry.status),
    ).toEqual(['matched', 'matched', 'matched', 'matched']);
    expect(diff.summary.stepsAdded).toBe(1);
    expect(diff.summary.stepsRemoved).toBe(0);

    const structural = findingsOn(diff, 'receipt').filter(
      (finding) => finding.kind === 'structural',
    );
    expect(structural.map((finding) => finding.label)).toContain('step added');

    // The payment screen gained the Place order button.
    const placeOrder = allFindings(diff).find(
      (finding) => finding.element?.selector === '[data-test="place-order"]',
    );
    expect(placeOrder, `no finding for the new Place order button:\n${describeDiff(diff)}`).toBeDefined();
  });

  it('commit 05 (renamed selector): pay-click is spec-changed, not removed plus added', () => {
    const diff = diffOf('04-added-step', '05-renamed-selector');
    const payClick = diff.flowDiff.find((entry) => entry.id === 'pay-click');
    expect(payClick, JSON.stringify(diff.flowDiff, null, 2)).toBeDefined();
    expect(payClick?.status).toBe('spec-changed');
    expect(payClick?.detail).toContain("selector '#pay' -> '[data-test=pay]'");

    // The whole point of stable step ids (D4): no phantom add/remove pair.
    expect(diff.flowDiff.filter((entry) => entry.status === 'added')).toEqual([]);
    expect(diff.flowDiff.filter((entry) => entry.status === 'removed')).toEqual([]);
    expect(diff.summary.stepsSpecChanged).toBe(1);

    const structural = findingsOn(diff, 'pay-click').filter(
      (finding) => finding.kind === 'structural',
    );
    expect(structural.map((finding) => finding.label)).toContain(
      "step spec changed: selector '#pay' -> '[data-test=pay]'",
    );
  });

  it('commit 06 (console error): a high-severity console finding on the receipt step', () => {
    const diff = diffOf('05-renamed-selector', '06-console-error');
    const console_ = findingsOn(diff, 'receipt').filter((finding) => finding.kind === 'console');
    expect(console_, `no console finding on receipt:\n${describeDiff(diff)}`).toHaveLength(1);

    const finding = console_[0] as Finding;
    expect(finding.severity).toBe('high');
    expect(finding.label).toBe('new console error');
    expect(finding.reasons).toContain('new-console-error');
    expect(String(changeOf(finding, 'text')?.to)).toContain('analytics failed for order A-1042');
    // Step-scoped, so it carries no viewport and no region (spec §8).
    expect(finding.viewport).toBeUndefined();
    expect(finding.region).toBeUndefined();

    // And the run itself warned about it.
    const warnings = replayOf('06-console-error').run.meta.warnings;
    const consoleWarning = warnings.find((warning) => warning.kind === 'console-error');
    expect(consoleWarning, JSON.stringify(warnings)).toBeDefined();
    expect(consoleWarning?.steps).toContain('receipt');
    // The base revision had none, which is what makes the finding a regression rather than noise.
    expect(
      replayOf('05-renamed-selector').run.meta.warnings.filter(
        (warning) => warning.kind === 'console-error',
      ),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ §10 non-negotiable */

describeSlow('working-tree safety across the whole slow path (spec §10)', () => {
  it('starts from a repository that has something to lose', () => {
    // A dirty tracked file and a stash entry: comparing two empty strings would prove nothing.
    expect(before.porcelain).toContain('.visual-diff/flows/checkout.yaml');
    expect(before.stashList).toContain('vdiff slow-path sentinel');
    expect(before.head).toBe(shaOf('06-console-error'));
    expect(before.headFile.trim()).toBe('ref: refs/heads/main');
  });

  it('leaves status, HEAD, the stash list and the index byte-identical', async () => {
    const now = await readWorkingTreeState(repo);
    for (const [label, state] of [
      ['after seven historical replays', afterWork],
      ['after the diffs as well', now],
    ] as const) {
      expect(state.porcelain, `git status --porcelain moved ${label}`).toBe(before.porcelain);
      expect(state.head, `HEAD moved ${label}`).toBe(before.head);
      expect(state.headFile, `.git/HEAD moved ${label}`).toBe(before.headFile);
      expect(state.stashList, `the stash list moved ${label}`).toBe(before.stashList);
      expect(state.indexBytes, `.git/index changed size ${label}`).toBe(before.indexBytes);
      expect(state.indexDigest, `.git/index changed content ${label}`).toBe(before.indexDigest);
    }
  });

  it('keeps the stashed change restorable, and the working tree still dirty', async () => {
    // `git stash show` reads the stash commit; if the runner had dropped or applied it, this fails.
    const show = await git(repo, ['stash', 'show', '--stat', 'stash@{0}']);
    expect(show).toContain('src/styles.css');
    expect(await readFile(join(repo, 'src', 'styles.css'), 'utf8')).not.toContain('stash sentinel');
  });
});
