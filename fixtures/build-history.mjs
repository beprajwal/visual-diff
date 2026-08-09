#!/usr/bin/env node
/**
 * Build the scripted fixture git history (spec §11.2).
 *
 *   node fixtures/build-history.mjs [--out <dir>] [--json] [--verify] [--dry-run] [--force]
 *
 * Copies `fixtures/storefront/` into a throwaway directory, initialises a *nested, self-contained* git
 * repository there, and lays down seven commits: the baseline plus one commit per known UI change —
 * label edit, restyle, layout shift, added step, renamed selector, introduced console error.
 *
 * Integration tests replay across this history and assert on the resulting findings; it doubles as
 * the demo and as manual QA.
 *
 * Two things this script must never do, both enforced below rather than merely intended:
 *
 *   1. Touch the visual-diff repository's own git history. Every git call runs with `GIT_DIR` and
 *      `GIT_WORK_TREE` pinned at the throwaway directory, so git cannot walk up and find the outer
 *      repository even if the working directory were wrong.
 *   2. Delete anything the caller did not mean to delete. The output directory has to be the
 *      default scratch path, somewhere under the OS temp directory, or explicitly `--force`d.
 *
 * Commit timestamps and identities are fixed, so a given fixture tree always produces the same
 * SHAs. That makes a failing integration test reproducible and lets a dep cache survive rebuilds.
 */

import { execFile } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURES_DIR = HERE;
/**
 * The slice-1 storefront (spec §11.2), which lives at `fixtures/storefront/`. `fixtures/app/` is
 * the slice-2 weather dashboard (api-mocking spec §9) and is a different fixture with a different
 * job: this history is about *code* change across revisions, that one is about *network* change
 * across scenarios.
 */
export const APP_DIR = join(HERE, 'storefront');
export const COMMITS_DIR = join(HERE, 'commits');
/** Throwaway build location, ignored by fixtures/.gitignore. */
export const DEFAULT_OUT = join(HERE, '.tmp', 'checkout-history');

export const BRANCH = 'main';
export const FLOW_PATH = '.visual-diff/flows/checkout.yaml';

export const BASE_COMMIT = {
  name: 'base',
  change: 'baseline',
  message: 'Fixture storefront: cart and payment',
  expect: 'The point every other commit is diffed against.',
};

/** The §11.2 sequence, in order. Verification pins this. */
export const CHANGE_SEQUENCE = [
  'baseline',
  'label edit',
  'restyle',
  'layout shift',
  'added step',
  'renamed selector',
  'introduced console error',
];

/** Every commit shares this identity so SHAs do not depend on the machine. */
const IDENTITY = {
  GIT_AUTHOR_NAME: 'visual-diff fixtures',
  GIT_AUTHOR_EMAIL: 'fixtures@visual-diff.invalid',
  GIT_COMMITTER_NAME: 'visual-diff fixtures',
  GIT_COMMITTER_EMAIL: 'fixtures@visual-diff.invalid',
};

/** 2026-01-01T00:00:00Z, one minute per commit. */
const EPOCH_SECONDS = Math.floor(Date.UTC(2026, 0, 1) / 1000);

const COPY_EXCLUDE = new Set(['node_modules', 'dist', '.tmp', '.git']);

/* ------------------------------------------------------------------ paths */

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(dir, prefix = '') {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const entry of [...entries].sort((x, y) => (x.name < y.name ? -1 : 1))) {
    if (COPY_EXCLUDE.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

/* ------------------------------------------------------------------ git plumbing */

function gitEnv(out, extra = {}) {
  return {
    ...process.env,
    GIT_DIR: join(out, '.git'),
    GIT_WORK_TREE: out,
    // Neutralise user and machine configuration: hooks, templates, signing, aliases.
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_TERMINAL_PROMPT: '0',
    TZ: 'UTC',
    ...IDENTITY,
    ...extra,
  };
}

async function git(out, args, extraEnv = {}) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: out,
    env: gitEnv(out, extraEnv),
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/**
 * `git init` is the one call that must not run with GIT_DIR pre-set, so it gets its own environment
 * and an immediate assertion that the repository landed exactly where we asked. If this assertion
 * ever fires, every later `git commit` would have gone into the surrounding repository.
 */
async function gitInit(out) {
  await execFileAsync('git', ['-c', `init.defaultBranch=${BRANCH}`, 'init', '--quiet', out], {
    cwd: HERE,
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, TZ: 'UTC' },
  });

  const toplevel = (await git(out, ['rev-parse', '--show-toplevel'])).trim();
  const [resolved, expected] = await Promise.all([realpath(toplevel), realpath(out)]);
  if (resolved !== expected) {
    throw new Error(
      `refusing to continue: git resolved to '${resolved}' instead of '${expected}'`,
    );
  }
}

async function commitAll(out, message, order) {
  await git(out, ['add', '--all']);
  const stamp = `${EPOCH_SECONDS + order * 60} +0000`;
  await git(
    out,
    ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '--message', message],
    { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
  );
  return (await git(out, ['rev-parse', 'HEAD'])).trim();
}

/** Read a path out of the built history at a given commit. */
export async function showAt(dir, sha, path) {
  return git(dir, ['show', `${sha}:${path}`]);
}

/* ------------------------------------------------------------------ fixture inputs */

/** Read `fixtures/commits/*` into an ordered list of overlay plans. */
export async function loadCommitPlans() {
  const names = (await readdir(COMMITS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (names.length === 0) throw new Error(`no commit directories under ${COMMITS_DIR}`);

  const plans = [];
  for (const name of names) {
    const dir = join(COMMITS_DIR, name);
    const meta = JSON.parse(await readFile(join(dir, 'commit.json'), 'utf8'));
    if (!meta.message) throw new Error(`${name}/commit.json is missing "message"`);
    if (!meta.change) throw new Error(`${name}/commit.json is missing "change"`);

    const filesDir = join(dir, 'files');
    const files = await listFilesRecursive(filesDir);
    const deletions = meta.delete ?? [];
    if (files.length === 0 && deletions.length === 0) {
      throw new Error(`${name} changes nothing: no files/ overlay and no "delete" entries`);
    }

    plans.push({
      name,
      dir,
      filesDir,
      files,
      delete: deletions,
      message: meta.message,
      change: meta.change,
      expect: meta.expect ?? '',
    });
  }
  return plans;
}

async function applyOverlay(plan, out) {
  for (const rel of plan.files) {
    const target = join(out, rel);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(plan.filesDir, rel), target);
  }
  for (const rel of plan.delete) {
    await rm(join(out, rel), { recursive: true, force: true });
  }
}

async function copyApp(out) {
  await cp(APP_DIR, out, {
    recursive: true,
    filter: (src) => {
      const rel = relative(APP_DIR, src);
      return rel === '' || !COPY_EXCLUDE.has(rel.split(sep)[0]);
    },
  });
}

/* ------------------------------------------------------------------ safety */

/**
 * The build wipes its output directory, so it must be certain the directory is a scratch one.
 * Anything else needs `--force` from a human who typed the path.
 */
async function assertSafeTarget(out, { force = false } = {}) {
  const repoRoot = resolve(HERE, '..');

  if (out === repoRoot || out === HERE || out === APP_DIR || out === COMMITS_DIR) {
    throw new Error(`refusing to build the fixture history into '${out}'`);
  }
  if (isInside(out, repoRoot)) {
    throw new Error(`refusing to build the fixture history into '${out}': it contains the repo`);
  }
  if (isInside(APP_DIR, out) || isInside(COMMITS_DIR, out)) {
    throw new Error(`refusing to build the fixture history inside the fixture sources: '${out}'`);
  }

  const scratchRoot = join(HERE, '.tmp');
  const tempRoot = await realpath(tmpdir()).catch(() => tmpdir());
  const isScratch =
    isInside(scratchRoot, out) || isInside(tempRoot, out) || isInside(tmpdir(), out);

  if (!force && !isScratch && (await exists(out))) {
    throw new Error(
      `'${out}' already exists and is not a scratch directory. Pass --force to overwrite it.`,
    );
  }
}

/* ------------------------------------------------------------------ build */

/**
 * @param {{ out?: string, force?: boolean, dryRun?: boolean }} [options]
 *   `dryRun` materialises the working tree of every commit in sequence without running git — enough
 *   to prove the overlays apply cleanly and cumulatively, not enough to produce SHAs.
 * @returns {Promise<{ dir: string, branch: string, dryRun: boolean, commits: Array<object> }>}
 */
export async function buildFixtureHistory(options = {}) {
  const out = resolve(options.out ?? DEFAULT_OUT);
  const dryRun = options.dryRun === true;

  await assertSafeTarget(out, options);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await copyApp(out);

  const plans = await loadCommitPlans();
  const baseFiles = await listFilesRecursive(out);
  const commits = [];

  if (!dryRun) await gitInit(out);

  commits.push({
    order: 0,
    name: BASE_COMMIT.name,
    change: BASE_COMMIT.change,
    message: BASE_COMMIT.message,
    expect: BASE_COMMIT.expect,
    files: baseFiles,
    sha: dryRun ? null : await commitAll(out, BASE_COMMIT.message, 0),
  });

  for (const [index, plan] of plans.entries()) {
    await applyOverlay(plan, out);
    commits.push({
      order: index + 1,
      name: plan.name,
      change: plan.change,
      message: plan.message,
      expect: plan.expect,
      files: plan.files,
      sha: dryRun ? null : await commitAll(out, plan.message, index + 1),
    });
  }

  return { dir: out, branch: BRANCH, dryRun, commits };
}

/* ------------------------------------------------------------------ verification */

/**
 * What each commit must be true of the working tree *as of that commit*. Cumulative on purpose:
 * an overlay that forgets to carry an earlier change forward fails here rather than silently
 * producing a diff that contradicts the test the commit exists for.
 *
 * @type {Record<string, (read: (path: string) => string, check: (ok: boolean, why: string) => void) => void>}
 */
export const COMMIT_EXPECTATIONS = {
  base(read, check) {
    check(read('src/views.js').includes('>Pay</button>'), 'baseline labels the CTA "Pay"');
    check(read('src/views.js').includes('<button id="pay"'), 'baseline addresses the CTA by id');
    check(read(FLOW_PATH).includes('click: "#pay"'), 'baseline flow clicks "#pay"');
    check(read(FLOW_PATH).includes('- id: pay-click'), 'baseline flow has the pay-click step');
    check(!read(FLOW_PATH).includes('id: receipt'), 'baseline flow has no receipt step');
    check(
      read(FLOW_PATH).includes('mask: ["[data-test=order-date]"]'),
      'baseline flow masks the order date, the one non-deterministic element',
    );
  },

  '01-label-edit'(read, check) {
    check(read('src/views.js').includes('>Pay now</button>'), 'commit 01 relabels the CTA');
    check(!read('src/views.js').includes('>Pay</button>'), 'commit 01 leaves no "Pay" label behind');
    check(
      read('src/styles.css').includes('background: var(--accent)'),
      'commit 01 changes text only: the button styling is untouched',
    );
  },

  '02-restyle'(read, check) {
    const css = read('src/styles.css');
    check(css.includes('background: #3b3bb0'), 'commit 02 recolours .btn-primary');
    check(css.includes('border-radius: 999px'), 'commit 02 rounds .btn-primary');
    check(
      css.includes('margin-top: 16px;\n  padding: 12px 16px'),
      'commit 02 moves nothing: the summary margin is still 16px',
    );
    check(read('src/views.js').includes('>Pay now</button>'), 'commit 02 keeps the commit 01 label');
  },

  '03-layout-shift'(read, check) {
    const css = read('src/styles.css');
    check(css.includes('margin-top: 56px'), 'commit 03 pushes the summary down 40px');
    check(css.includes('background: #3b3bb0'), 'commit 03 keeps the commit 02 restyle');
    check(
      !css.includes('margin-top: 16px;\n  padding: 12px 16px'),
      'commit 03 replaces the old summary margin rather than adding a second one',
    );
  },

  '04-added-step'(read, check) {
    const views = read('src/views.js');
    check(views.includes('data-test="place-order"'), 'commit 04 adds the Place order button');
    check(views.includes('data-test="receipt"'), 'commit 04 adds the receipt screen');
    check(views.includes('>Pay now</button>'), 'commit 04 keeps the commit 01 label');
    check(
      read('src/main.js').includes("'place-order'()"),
      'commit 04 wires the Place order action',
    );
    const flow = read(FLOW_PATH);
    check(flow.includes('- id: receipt'), 'commit 04 adds the receipt step to the flow');
    check(flow.includes('click: "[data-test=place-order]"'), 'the receipt step clicks Place order');
    check(flow.includes('click: "#pay"'), 'commit 04 has not renamed the pay selector yet');
  },

  '05-renamed-selector'(read, check) {
    const views = read('src/views.js');
    check(views.includes('<button data-test="pay"'), 'commit 05 moves the CTA to a data-test attr');
    check(!views.includes('<button id="pay"'), 'commit 05 drops the CTA id');
    check(views.includes('data-test="receipt"'), 'commit 05 keeps the commit 04 receipt screen');
    const flow = read(FLOW_PATH);
    check(flow.includes('click: "[data-test=pay]"'), 'commit 05 flow clicks the new selector');
    check(
      flow.includes('- id: pay-click'),
      'commit 05 keeps the pay-click step id — renaming it would turn the drift signal into a ' +
        'removed/added pair (spec D4)',
    );
  },

  '06-console-error'(read, check) {
    check(
      read('src/main.js').includes("import { trackConversion } from './analytics.js'"),
      'commit 06 wires the analytics shim in',
    );
    check(
      read('src/analytics.js').includes('console.error('),
      'commit 06 introduces a console error',
    );
    check(
      read('src/views.js').includes('<button data-test="pay"'),
      'commit 06 keeps the commit 05 selector rename',
    );
  },
};

function collect() {
  const failures = [];
  return {
    failures,
    check(ok, why) {
      if (!ok) failures.push(why);
    },
  };
}

/**
 * Verify the fixture sources alone — no build, no git, no browser. Replays the overlays in memory
 * and runs `COMMIT_EXPECTATIONS` against each intermediate tree.
 */
export async function verifyOverlaySources() {
  const { failures, check } = collect();
  const plans = await loadCommitPlans();

  const changes = ['baseline', ...plans.map((plan) => plan.change)];
  if (changes.join(' | ') !== CHANGE_SEQUENCE.join(' | ')) {
    check(false, `commit sequence is ${changes.join(', ')}, expected ${CHANGE_SEQUENCE.join(', ')}`);
  }

  /** @type {Map<string, string>} */
  const tree = new Map();
  for (const rel of await listFilesRecursive(APP_DIR)) {
    tree.set(rel, await readFile(join(APP_DIR, rel), 'utf8'));
  }

  const read = (path) => {
    const content = tree.get(path);
    if (content === undefined) throw new Error(`fixture tree has no '${path}'`);
    return content;
  };

  const runExpectations = (name) => {
    const expectation = COMMIT_EXPECTATIONS[name];
    if (!expectation) {
      check(false, `no expectations declared for commit '${name}'`);
      return;
    }
    expectation(read, (ok, why) => check(ok, `${name}: ${why}`));
  };

  runExpectations('base');

  for (const plan of plans) {
    for (const rel of plan.files) {
      tree.set(rel, await readFile(join(plan.filesDir, rel), 'utf8'));
    }
    for (const rel of plan.delete) tree.delete(rel);
    runExpectations(plan.name);
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Verify a built history through git: the tree is clean, every commit is reachable, and — the part
 * D4 depends on — every revision hands its own flow spec back out of `git show`.
 */
export async function verifyFixtureHistory(result) {
  const sources = await verifyOverlaySources();
  const { failures, check } = collect();
  failures.push(...sources.failures);

  const { dir, commits } = result;

  check(commits.length === 7, `expected 7 commits (baseline + 6 changes), got ${commits.length}`);
  check(
    commits.map((commit) => commit.change).join(' | ') === CHANGE_SEQUENCE.join(' | '),
    `unexpected change sequence: ${commits.map((commit) => commit.change).join(', ')}`,
  );

  if (result.dryRun) return { ok: failures.length === 0, failures };

  const status = await git(dir, ['status', '--porcelain']);
  check(status.trim() === '', `the built repository has uncommitted changes:\n${status}`);

  const log = (await git(dir, ['log', '--format=%H %s'])).trim().split('\n').reverse();
  check(log.length === commits.length, `git log has ${log.length} commits, built ${commits.length}`);

  for (const commit of commits) {
    check(/^[0-9a-f]{40}$/.test(commit.sha ?? ''), `commit '${commit.name}' has no sha`);

    // D4: a revision must be able to hand its own flow spec back out of git history.
    let flow;
    try {
      flow = await showAt(dir, commit.sha, FLOW_PATH);
    } catch {
      check(false, `${commit.name}: ${FLOW_PATH} is not readable at ${commit.sha}`);
      continue;
    }
    check(flow.includes('flow: checkout'), `${commit.name}: flow at ${commit.sha} is not checkout`);

    const cache = new Map([[FLOW_PATH, flow]]);
    const expectation = COMMIT_EXPECTATIONS[commit.name];
    if (!expectation) continue;

    const paths = ['src/views.js', 'src/styles.css', 'src/main.js', 'src/analytics.js'];
    for (const path of paths) {
      try {
        cache.set(path, await showAt(dir, commit.sha, path));
      } catch {
        /* not every file exists at every revision; `read` reports it if an expectation wants it */
      }
    }

    expectation(
      (path) => {
        const content = cache.get(path);
        if (content === undefined) throw new Error(`'${path}' does not exist at ${commit.sha}`);
        return content;
      },
      (ok, why) => check(ok, `${commit.name} @ ${commit.sha.slice(0, 7)}: ${why}`),
    );
  }

  return { ok: failures.length === 0, failures };
}

/* ------------------------------------------------------------------ cli */

function parseArgs(argv) {
  const options = { json: false, verify: false, dryRun: false, force: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') options.out = argv[++i];
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else if (arg === '--json') options.json = true;
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--verify-sources') options.verifySourcesOnly = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown flag '${arg}'`);
  }
  return options;
}

const USAGE = `Usage: node fixtures/build-history.mjs [options]

  --out <dir>        where to build (default: fixtures/.tmp/checkout-history)
  --json             print the result as JSON
  --verify           assert the built history matches spec §11.2
  --verify-sources   check fixtures/storefront + fixtures/commits only; builds nothing, no git
  --dry-run          apply the overlays without running git
  --force            allow a non-scratch output directory to be overwritten
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (options.verifySourcesOnly) {
    const verification = await verifyOverlaySources();
    if (options.json) process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
    else {
      for (const failure of verification.failures) process.stderr.write(`  FAIL ${failure}\n`);
      process.stdout.write(
        verification.ok ? 'sources: ok\n' : `sources: ${verification.failures.length} failure(s)\n`,
      );
    }
    if (!verification.ok) process.exitCode = 1;
    return;
  }

  const result = await buildFixtureHistory(options);
  const verification = options.verify ? await verifyFixtureHistory(result) : null;

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...result, verification }, null, 2)}\n`);
  } else {
    process.stdout.write(`fixture history: ${result.dir}${result.dryRun ? ' (dry run)' : ''}\n`);
    for (const commit of result.commits) {
      const sha = commit.sha ? commit.sha.slice(0, 7) : '-------';
      process.stdout.write(`  ${sha}  ${String(commit.change).padEnd(26)} ${commit.message}\n`);
    }
    if (verification) {
      for (const failure of verification.failures) process.stderr.write(`  FAIL ${failure}\n`);
      process.stdout.write(
        verification.ok ? 'verify: ok\n' : `verify: ${verification.failures.length} failure(s)\n`,
      );
    }
  }

  if (verification && !verification.ok) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) await main();
