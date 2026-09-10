import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findProjectRoot, loadConfig, loadConfigOrThrow, parseConfigSource } from './config.js';
import { DEFAULT_KEEP_E2E_RUNS, keepE2eRunsOf } from './internal/e2e.js';
import { DEFAULT_KEEP_VARIANT_RUNS, keepVariantRunsOf } from './internal/variant.js';
import { DEFAULTS, FINDING_KINDS } from '../types.js';

const FILE = '/projects/shop/.visual-diff/config.yaml';
const ROOT = '/projects/shop';

const MINIMAL = ['app:', '  dev: pnpm dev --port $PORT', '  readyOn: http://localhost:$PORT/'].join(
  '\n',
);

function parse(source: string) {
  return parseConfigSource(source, FILE, ROOT);
}

describe('parseConfigSource', () => {
  it('enables pixel and layout tolerances by default', () => {
    const result = parse(MINIMAL);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.diff.maxChangedPixelRatio).toBe(0.003);
    expect(result.value.diff.layout).toEqual({ enabled: true, tolerancePx: 2 });
  });

  it('keeps explicit strict settings and defaults omitted layout fields', () => {
    const strict = parse(`${MINIMAL}\ndiff:\n  maxChangedPixelRatio: 0\n  layout: { tolerancePx: 0.5 }`);
    if (!strict.ok) throw new Error(JSON.stringify(strict.issues));
    expect(strict.value.diff.maxChangedPixelRatio).toBe(0);
    expect(strict.value.diff.layout).toEqual({ enabled: true, tolerancePx: 0.5 });
    const disabled = parse(`${MINIMAL}\ndiff:\n  layout: { enabled: false }`);
    if (!disabled.ok) throw new Error(JSON.stringify(disabled.issues));
    expect(disabled.value.diff.maxChangedPixelRatio).toBe(0.003);
    expect(disabled.value.diff.layout).toEqual({ enabled: false, tolerancePx: 2 });
  });

  it('accepts independent pixel and layout tolerance controls', () => {
    const result = parse(`${MINIMAL}\ndiff:\n  maxChangedPixelRatio: 0.003\n  layout:\n    enabled: false\n    tolerancePx: 2`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diff.maxChangedPixelRatio).toBe(0.003);
    expect(result.value.diff.layout).toEqual({ enabled: false, tolerancePx: 2 });
  });

  it.each(['maxChangedPixelRatio: -1', 'maxChangedPixelRatio: 1.01',
    'maxChangedPixelRatio: "0.3%"', 'layout: { tolerancePx: -1 }',
    'layout: { enabled: "false" }', 'layout: { tolerance: 2 }'])('rejects invalid tolerance: %s', setting => {
    expect(parse(`${MINIMAL}\ndiff:\n  ${setting}`).ok).toBe(false);
  });

  it('resolves browser.storageState against the project root', () => {
    const result = parse(`${MINIMAL}\nbrowser:\n  storageState: .visual-diff/auth/state.json`);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.browser).toEqual({
      storageState: path.resolve(ROOT, '.visual-diff/auth/state.json'),
    });
  });

  it('leaves browser absent when the file does not set it', () => {
    const result = parse(MINIMAL);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.browser).toBeUndefined();
  });

  it('rejects an unknown browser key with its path', () => {
    const result = parse(`${MINIMAL}\nbrowser:\n  cookies: x`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.issues)).toContain('cookies');
  });

  it('accepts the spec §6 example verbatim', () => {
    const source = [
      'app:',
      '  install: pnpm install --frozen-lockfile',
      '  dev:     pnpm dev --port $PORT',
      '  readyOn: http://localhost:$PORT/',
      '  readyTimeout: 90s',
      'diff:',
      '  minRegionArea: 64',
      '  maxRegions: 40',
      '  antialiasTolerance: 0.1',
      '  ignore: ["[data-test=session-id]"]',
      'network:',
      '  redact: ["x-api-key"]',
      'retention:',
      '  keepRuns: 20',
    ].join('\n');
    const result = parse(source);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));

    expect(result.value.app).toEqual({
      install: 'pnpm install --frozen-lockfile',
      dev: 'pnpm dev --port $PORT',
      readyOn: 'http://localhost:$PORT/',
      readyTimeoutMs: 90_000,
    });
    expect(result.value.diff).toEqual({
      minRegionArea: 64,
      maxRegions: 40,
      antialiasTolerance: 0.1,
      maxChangedPixelRatio: 0.003,
      layout: { enabled: true, tolerancePx: 2 },
      ignore: ['[data-test=session-id]'],
      // Both report channels default on and every kind is emitted; the §6 example names none of
      // them (D54, D57).
      findings: true,
      warnings: true,
      kinds: [...FINDING_KINDS],
    });
    expect(result.value.network).toEqual({ redact: ['x-api-key'], scrub: true });
    // The §6 example names only `keepRuns`; the variant and e2e buckets default beside it
    // (variants §5, e2e §7).
    expect(result.value.retention).toEqual({
      keepRuns: 20,
      keepVariantRuns: 10,
      keepE2eRuns: 20,
    });
    expect(result.value.root).toBe(ROOT);
    expect(result.value.dir).toBe(path.join(ROOT, '.visual-diff'));
  });

  it('fills every documented default when only app is present', () => {
    const result = parse(MINIMAL);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.diff.minRegionArea).toBe(DEFAULTS.diff.minRegionArea);
    expect(result.value.diff.maxRegions).toBe(DEFAULTS.diff.maxRegions);
    expect(result.value.diff.antialiasTolerance).toBe(DEFAULTS.diff.antialiasTolerance);
    expect(result.value.diff.ignore).toEqual([]);
    expect(result.value.diff.findings).toBe(true);
    expect(result.value.diff.warnings).toBe(true);
    expect(result.value.retention.keepRuns).toBe(DEFAULTS.retention.keepRuns);
    expect(result.value.retention.keepRuns).toBe(20);
    expect(keepVariantRunsOf(result.value.retention)).toBe(DEFAULT_KEEP_VARIANT_RUNS);
    expect(keepVariantRunsOf(result.value.retention)).toBe(10);
    expect(result.value.network.redact).toEqual([]);
    expect(result.value.app.readyTimeoutMs).toBe(DEFAULTS.readyTimeoutMs);
    expect(result.value.app.install).toBeUndefined();
    expect(result.value.baseUrl).toBeUndefined();
  });

  it('reads the two report channels off the file (D54)', () => {
    const result = parse(
      [MINIMAL, 'diff:', '  findings: false', '  warnings: false'].join('\n'),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.diff.findings).toBe(false);
    expect(result.value.diff.warnings).toBe(false);
    // The noise controls are untouched by them: what is emitted and what is compared are two
    // different questions.
    expect(result.value.diff.minRegionArea).toBe(DEFAULTS.diff.minRegionArea);
  });

  it('refuses a report channel that is not a boolean', () => {
    const result = parse([MINIMAL, 'diff:', '  findings: sometimes'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.at.key).toBe('diff.findings');
  });

  it('narrows the finding kinds, de-duplicated and in vocabulary order (D57)', () => {
    const result = parse(
      [MINIMAL, 'diff:', '  kinds: [network, content, content]'].join('\n'),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    // Written order and multiplicity are not the choice: this list is fingerprinted into the diff
    // cache key, and two spellings of one decision must not key as two configurations.
    expect(result.value.diff.kinds).toEqual(['content', 'network']);
  });

  it('refuses a kind outside the closed vocabulary', () => {
    const result = parse([MINIMAL, 'diff:', '  kinds: [content, screenshots]'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.issues)).toContain('kinds');
  });

  it('refuses an empty list, and names the switch that means it', () => {
    const result = parse([MINIMAL, 'diff:', '  kinds: []'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain('findings: false');
  });

  it('does not let the file disable HAR scrubbing — only --no-scrub can (spec §6)', () => {
    const result = parse([MINIMAL, 'network:', '  scrub: false'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('unknown-key');
    expect(result.issues[0]?.at.key).toBe('network.scrub');
  });

  it('reports an unknown key with file, line and the offending key (spec §10 row 1)', () => {
    const source = [MINIMAL, 'diff:', '  minRegionAre: 64'].join('\n');
    const result = parse(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue?.code).toBe('unknown-key');
    expect(issue?.at.file).toBe(FILE);
    expect(issue?.at.key).toBe('diff.minRegionAre');
    expect(issue?.at.line).toBe(5);
  });

  it('reports a missing required key', () => {
    const result = parse('app:\n  readyOn: http://localhost:5173/\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toContain('missing-key');
    expect(result.issues.map((i) => i.at.key)).toContain('app.dev');
  });

  it('reports a wrong type with a line', () => {
    const result = parse([MINIMAL, 'retention:', '  keepRuns: "twenty"'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('invalid-type');
    expect(result.issues[0]?.at.key).toBe('retention.keepRuns');
    expect(result.issues[0]?.at.line).toBe(5);
  });

  it('rejects a unitless readyTimeout rather than guessing seconds or milliseconds', () => {
    const result = parse([MINIMAL, '  readyTimeout: 90'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // `90` is a number, so the schema rejects the type before the duration parser sees it.
    expect(result.issues[0]?.at.key).toBe('app.readyTimeout');
  });

  it('rejects a readyTimeout string with no unit', () => {
    const result = parse([MINIMAL, '  readyTimeout: "90"'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('invalid-duration');
    expect(result.issues[0]?.at.key).toBe('app.readyTimeout');
  });

  it('reports malformed YAML with a position instead of throwing', () => {
    const result = parse('app: [unclosed\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('invalid-yaml');
    expect(result.issues[0]?.at.file).toBe(FILE);
  });

  it('rejects an empty file', () => {
    const result = parse('\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('empty-config');
  });

  it('reads the variant retention bucket, which is separate from keepRuns (variants §5)', () => {
    const result = parse([MINIMAL, 'retention:', '  keepRuns: 30', '  keepVariantRuns: 3'].join('\n'));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.retention.keepRuns).toBe(30);
    expect(keepVariantRunsOf(result.value.retention)).toBe(3);
  });

  it('reports a mistyped keepVariantRuns with file, line and the offending key', () => {
    const result = parse([MINIMAL, 'retention:', '  keepVariantRun: 3'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('unknown-key');
    expect(result.issues[0]?.message).toBe('unknown key "retention.keepVariantRun"');
    expect(result.issues[0]?.at.key).toBe('retention.keepVariantRun');
    expect(result.issues[0]?.at.line).toBe(5);
  });

  it('rejects a variant bucket of zero rather than pruning every proposal on sight', () => {
    const result = parse([MINIMAL, 'retention:', '  keepVariantRuns: 0'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.at.key).toBe('retention.keepVariantRuns');
  });

  it('reads the e2e retention bucket (e2e spec §7)', () => {
    const result = parse([MINIMAL, 'retention:', '  keepE2eRuns: 7'].join('\n'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(keepE2eRunsOf(result.value.retention)).toBe(7);
  });

  it('defaults the e2e bucket when the file predates the key', () => {
    const result = parse([MINIMAL, 'retention:', '  keepRuns: 30'].join('\n'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(keepE2eRunsOf(result.value.retention)).toBe(DEFAULT_KEEP_E2E_RUNS);
  });

  it('reports a mistyped keepE2eRuns with file, line and the offending key', () => {
    const result = parse([MINIMAL, 'retention:', '  keepE2eRun: 7'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('unknown-key');
    expect(result.issues[0]?.message).toBe('unknown key "retention.keepE2eRun"');
    expect(result.issues[0]?.at.line).toBe(5);
  });

  it('refuses a zero e2e bucket at the schema, before the pruner sees it as a cap', () => {
    const result = parse([MINIMAL, 'retention:', '  keepE2eRuns: 0'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.at.key).toBe('retention.keepE2eRuns');
  });

  it('accepts a project-level baseUrl override', () => {
    const result = parse([MINIMAL, 'baseUrl: http://localhost:4321'].join('\n'));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.baseUrl).toBe('http://localhost:4321');
  });
});

/**
 * `e2e:` — the noise controls for a pair with an ingested side (e2e spec §5, D27).
 *
 * The block was documented by the spec and rejected by the schema, so a project following the
 * documentation got a hard exit-2 config error. These tests fix the shape of it; that an override
 * reaching this block actually changes what the engine computes is `src/diff/e2e-config.test.ts`,
 * because parsing a threshold and applying one are different claims.
 */
describe('the e2e noise block (§5)', () => {
  it('accepts §5’s two settings', () => {
    const result = parse(
      [MINIMAL, 'e2e:', '  minRegionArea: 400', '  antialiasTolerance: 0.35'].join('\n'),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.e2e).toEqual({ minRegionArea: 400, antialiasTolerance: 0.35 });
  });

  it('carries only what was written, so the defaults keep living in exactly one place', () => {
    const partial = parse([MINIMAL, 'e2e:', '  minRegionArea: 400'].join('\n'));
    if (!partial.ok) throw new Error(JSON.stringify(partial.issues));
    // Not `{ minRegionArea: 400, antialiasTolerance: 0.25 }`: a config that restated the default
    // would be a second copy of a provisional number, and `E2E_DIFF_DEFAULTS` would stop being the
    // answer to "what is the e2e antialias tolerance?".
    expect(partial.value.e2e).toEqual({ minRegionArea: 400 });

    const absent = parse(MINIMAL);
    if (!absent.ok) throw new Error(JSON.stringify(absent.issues));
    expect(absent.value.e2e).toBeUndefined();
  });

  it('leaves the replay thresholds alone — `e2e:` is an override, not a replacement', () => {
    const result = parse([MINIMAL, 'e2e:', '  minRegionArea: 400'].join('\n'));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.diff.minRegionArea).toBe(DEFAULTS.diff.minRegionArea);
    expect(result.value.diff.antialiasTolerance).toBe(DEFAULTS.diff.antialiasTolerance);
  });

  it('rejects a value out of range at load, not as a warning mid-diff', () => {
    const result = parse([MINIMAL, 'e2e:', '  antialiasTolerance: 3'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.at.key).toBe('e2e.antialiasTolerance');
    expect(result.issues[0]?.at.line).toBe(5);
  });

  it('rejects a negative minimum region area', () => {
    const result = parse([MINIMAL, 'e2e:', '  minRegionArea: -1'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.at.key).toBe('e2e.minRegionArea');
  });

  it('reports a mistyped key with file, line and the offending key', () => {
    const result = parse([MINIMAL, 'e2e:', '  minRegionAre: 400'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('unknown-key');
    expect(result.issues[0]?.message).toBe('unknown key "e2e.minRegionAre"');
    expect(result.issues[0]?.at.line).toBe(5);
  });

  it('names the real setting when the key came from §5’s own wording', () => {
    // §5 tabulates "pixel threshold"; the engine has one pixelmatch threshold and calls it
    // `antialiasTolerance`. "unknown key" would read as *not supported* rather than *renamed*.
    const result = parse([MINIMAL, 'e2e:', '  pixelThreshold: 0.3'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('renamed-key');
    expect(result.issues[0]?.message).toBe(
      'e2e.pixelThreshold is not a setting; the e2e noise controls are e2e.minRegionArea and ' +
        'e2e.antialiasTolerance — write e2e.antialiasTolerance instead',
    );
    expect(result.issues[0]?.at.line).toBe(5);
  });

  it('refuses a mask list here too, wherever the user tries to put one', () => {
    // `e2e-map.yaml` explains why at length; the point of this one is that config.yaml is not the
    // workaround a user reaches for next.
    const result = parse([MINIMAL, 'e2e:', '  ignore: [".clock"]'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toBe('unknown key "e2e.ignore"');
  });
});

describe('project discovery', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'vdiff-config-')));
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('walks up to the nearest .visual-diff directory', async () => {
    const nested = path.join(tmp, 'packages', 'web', 'src');
    await fsp.mkdir(nested, { recursive: true });
    await fsp.mkdir(path.join(tmp, '.visual-diff'), { recursive: true });
    expect(await findProjectRoot(nested)).toBe(tmp);
  });

  it('returns null outside a project', async () => {
    const nested = path.join(tmp, 'nothing', 'here');
    await fsp.mkdir(nested, { recursive: true });
    // tmp itself has no .visual-diff, and neither does any ancestor of the OS temp dir.
    expect(await findProjectRoot(nested)).toBeNull();
  });

  it('reports a missing project rather than throwing', async () => {
    const result = await loadConfig({ cwd: tmp });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('no-project');
  });

  it('reports a missing config.yaml inside an existing project', async () => {
    await fsp.mkdir(path.join(tmp, '.visual-diff'), { recursive: true });
    const result = await loadConfig({ cwd: tmp });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('config-missing');
  });

  it('loads a real file end to end', async () => {
    await fsp.mkdir(path.join(tmp, '.visual-diff'), { recursive: true });
    await fsp.writeFile(path.join(tmp, '.visual-diff', 'config.yaml'), `${MINIMAL}\n`);
    const config = await loadConfigOrThrow({ cwd: tmp });
    expect(config.root).toBe(tmp);
    expect(config.app.dev).toBe('pnpm dev --port $PORT');
  });

  it('throws with exit code 2 for an invalid config (spec §9)', async () => {
    await fsp.mkdir(path.join(tmp, '.visual-diff'), { recursive: true });
    await fsp.writeFile(path.join(tmp, '.visual-diff', 'config.yaml'), 'app: {}\n');
    await expect(loadConfigOrThrow({ cwd: tmp })).rejects.toMatchObject({ exitCode: 2 });
  });

});

describe('browser.ignoreHTTPSErrors', () => {
  it('is carried through, alone or beside the storage state', () => {
    const alone = parse(`${MINIMAL}\nbrowser:\n  ignoreHTTPSErrors: true`);
    if (!alone.ok) throw new Error(JSON.stringify(alone.issues));
    expect(alone.value.browser).toEqual({ ignoreHTTPSErrors: true });

    const both = parse(
      `${MINIMAL}\nbrowser:\n  storageState: .visual-diff/auth/state.json\n  ignoreHTTPSErrors: false`,
    );
    if (!both.ok) throw new Error(JSON.stringify(both.issues));
    expect(both.value.browser).toEqual({
      storageState: path.resolve(ROOT, '.visual-diff/auth/state.json'),
      ignoreHTTPSErrors: false,
    });
  });

  it('rejects a non-boolean', () => {
    const result = parse(`${MINIMAL}\nbrowser:\n  ignoreHTTPSErrors: yes please`);
    expect(result.ok).toBe(false);
  });
});

describe('browser.maskColor', () => {
  it('carries a hex colour through, and the keywords a project reaches for', () => {
    const hex = parse(`${MINIMAL}\nbrowser:\n  maskColor: "#ffffff"`);
    if (!hex.ok) throw new Error(JSON.stringify(hex.issues));
    expect(hex.value.browser).toEqual({ maskColor: '#ffffff' });

    for (const keyword of ['white', 'black', 'transparent']) {
      const result = parse(`${MINIMAL}\nbrowser:\n  maskColor: ${keyword}`);
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(result.value.browser).toEqual({ maskColor: keyword });
    }
  });

  it('stays absent when the file does not set it, so the default is the only magenta', () => {
    const result = parse(`${MINIMAL}\nbrowser:\n  ignoreHTTPSErrors: true`);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.browser?.maskColor).toBeUndefined();
    expect(DEFAULTS.maskColor).toBe('#ff00ff');
  });

  it('refuses a colour Playwright would not use, instead of falling back to magenta in silence', () => {
    const result = parse(`${MINIMAL}\nbrowser:\n  maskColor: nearly-white`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.at.key).toBe('browser.maskColor');
  });
});

describe('capture', () => {
  it('collects everything unless the file says otherwise', () => {
    const result = parse(MINIMAL);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.capture).toEqual({ a11y: true, console: true, network: true });
  });

  it('turns individual channels off', () => {
    const result = parse([MINIMAL, 'capture:', '  a11y: false', '  console: false'].join('\n'));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.capture).toEqual({ a11y: false, console: false, network: true });
  });

  it('rejects a key that is not a channel, rather than collecting everything anyway', () => {
    const result = parse([MINIMAL, 'capture:', '  a11yTree: false'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.issues)).toContain('a11yTree');
  });
});

describe('browser.mask', () => {
  it('turns the painting off, and the default leaves it on', () => {
    const off = parse(`${MINIMAL}\nbrowser:\n  mask: false`);
    if (!off.ok) throw new Error(JSON.stringify(off.issues));
    expect(off.value.browser).toEqual({ mask: false });

    const silent = parse(MINIMAL);
    if (!silent.ok) throw new Error(JSON.stringify(silent.issues));
    expect(silent.value.browser?.mask).toBeUndefined();
  });

  it('refuses a colour for a mask that paints nothing', () => {
    const result = parse(`${MINIMAL}\nbrowser:\n  mask: false\n  maskColor: "#ffffff"`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.at.key).toBe('browser.maskColor');
    expect(result.issues[0]?.message).toContain('nothing is painted');
  });

  it('accepts a colour with the painting left on', () => {
    const result = parse(`${MINIMAL}\nbrowser:\n  mask: true\n  maskColor: black`);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.browser).toEqual({ mask: true, maskColor: 'black' });
  });
});

describe('app.stepTimeout', () => {
  it('is parsed as a duration and absent when not written', () => {
    const set = parse(`${MINIMAL}\n  stepTimeout: 90s`);
    if (!set.ok) throw new Error(JSON.stringify(set.issues));
    expect(set.value.app.stepTimeoutMs).toBe(90_000);
    const unset = parse(MINIMAL);
    if (!unset.ok) throw new Error(JSON.stringify(unset.issues));
    expect('stepTimeoutMs' in unset.value.app).toBe(false);
  });

  it('refuses a unitless value, naming the key', () => {
    const result = parse(`${MINIMAL}\n  stepTimeout: 90`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain('app.stepTimeout');
  });
});
