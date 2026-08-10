/**
 * Regenerates `fixtures/app/docs/` — the screenshots that document what this tool does.
 *
 * Run from the fixture app:  npm run showcase
 *
 * Everything here is captured by driving the real CLI, never by hand. That matters for two reasons.
 * The obvious one is that hand-collected screenshots rot the moment the UI changes. The subtler one
 * is that the determinism knobs the runner applies (frozen clock, seeded RNG, disabled animations,
 * settle gate) mean a regenerated screenshot is byte-identical unless something genuinely changed —
 * so `git status` after a re-run is itself a signal, and these images do not churn in every diff.
 *
 * The report screenshots are captured by serving the real report and driving it with Playwright,
 * because a diff tool that cannot show you its own report is not documenting anything.
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const CLI = join(APP, '..', '..', 'dist', 'cli', 'index.js');
const OUT = join(APP, 'docs', 'screenshots');
const STORE = join(APP, '.visual-diff');

/** Runs the CLI and returns its stdout, failing loudly rather than silently continuing. */
function cli(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: APP });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      if (code !== 0 && !allowFailure) {
        reject(new Error(`vdiff ${args.join(' ')} exited ${code}\n${out}\n${err}`));
        return;
      }
      resolve({ code, out, err });
    });
  });
}

/** The one screenshot per step/viewport we want, copied out of the ephemeral run store. */
async function keepShot(run, step, viewport, name) {
  const src = join(STORE, 'runs', run.flow, run.id, 'steps', step, viewport, 'screenshot.png');
  if (!existsSync(src)) throw new Error(`no screenshot at ${src}`);
  await copyFile(src, join(OUT, name));
  return name;
}

async function latestRun(flow) {
  const dir = join(STORE, 'runs', flow);
  const ids = (await readdir(dir)).filter((n) => /^\d+$/.test(n)).sort();
  return { flow, id: ids.at(-1) };
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await rm(join(STORE, 'runs'), { recursive: true, force: true });
  await rm(join(STORE, 'diffs'), { recursive: true, force: true });

  const captured = [];

  // Every capture happens before anything is written to disk, and the order is deliberate.
  //
  // `dirtyHash` covers the untracked file list, so copying a screenshot out between two runs
  // changes the working tree's identity and the second run is a *different revision*. The report
  // then correctly labels the pair `variant-across-revisions` — a proposal compared against
  // different code — which is true, useless, and entirely self-inflicted. Capture first, copy last.
  //
  // The order also decides what the report opens on: it defaults to the two newest runs, so the
  // scenario is captured first and the baseline/variant pair last, leaving the default pair as the
  // proposal — the comparison this feature exists for.
  await cli(['run', 'detail', '--scenario', 'empty-forecast']); // 0000
  await cli(['run', 'detail']); //                                 0001 — the unmodified page
  await cli(['run', 'detail', '--variant', 'denser-forecast']); // 0002 — the proposal
  await cli(['run', 'detail-mock', '--scenario', 'mock-detail']); // a flow with no recording at all

  const scenario = { flow: 'detail', id: '0000' };
  const base = { flow: 'detail', id: '0001' };
  const variant = { flow: 'detail', id: '0002' };
  const mock = await latestRun('detail-mock');

  // 1. The app as it really is — the baseline every comparison is made against.
  captured.push(await keepShot(base, 'berlin', '1280x800', '01-baseline-desktop.png'));
  captured.push(await keepShot(base, 'berlin', '390x844', '02-baseline-mobile.png'));
  // 2. A scenario: same code, same revision, a different API response — a state you cannot reach
  //    by clicking around, because the backend will not produce it on demand.
  captured.push(await keepShot(scenario, 'berlin', '1280x800', '03-scenario-empty-forecast.png'));
  // 3. A variant: a proposed change, rendered without being built.
  captured.push(await keepShot(variant, 'berlin', '1280x800', '04-variant-denser-forecast.png'));
  // 4. Mock mode: a screen with no recording behind it at all.
  captured.push(await keepShot(mock, 'berlin', '1280x800', '05-mock-only.png'));

  // The diffs the report will display. Same-revision pairs, so the labels describe the thing being
  // demonstrated rather than accidental drift.
  const scenarioDiff = await cli(['diff', 'detail', '0001', '0000'], { allowFailure: true });
  const variantDiff = await cli(['diff', 'detail', '0001', '0002'], { allowFailure: true });

  // The head of each summary, not every finding row: the point is what the tool *says* about a
  // pair — the labels and the counts — and a few hundred region rows bury that.
  const head = (text, lines = 12) => text.trim().split('\n').slice(0, lines).join('\n');

  await writeFile(
    join(OUT, 'cli-output.txt'),
    [
      '$ vdiff diff detail 0001 0000     # the unmodified page vs the empty-forecast scenario',
      head(scenarioDiff.out),
      '',
      '$ vdiff diff detail 0001 0002     # the unmodified page vs the denser-forecast proposal',
      head(variantDiff.out),
      '',
      '(truncated: each summary continues with a per-step, per-viewport table)',
    ].join('\n'),
    'utf8',
  );

  // 5. The report itself, served and driven for real.
  const server = spawn(process.execPath, [CLI, 'serve', '--port', '5199'], { cwd: APP });
  try {
    // The report refuses unauthenticated requests — localhost binding plus a session token is what
    // keeps other local processes and stray browser tabs out of the store (slice 1, D6). The URL
    // carrying the token is written to serve.json, so that is what we open.
    let serveUrl = '';
    for (let attempt = 0; attempt < 40 && serveUrl === ''; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const infoPath = join(STORE, 'serve.json');
      if (!existsSync(infoPath)) continue;
      const info = JSON.parse(await readFile(infoPath, 'utf8'));
      if (info.port === 5199 && typeof info.url === 'string') serveUrl = info.url;
    }
    if (serveUrl === '') throw new Error('report server never wrote serve.json');

    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

    await page.goto(serveUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT, '06-report-side-by-side.png'), fullPage: false });
    captured.push('06-report-side-by-side.png');

    // The overlay view mode, which is the one that makes a small shift obvious.
    const overlay = page.locator('text=overlay').first();
    if (await overlay.count()) {
      await overlay.click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(OUT, '07-report-overlay.png'), fullPage: false });
      captured.push('07-report-overlay.png');
    }

    await browser.close();
  } finally {
    server.kill();
  }

  console.log(`showcase → ${OUT}`);
  for (const name of captured) console.log(`  ${name}`);
}

await main();
