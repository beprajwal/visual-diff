#!/usr/bin/env node
/**
 * Record the committed Playwright trace archives under `fixtures/app/traces/`.
 *
 *   npm run fixture:traces                    (from fixtures/app)
 *   npm run fixture:traces -w fixtures/app    (from the repository root)
 *
 * E2E mode (spec §9, test 1) ingests archives an existing suite already produced. Its tests must
 * therefore run against *real* archives — a hand-built zip only ever proves that the reader agrees
 * with whatever we assumed when we wrote it. These are the real ones: produced by Playwright's own
 * tracing recorder, driving this fixture app through the same workflows its flows already describe,
 * with the same committed HAR behind them.
 *
 * ### No new dependency, and specifically not `@playwright/test`
 *
 * Tracing is a `BrowserContext` API. `playwright-core` — which this repository already depends on,
 * and which is the whole reason `npx @beprajwal/visual-diff` is a 300 kB install rather than a
 * browser download — exposes it in full:
 *
 *   context.tracing.start({ screenshots, snapshots })   the recorder
 *   context.tracing.startChunk({ title })               one archive, with a title
 *   context.tracing.group(name) / groupEnd()            the library's analogue of `test.step`
 *   context.tracing.stopChunk({ path })                 write the zip
 *
 * `@playwright/test` would add a postinstall that downloads browsers into every install of this
 * package's workspace, which is exactly the regression removing it at v0.2.0 fixed. It buys one
 * thing the library cannot produce — the runner's `test.trace` + `N-trace.*` archive layout — and
 * that is generated out of band by `record-runner-trace.mjs`, which is run by hand and adds nothing
 * to `package.json`. See `traces/README.md`.
 *
 * ### What is deliberate about the archives this writes
 *
 * - **Two archives of the same test, against two builds.** `dashboard-baseline` and
 *   `dashboard-changed` carry the same test title, so they resolve to the same flow and pair with
 *   each other; the second is recorded against a build with three documented edits applied, so the
 *   diff between them is non-empty in pixels *and* in the DOM.
 * - **A duplicated step title.** `read the forecast` appears twice in the dashboard test, because
 *   §8 requires duplicate titles to be disambiguated with a stable suffix and reported as a notice.
 * - **An archive with no step titles at all.** `search-library` uses no `tracing.group`, which is
 *   what a library trace normally looks like: no titles anywhere, so every step id has to be
 *   synthesized from class, method and selector (D26).
 * - **A 900x600 viewport.** Screencast frames are downscaled to fit an 800x800 box, so this records
 *   `screencast-frame` events claiming 900x600 alongside JPEGs that are actually 798x532. A reader
 *   that trusts the event instead of the image header is wrong, and these archives prove it.
 *
 * ### Hermetic, and small
 *
 * The app is built once and served from a temporary directory by a static server on a fixed
 * loopback port, so every URL inside the archives is identical from one archive to the next and
 * from one regeneration to the next. Open-Meteo is served from the committed
 * `.visual-diff/flows/weather.har` with `notFound: 'abort'`, so this script never touches the
 * network — the only thing in this repository that does is `record-har.mjs`.
 *
 * Flags:
 *   --out <dir>     write somewhere else (default fixtures/app/traces)
 *   --keep-stacks   keep the client call sites — `trace.stacks` and the `stack` field on individual
 *                   events — which name the absolute path of *this* file. See `sanitizeArchive`.
 *   --json          print the summary as JSON
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = resolve(HERE, '..');
export const DEFAULT_OUT = join(APP_DIR, 'traces');
export const HAR_PATH = join(APP_DIR, '.visual-diff', 'flows', 'weather.har');

/**
 * A fixed port rather than an ephemeral one.
 *
 * Every URL the trace records — the document, every module, every stylesheet — carries the port.
 * An ephemeral port would make `dashboard-baseline` and `dashboard-changed` differ in every
 * recorded URL, turning a diff that should show three edits into a diff that shows the whole
 * network log moving. It would also make every regeneration churn the archives.
 */
export const PORT = 5245;
export const ORIGIN = `http://127.0.0.1:${PORT}`;

/**
 * The viewport, chosen to exercise the screenshot trap rather than to look good.
 *
 * Playwright downscales screencast frames to fit an 800x800 box and discards `deviceScaleFactor`,
 * so 900x600 is recorded in the `screencast-frame` event while the JPEG on disk is 798x532.
 */
export const VIEWPORT = { width: 900, height: 600 };

/** Tracing options. `sources` stays off: source files would double the archive and pin it to this machine. */
const TRACING = { screenshots: true, snapshots: true, sources: false };

/** The only origin the recording is allowed to answer for — everything else is the app's own server. */
export const EXTERNAL = /open-meteo\.com/;

/**
 * The edits that make `dashboard-changed` a different build rather than a different render.
 *
 * Applied to the *built* output rather than to `src/`, so this script never dirties the working
 * tree and can never leave a half-patched fixture behind if it fails. Each one asserts it matched
 * exactly once (`expect`), because a silently unmatched patch would produce two identical archives
 * and a diff test that passes by comparing a thing to itself.
 *
 * One of each kind, on purpose: a colour (pixels only), a radius (pixels only, different shape),
 * and a text change (pixels *and* DOM, so the snapshot half of the ingest has something to show).
 */
const PATCHES = [
  // esbuild does not normalise whitespace inside a custom property value, so the built stylesheet
  // keeps the space the source wrote. Matching the emitted text rather than a guess at it is why
  // each patch asserts its occurrence count instead of replacing whatever it happens to find.
  { file: 'css', find: '--accent: #2563eb', replace: '--accent: #c2410c', expect: 1, what: 'accent colour' },
  { file: 'css', find: '--radius: 14px', replace: '--radius: 4px', expect: 1, what: 'corner radius' },
  { file: 'js', find: 'Saved locations', replace: 'Your places', expect: 1, what: 'list heading' },
];

/* ------------------------------------------------------------------ arguments */

export function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, json: false, keepStacks: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--keep-stacks') options.keepStacks = true;
    else if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--out needs a directory');
      options.out = isAbsolute(value) ? value : resolve(process.cwd(), value);
      i += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/* ------------------------------------------------------------------ the build under test */

const require_ = createRequire(join(APP_DIR, 'package.json'));

/** Runs `vite build` in a child process, so this script does not have to hold Vite's config API stable. */
export function viteBuild(outDir) {
  const bin = join(dirname(require_.resolve('vite/package.json')), 'bin', 'vite.js');
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, [bin, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], {
      cwd: APP_DIR,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', rejectBuild);
    child.on('close', (code) => {
      if (code === 0) resolveBuild(outDir);
      else rejectBuild(new Error(`vite build exited ${code}`));
    });
  });
}

/** The single built stylesheet and the single built entry script, by extension rather than by name. */
async function builtAssets(siteDir) {
  const assets = join(siteDir, 'assets');
  const names = await readdir(assets);
  const css = names.filter((name) => name.endsWith('.css'));
  const js = names.filter((name) => name.endsWith('.js'));
  if (css.length !== 1) throw new Error(`expected exactly one built stylesheet, found ${css.length}: ${css.join(', ')}`);
  if (js.length !== 1) throw new Error(`expected exactly one built script, found ${js.length}: ${js.join(', ')}`);
  return { css: join(assets, css[0]), js: join(assets, js[0]) };
}

/** Applies `PATCHES` to a copy of the build, failing loudly when one of them stops matching. */
async function applyPatches(siteDir) {
  const files = await builtAssets(siteDir);
  const applied = [];
  for (const patch of PATCHES) {
    const target = files[patch.file];
    const before = await readFile(target, 'utf8');
    const hits = before.split(patch.find).length - 1;
    if (hits !== patch.expect) {
      throw new Error(
        `patch "${patch.what}" expected ${patch.expect} occurrence(s) of ${JSON.stringify(patch.find)} in ` +
          `${target}, found ${hits}. The build changed; update PATCHES in scripts/record-traces.mjs.`,
      );
    }
    await writeFile(target, before.split(patch.find).join(patch.replace), 'utf8');
    applied.push(`${patch.what}: ${patch.find} → ${patch.replace}`);
  }
  return applied;
}

/* ------------------------------------------------------------------ the static server */

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
]);

/**
 * Twenty lines of `node:http` rather than `vite preview`.
 *
 * The archives should record the application, not a preview server: Vite's preview injects nothing
 * but does add its own headers and a second process to shut down, and the point of a fixture is
 * that the bytes in it are explainable. Hash routing means no rewrite rule is needed — every route
 * is `index.html`.
 */
export function serveStatic(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', ORIGIN);
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = resolve(root, relative);
    // A path that escapes the root is a bug in the app, not a request worth serving.
    if (!file.startsWith(resolve(root))) {
      res.writeHead(403).end('forbidden');
      return;
    }
    readFile(file).then(
      (body) => {
        res.writeHead(200, {
          'content-type': CONTENT_TYPES.get(extname(file)) ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(body);
      },
      () => {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      },
    );
  });

  return new Promise((resolveServer, rejectServer) => {
    server.on('error', (error) => {
      rejectServer(
        error.code === 'EADDRINUSE'
          ? new Error(`port ${PORT} is already in use; the trace fixtures pin it so their URLs stay identical`)
          : error,
      );
    });
    server.listen(PORT, '127.0.0.1', () => resolveServer(server));
  });
}

export function closeServer(server) {
  return new Promise((done) => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
}

/* ------------------------------------------------------------------ the workflows */

/**
 * Test titles in the runner's own format: `<file>:<line> › <describe> › <test>`, separated by
 * U+203A. A library trace has no test concept at all — the only title it carries is the one passed
 * to `startChunk` — so writing them this way is what makes these archives exercise the same title
 * parsing a real suite's archives will.
 *
 * The `:line` is not decoration. It is the D26 hazard: inserting an import above a test renames
 * every title in the file, so a flow key that keeps the line number is removed-and-added on an
 * edit that changed nothing. The reader has to strip it, and these titles are how that is tested.
 */
const DASHBOARD_TITLE = 'weather.spec.ts:14 › weather dashboard › shows saved locations and opens a forecast';
const SEARCH_TITLE = 'weather.spec.ts:52 › weather dashboard › finds a place by name';

/**
 * The dashboard workflow: the location list, the units toggle, and a forecast.
 *
 * Mirrors the committed `locations.yaml` and `detail.yaml` flows — the same screens, the same
 * waits — so an archive and a replay run of this fixture describe the same application rather than
 * two different tours of it.
 *
 * `read the forecast` is used twice deliberately. §8 requires duplicate step titles inside one test
 * to be disambiguated with a stable suffix and reported once as a notice, and a fixture that only
 * ever contains unique titles cannot test that.
 */
async function driveDashboard(page, tracing) {
  await tracing.group('open the dashboard');
  await page.goto(`${ORIGIN}/#/`);
  await page.waitForSelector('[data-test=sparkline]');
  await tracing.groupEnd();

  await tracing.group('switch to Fahrenheit');
  await page.click('[data-test=units-f]');
  await page.waitForSelector('[data-test=app][data-units=f]');
  await tracing.groupEnd();

  await tracing.group('open a saved location');
  await page.click('[data-test=open-berlin]');
  await page.waitForSelector('[data-test=current-conditions]');
  await tracing.groupEnd();

  await tracing.group('read the forecast');
  await page.waitForSelector('[data-test=chart-line]');
  await tracing.groupEnd();

  await tracing.group('read the forecast');
  // Scrolled rather than clicked: a trace screenshot is the viewport composite at whatever offset
  // the page happens to be at, never a full-page capture, so the only way to get the lower half of
  // the detail screen into an archive is to put it in the viewport.
  await page.locator('[data-test=air-quality]').scrollIntoViewIfNeeded();
  await page.waitForSelector('[data-test=aqi-badge]');
  await tracing.groupEnd();
}

/**
 * The search workflow, with no groups at all.
 *
 * This is what a library trace ordinarily looks like: `tracing.group` is the only way to get a step
 * title without the runner, and nobody calls it. Every step id here has to be synthesized from the
 * action's class, method and selector — a selector, not a name — which is the degraded case D26
 * describes and the reader reports as a `synthesized-step-ids` notice.
 */
async function driveSearch(page) {
  await page.goto(`${ORIGIN}/#/`);
  await page.waitForSelector('[data-test=search-hint]');
  await page.fill('[data-test=search-input]', 'san');
  await page.click('[data-test=search-submit]');
  await page.waitForSelector('[data-test=search-results]');
}

/* ------------------------------------------------------------------ call sites */

/**
 * Playwright records the client call site of every API call, as absolute paths, in two places:
 * the `trace.stacks` member, and a `stack` field on individual events (`tracing.group` carries
 * one inline). For an archive committed to a public repository forever that is the home directory
 * of whoever regenerated it, and a diff on every regeneration from a different checkout.
 *
 * Both are removed and the archive repacked. Nothing reads either: `trace.stacks` is optional by
 * construction — a runner archive's `test.trace` has no `.stacks` sibling at all, and Playwright's
 * own loader handles its absence — and `stack` is an optional field the trace viewer uses to
 * populate its call tab. `traces.test.ts` asserts the repacked archives still load, through this
 * repository's reader *and* through Playwright's own `TraceModel`, so "optional" is a tested claim
 * rather than a hopeful one.
 *
 * `--keep-stacks` skips the whole step, for anyone debugging the recorder itself.
 *
 * The repack is a plain zip writer: read every entry, re-deflate it, write a local header + central
 * directory.
 */
const ABSOLUTE_PATH_PATTERNS = [/\/Users\//, /\/home\/[^/]/, /\/private\/var\//, /[A-Z]:\\Users\\/];

/**
 * Rewrites one `*.trace` member, dropping the `stack` field from every event.
 *
 * NDJSON in, NDJSON out, one JSON value per line and every other field preserved verbatim — the
 * events themselves are what the reader is being tested against, so nothing else is touched.
 */
export function stripStacks(ndjson) {
  const lines = ndjson.split('\n');
  return lines
    .map((line) => {
      if (line.trim() === '') return line;
      const event = JSON.parse(line);
      if (event.stack === undefined) return line;
      delete event.stack;
      return JSON.stringify(event);
    })
    .join('\n');
}

/** Fails if any text member still names a real filesystem path — the check the sanitising exists for. */
function assertNoAbsolutePaths(entries, zipPath) {
  for (const entry of entries) {
    // JPEGs and other binary members cannot carry a path that matters and would produce noise.
    if (entry.name.endsWith('.jpeg') || entry.name.endsWith('.png')) continue;
    const text = entry.data.toString('utf8');
    for (const pattern of ABSOLUTE_PATH_PATTERNS) {
      const found = pattern.exec(text);
      if (found !== null) {
        const at = text.slice(Math.max(0, found.index - 40), found.index + 80);
        throw new Error(`${zipPath}: ${entry.name} still contains an absolute path near: …${at}…`);
      }
    }
  }
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

/** CRC-32, by table rather than `zlib.crc32`, which needs Node 20.15 while this package declares >=20. */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Writes a zip containing `entries`, all deflated, in the order given. */
export function writeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0, deflate
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(0, 10); // mod time — zero, so the archive is a function of its contents
    local.writeUInt16LE(0x21, 12); // mod date — 1980-01-01, the DOS epoch
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    name.copy(local, 30);
    locals.push(local, deflated);

    const header = Buffer.alloc(46 + name.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(deflated.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(0, 38); // external attributes
    header.writeUInt32LE(offset, 42);
    name.copy(header, 46);
    central.push(header);

    offset += local.length + deflated.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, end]);
}

/**
 * Rewrites `zipPath` with every call site removed, using Playwright's own reader to unpack it.
 *
 * Returns what it changed, so the summary states it rather than leaving a repacked archive looking
 * like something Playwright wrote untouched.
 */
export async function sanitizeArchive(zipPath) {
  const { utils } = require_('playwright-core/lib/coreBundle');
  const zip = new utils.ZipFile(zipPath);
  const names = await zip.entries();
  const kept = [];
  const dropped = [];
  const stripped = [];
  for (const name of names) {
    if (name.endsWith('.stacks')) {
      dropped.push(name);
      continue;
    }
    const data = await zip.read(name);
    if (name.endsWith('.trace')) {
      const before = data.toString('utf8');
      const after = stripStacks(before);
      if (after !== before) stripped.push(name);
      kept.push({ name, data: Buffer.from(after, 'utf8') });
      continue;
    }
    kept.push({ name, data });
  }
  zip.close();
  assertNoAbsolutePaths(kept, zipPath);
  await writeFile(zipPath, writeZip(kept));
  return { dropped, stripped };
}

/* ------------------------------------------------------------------ recording */

/**
 * `createRequire` rather than `import`.
 *
 * `playwright-core` is CommonJS, and Node's named-export detection does not reliably surface
 * `chromium` from a dynamic `import()` of it — the destructure silently yields `undefined`, which
 * fails much later and much less clearly than this does.
 */
function playwright() {
  return require_('playwright-core');
}

async function recordSite({ siteDir, chunks }) {
  const { chromium } = playwright();
  const server = await serveStatic(siteDir);
  const browser = await chromium.launch({ headless: true });
  const written = [];
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      // Pinned so an archive recorded on one machine renders the same as on another: the locale
      // decides number and date formatting, and the timezone decides every rendered time.
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    // Scoped to Open-Meteo, exactly as `src/runner/browser.ts` scopes it: only requests that would
    // leave the machine are served from the recording, and the application is always served by the
    // application. Unscoped, the recording would also have to answer for the document and every
    // module, and `notFound: 'abort'` would abort the navigation itself.
    //
    // `notFound: 'abort'` rather than 'fallback': a request the recording does not contain must
    // fail visibly here, not quietly reach the internet and make the archive un-reproducible.
    await context.routeFromHAR(HAR_PATH, { url: EXTERNAL, notFound: 'abort', update: false });

    await context.tracing.start(TRACING);
    for (const chunk of chunks) {
      const page = await context.newPage();
      await context.tracing.startChunk({ title: chunk.title });
      await chunk.drive(page, context.tracing);
      await context.tracing.stopChunk({ path: chunk.out });
      await page.close();
      written.push(chunk);
    }
    await context.tracing.stop();
    await context.close();
  } finally {
    await browser.close();
    await closeServer(server);
  }
  return written;
}

async function summarize(file) {
  const bytes = (await stat(file)).size;
  const digest = createHash('sha256').update(await readFile(file)).digest('hex');
  return { bytes, sha256: digest };
}

/* ------------------------------------------------------------------ main */

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!existsSync(HAR_PATH)) {
    throw new Error(`no recording at ${HAR_PATH}; run \`npm run fixture:record\` first`);
  }

  const work = await mkdtemp(join(tmpdir(), 'vdiff-traces-'));
  const baselineSite = join(work, 'baseline');
  const changedSite = join(work, 'changed');
  await mkdir(options.out, { recursive: true });

  const archives = [];
  try {
    await viteBuild(baselineSite);
    await cp(baselineSite, changedSite, { recursive: true });
    const applied = await applyPatches(changedSite);

    const dashboardBaseline = join(options.out, 'dashboard-baseline.zip');
    const searchLibrary = join(options.out, 'search-library.zip');
    const dashboardChanged = join(options.out, 'dashboard-changed.zip');

    await recordSite({
      siteDir: baselineSite,
      chunks: [
        { title: DASHBOARD_TITLE, out: dashboardBaseline, drive: driveDashboard },
        { title: SEARCH_TITLE, out: searchLibrary, drive: (page) => driveSearch(page) },
      ],
    });
    await recordSite({
      siteDir: changedSite,
      chunks: [{ title: DASHBOARD_TITLE, out: dashboardChanged, drive: driveDashboard }],
    });

    for (const file of [dashboardBaseline, searchLibrary, dashboardChanged]) {
      const sanitized = options.keepStacks ? { dropped: [], stripped: [] } : await sanitizeArchive(file);
      archives.push({ file, ...sanitized, ...(await summarize(file)) });
    }

    const summary = { out: options.out, patches: applied, archives };
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`traces → ${options.out}`);
      for (const archive of archives) {
        const name = archive.file.slice(options.out.length + 1);
        const stripped = archive.dropped.length + archive.stripped.length === 0 ? '' : '  (call sites stripped)';
        console.log(`  ${name}  ${(archive.bytes / 1024).toFixed(1)} kB${stripped}`);
      }
      console.log('patched build:');
      for (const patch of applied) console.log(`  ${patch}`);
    }
    return summary;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
