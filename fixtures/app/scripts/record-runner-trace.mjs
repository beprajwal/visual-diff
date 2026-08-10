#!/usr/bin/env node
/**
 * Record `fixtures/app/traces/dashboard-runner.zip` — the one archive `@playwright/test` produces
 * and the library API cannot.
 *
 *   node scripts/record-runner-trace.mjs        (needs the network, and is run BY HAND)
 *
 * ### Why this is separate from `record-traces.mjs`, and why it is not a dependency
 *
 * There are two Playwright trace archive layouts, and a reader that assumes one silently
 * mis-parses the other:
 *
 *   library (`context.tracing.stop({ path })`)   trace.trace, trace.network, resources/…
 *   runner  (`use: { trace }`)                   test.trace  ← the runner's own hooks, fixtures,
 *                                                 test.step and expect calls
 *                                               0-trace.trace / 0-trace.network / …
 *                                               1-trace.trace / …   one prefix per BrowserContext
 *
 * Only the runner emits `test.trace`, the `N-trace.*` prefixes, the `stepId` cross-references that
 * link a library action to the `test.step` that contained it, and the `Test.hook` / `Test.fixture`
 * actions a reader has to exclude from the steps it reports. `record-traces.mjs` cannot produce any
 * of it, and a hand-built stand-in would only ever prove that the reader agrees with our guesses.
 *
 * So it is generated **out of band**: this script installs `@playwright/test` into a throwaway
 * directory under the system temp dir, runs one spec there, keeps the resulting `trace.zip`, and
 * deletes the directory. Nothing is added to any `package.json` in this repository. That matters:
 * `@playwright/test`'s postinstall downloads browsers, `fixtures/app`'s devDependencies are
 * installed by the root `npm ci` and by CI, and removing that download is exactly what made
 * `npx @beprajwal/visual-diff` a 300 kB install at v0.2.0.
 *
 * The cost of that choice is that this script is not hermetic — it needs the npm registry, and
 * possibly a browser download — which is why it is not wired into `npm test` or into
 * `npm run fixture:traces`. The archive it writes is committed; regenerating it is deliberate,
 * manual and rare, exactly like `fixture:record`.
 *
 * ### What the spec it runs is built to contain
 *
 * - `test.step` titles, including a **duplicated** one (§8's disambiguation case) and a nested one.
 * - An `expect`, which the runner records as a titled `Test.expect` action.
 * - A `beforeEach` hook, so the archive contains the `Test.hook` / `Test.fixture` infrastructure a
 *   reader must skip rather than present as steps.
 * - **Two BrowserContexts**, so the archive really does carry `0-trace.*` and `1-trace.*`. The
 *   ordinal is not creation order, which is precisely why a reader must discover prefixes by
 *   globbing `(.+)\.trace$` rather than by assuming a naming scheme.
 *
 * Flags:
 *   --out <dir>       write somewhere else (default fixtures/app/traces)
 *   --keep-project    leave the throwaway project in place, for debugging the spec
 *   --json            print the summary as JSON
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import {
  APP_DIR,
  DEFAULT_OUT,
  HAR_PATH,
  ORIGIN,
  VIEWPORT,
  closeServer,
  sanitizeArchive,
  serveStatic,
  viteBuild,
} from './record-traces.mjs';

/** Pinned: the archive records the version that wrote it, and a fixture that drifts is not a fixture. */
const PLAYWRIGHT_VERSION = '1.62.1';

/**
 * A fixed, neutral project directory rather than `mkdtemp`.
 *
 * Everything the runner writes into the archive that mentions a path — the HAR it was told to
 * replay, the output directory it wrote to — would otherwise name a random directory inside the
 * user's home or profile. `/tmp/vdiff-runner-trace` names nobody. `record-traces.mjs` refuses to
 * write an archive that still contains an absolute user path, so this is load-bearing rather than
 * cosmetic.
 */
const PROJECT_DIR = '/tmp/vdiff-runner-trace';

const OUT_NAME = 'dashboard-runner.zip';

/* ------------------------------------------------------------------ the throwaway project */

const PACKAGE_JSON = {
  name: 'vdiff-runner-trace',
  private: true,
  version: '0.0.0',
  devDependencies: { '@playwright/test': PLAYWRIGHT_VERSION },
};

/**
 * `trace: { mode: 'on', sources: false }`.
 *
 * Every `@playwright/test` trace mode otherwise forces `screenshots`, `snapshots`, `sources` and
 * `attachments` on. Sources are turned back off because they would embed this spec's own file into
 * the archive under a hash, referenced only from the `trace.stacks` member that is stripped out
 * anyway — bytes nothing reads.
 *
 * The project is named `chromium-desktop` on purpose: the project name appears **nowhere** inside
 * the archive, only in the `test-results/…-chromium-desktop` directory the runner writes to, which
 * is the fact §7 gets wrong and the reader records as a missing capability.
 */
const CONFIG_TS = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    trace: { mode: 'on', sources: false },
    browserName: 'chromium',
    viewport: { width: ${VIEWPORT.width}, height: ${VIEWPORT.height} },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  },
  projects: [{ name: 'chromium-desktop' }],
});
`;

/**
 * The spec, written out rather than committed as a file.
 *
 * It lives here because it is an *input to a recording*, not a test of this repository: nothing
 * runs it in CI, and a `.spec.ts` sitting in `fixtures/app` would be collected by every test runner
 * that walks the tree looking for one.
 *
 * The line numbers matter. A runner test title is `<path relative to testDir>:<line> › <describe> ›
 * <test>`, so the title this archive carries is decided by where `test(` lands in this string — and
 * that a line number is in the title at all is the D26 hazard the reader exists to defuse.
 */
const SPEC_TS = `import { expect, test } from '@playwright/test';

const ORIGIN = process.env.VDIFF_ORIGIN ?? '${ORIGIN}';
const EXTERNAL = /open-meteo\\.com/;
const HAR = './weather.har';

// A hook, so the archive contains the Test.hook / Test.fixture infrastructure a reader must skip.
test.beforeEach(async ({ context }) => {
  await context.routeFromHAR(HAR, { url: EXTERNAL, notFound: 'abort', update: false });
});

test.describe('weather dashboard', () => {
  test('shows saved locations and opens a forecast', async ({ browser, page }) => {
    await test.step('open the dashboard', async () => {
      await page.goto(ORIGIN + '/#/');
      await page.waitForSelector('[data-test=sparkline]');
    });

    await test.step('switch to Fahrenheit', async () => {
      await page.click('[data-test=units-f]');
      await page.waitForSelector('[data-test=app][data-units=f]');
    });

    await test.step('open a saved location', async () => {
      await page.click('[data-test=open-berlin]');
      await page.waitForSelector('[data-test=current-conditions]');
      // Nested inside its parent step, and an expect: both are titled actions in test.trace.
      await test.step('confirm the place', async () => {
        await expect(page.locator('[data-test=place-name]')).toHaveText('Berlin');
      });
    });

    // Deliberately the same title twice (e2e spec section 8: duplicate step titles inside one test
    // must be disambiguated with a stable suffix and reported once as a notice).
    await test.step('read the forecast', async () => {
      await page.waitForSelector('[data-test=chart-line]');
    });

    await test.step('read the forecast', async () => {
      await page.locator('[data-test=air-quality]').scrollIntoViewIfNeeded();
      await page.waitForSelector('[data-test=aqi-badge]');
    });

    // A second BrowserContext, which is what puts a second N-trace.* prefix in this one archive.
    await test.step('open the list in a second context', async () => {
      const second = await browser.newContext();
      await second.routeFromHAR(HAR, { url: EXTERNAL, notFound: 'abort', update: false });
      const other = await second.newPage();
      await other.goto(ORIGIN + '/#/');
      await other.waitForSelector('[data-test=sparkline]');
      await second.close();
    });
  });
});
`;

/* ------------------------------------------------------------------ helpers */

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, json: false, keepProject: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--keep-project') options.keepProject = true;
    else if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--out needs a directory');
      options.out = isAbsolute(value) ? value : resolve(process.cwd(), value);
      i += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/** Runs a command in the throwaway project, failing with its exit code rather than a stack trace. */
function run(command, args, extraEnv = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: PROJECT_DIR,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, ...extraEnv },
    });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`${command} ${args.join(' ')} exited ${code}`))));
  });
}

/** The single `trace.zip` the run produced, refusing to guess when there is more than one. */
async function findTrace() {
  const results = join(PROJECT_DIR, 'test-results');
  const dirs = (await readdir(results, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const found = [];
  for (const dir of dirs) {
    const candidate = join(results, dir.name, 'trace.zip');
    if (existsSync(candidate)) found.push({ dir: dir.name, path: candidate });
  }
  if (found.length !== 1) {
    throw new Error(`expected exactly one trace.zip under ${results}, found ${found.length}`);
  }
  return found[0];
}

/** The archive's members, so the summary can state that both layouts' hallmarks are really there. */
async function describeArchive(zipPath) {
  const { utils } = createRequire(join(APP_DIR, 'package.json'))('playwright-core/lib/coreBundle');
  const zip = new utils.ZipFile(zipPath);
  const names = await zip.entries();
  zip.close();
  const prefixes = names.flatMap((name) => {
    const match = /^(.+)\.trace$/.exec(name);
    return match === null ? [] : [match[1]];
  });
  return { entries: names.length, prefixes: prefixes.sort() };
}

/* ------------------------------------------------------------------ main */

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!existsSync(HAR_PATH)) {
    throw new Error(`no recording at ${HAR_PATH}; run \`npm run fixture:record\` first`);
  }

  await rm(PROJECT_DIR, { recursive: true, force: true });
  await mkdir(join(PROJECT_DIR, 'tests'), { recursive: true });
  await mkdir(options.out, { recursive: true });

  let server;
  try {
    await writeFile(join(PROJECT_DIR, 'package.json'), `${JSON.stringify(PACKAGE_JSON, null, 2)}\n`, 'utf8');
    await writeFile(join(PROJECT_DIR, 'playwright.config.ts'), CONFIG_TS, 'utf8');
    await writeFile(join(PROJECT_DIR, 'tests', 'dashboard.spec.ts'), SPEC_TS, 'utf8');
    await copyFile(HAR_PATH, join(PROJECT_DIR, 'weather.har'));

    await viteBuild(join(PROJECT_DIR, 'site'));
    await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel', 'error']);

    server = await serveStatic(join(PROJECT_DIR, 'site'));
    await run(process.execPath, [join(PROJECT_DIR, 'node_modules', '@playwright', 'test', 'cli.js'), 'test'], {
      VDIFF_ORIGIN: ORIGIN,
    });

    const trace = await findTrace();
    const out = join(options.out, OUT_NAME);
    await copyFile(trace.path, out);
    const sanitized = await sanitizeArchive(out);
    const described = await describeArchive(out);
    const bytes = (await stat(out)).size;
    const sha256 = createHash('sha256').update(await readFile(out)).digest('hex');

    const summary = {
      out,
      playwrightVersion: PLAYWRIGHT_VERSION,
      // The retry index and the project name live only here, in the directory name — never inside
      // the archive. Reported so the fixture's README can say so with a source.
      resultsDirectory: trace.dir,
      bytes,
      sha256,
      ...described,
      ...sanitized,
    };
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`runner trace → ${out}  ${(bytes / 1024).toFixed(1)} kB`);
      console.log(`  prefixes: ${described.prefixes.join(', ')}`);
      console.log(`  results directory: ${trace.dir}`);
    }
    return summary;
  } finally {
    if (server !== undefined) await closeServer(server);
    if (!options.keepProject) await rm(PROJECT_DIR, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
