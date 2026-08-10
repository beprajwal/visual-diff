/**
 * `.visual-diff/e2e-map.yaml` — the D26 escape hatch, and the §8 stale-pin warning.
 *
 * The file exists because titles are not identifiers: a suite that renames often would otherwise
 * pay for each rename with a removed-and-added flow. So the two things worth testing hard are the
 * two ways a pin can quietly fail to do anything:
 *
 * - it is written in a form the loader does not match (with the `:12` still in it, with different
 *   spacing, or duplicated under two spellings) — refused at load, with file and line;
 * - it matches nothing in the traces actually ingested — a run warning naming it, because §8 is
 *   explicit that this is the same failure class as a never-matched scenario rule.
 *
 * The file's `ignore:` list is the third way, and the worst: §5 documents it, nothing could ever
 * apply it to an ingested run, and a mask that silently masks nothing turns real noise into findings
 * the user reads as regressions. It is refused at load, and the refusal is asserted by its message.
 */

import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createE2eMapper,
  emptyE2eMap,
  loadE2eMap,
  loadE2eMapOrThrow,
  parseE2eMapSource,
  IGNORE_UNSUPPORTED_MESSAGE,
} from './e2e-map.js';
import { StoreError } from './errors.js';
import { E2E_MAP_UNMATCHED } from './internal/e2e.js';
import * as paths from './paths.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vdiff-e2e-map-'));
  await fsp.mkdir(paths.vdiffDir(tmp), { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

const FILE = '/project/.visual-diff/e2e-map.yaml';

function parse(source: string) {
  return parseE2eMapSource(source, FILE);
}

describe('parseE2eMapSource', () => {
  it('reads the documented shape', () => {
    const result = parse(
      [
        'flows:',
        '  "checkout.spec.ts › checkout › shows the cart": cart',
        'steps:',
        '  "checkout.spec.ts › checkout › shows the cart":',
        '    "open the dashboard": dashboard',
      ].join('\n'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.flows.get('checkout.spec.ts › checkout › shows the cart')).toBe('cart');
    expect(
      result.value.steps
        .get('checkout.spec.ts › checkout › shows the cart')
        ?.get('open the dashboard'),
    ).toBe('dashboard');
  });

  it('matches a pin written with the line number still in it', () => {
    const result = parse(['flows:', '  "checkout.spec.ts:12 › checkout › shows the cart": cart'].join('\n'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Stored under the normalised key, so a trace whose title has a *different* line still matches.
    expect(result.value.flows.get('checkout.spec.ts › checkout › shows the cart')).toBe('cart');
  });

  it('treats an empty file as an empty map, since commenting every pin out is legitimate', () => {
    const result = parse('# nothing pinned yet\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.flows.size).toBe(0);
    expect(result.value.steps.size).toBe(0);
  });

  it('reports an unknown key with file, line and the offending key', () => {
    const result = parse(['flows:', '  "a › b": ab', 'flws:', '  "c › d": cd'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('unknown-key');
    expect(result.issues[0]?.message).toBe('unknown key "flws"');
    expect(result.issues[0]?.at.file).toBe(FILE);
    expect(result.issues[0]?.at.key).toBe('flws');
    // The key itself has no node, so the location falls back to its value — the map on line 4 —
    // exactly as an unknown key in config.yaml does.
    expect(result.issues[0]?.at.line).toBe(4);
  });

  it('reports invalid YAML rather than parsing half of it', () => {
    const result = parse('flows:\n  - "a › b\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('invalid-yaml');
    expect(result.issues[0]?.at.file).toBe(FILE);
  });

  it('refuses two spellings of one title instead of letting the loser do nothing silently', () => {
    const result = parse(
      [
        'flows:',
        '  "checkout.spec.ts:12 › checkout › shows the cart": cart',
        '  "checkout.spec.ts:40 › checkout › shows the cart": basket',
      ].join('\n'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('duplicate-pin');
    expect(result.issues[0]?.message).toBe(
      'flows keys "checkout.spec.ts:12 › checkout › shows the cart" and ' +
        '"checkout.spec.ts:40 › checkout › shows the cart" both name the test ' +
        '"checkout.spec.ts › checkout › shows the cart"; one of the two pins would silently do nothing',
    );
    expect(result.issues[0]?.at.line).toBe(3);
  });

  it('refuses the same collision under steps', () => {
    const result = parse(
      [
        'steps:',
        '  "a.spec.ts:1 › x › y":',
        '    "open": open',
        '  "a.spec.ts:9 › x › y":',
        '    "open": start',
      ].join('\n'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('duplicate-pin');
    expect(result.issues[0]?.message).toContain('steps keys');
    expect(result.issues[0]?.message).toContain('both name the test "a.spec.ts › x › y"');
  });

  it('refuses a pinned flow name that could not be a directory', () => {
    const result = parse(['flows:', '  "a › b": ../../escape'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('unsafe-name');
    expect(result.issues[0]?.message).toBe(
      'flow "../../escape" contains a path separator or control character',
    );
    expect(result.issues[0]?.at.key).toBe('flows.a › b');
  });

  it('refuses a pinned step id that could not be a directory', () => {
    const result = parse(['steps:', '  "a › b":', '    "open": ".."'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('unsafe-name');
    expect(result.issues[0]?.message).toBe('step id ".." is not a usable directory name');
  });

  it('refuses a key that normalises to nothing, which could never match a trace', () => {
    const result = parse(['flows:', '  "  ›  ": cart'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('empty-title');
    expect(result.issues[0]?.message).toBe('flows key "  ›  " has no title in it once normalised');
  });

  it('refuses an empty pinned name at the schema level', () => {
    const result = parse(['flows:', '  "a › b": ""'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('invalid-value');
  });

  /**
   * §5 documents an `ignore` list here, and it cannot work: masking subtracts a matched node's rect
   * from the pixel diff, and an ingested node has no rect. `src/diff/e2e-config.test.ts` proves the
   * inertness against the real diff engine; these three assert that the loader refuses rather than
   * accepting a list that would suppress nothing.
   */
  describe('the ignore list §5 proposes, which cannot be applied', () => {
    it('refuses it, and says why and what to do instead', () => {
      const result = parse(['ignore:', '  - ".clock"'].join('\n'));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0]?.code).toBe('e2e-ignore-unsupported');
      expect(result.issues[0]?.message).toBe(IGNORE_UNSUPPORTED_MESSAGE);
      // The three things the message has to carry, asserted individually so a rewording that drops
      // one of them fails here rather than being noticed by a user.
      expect(result.issues[0]?.message).toContain('the list would suppress nothing');
      expect(result.issues[0]?.message).toContain('0x0 rect');
      expect(result.issues[0]?.message).toContain(
        'tune e2e.minRegionArea and e2e.antialiasTolerance in config.yaml instead',
      );
      expect(result.issues[0]?.at.file).toBe(FILE);
      expect(result.issues[0]?.at.line).toBe(2);
      expect(result.issues[0]?.at.key).toBe('ignore');
    });

    it('refuses an empty list too — an empty mask is still a belief that masking exists', () => {
      const result = parse('ignore: []\n');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0]?.code).toBe('e2e-ignore-unsupported');
    });

    it('reports it first, ahead of whatever else is wrong with the file', () => {
      const result = parse(['ignore:', '  - ".clock"', 'flows:', '  "a › b": ../escape'].join('\n'));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((i) => i.code)).toEqual(['e2e-ignore-unsupported', 'unsafe-name']);
    });
  });
});

describe('loadE2eMap', () => {
  it('is an empty map when the project has no file — the map is optional', async () => {
    const result = await loadE2eMap(tmp);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.flows.size).toBe(0);
    expect(result.value.file).toBe(paths.e2eMapFile(tmp));
  });

  it('reads the file when there is one', async () => {
    await fsp.writeFile(paths.e2eMapFile(tmp), 'flows:\n  "a.spec.ts:1 › x › y": xy\n');
    const result = await loadE2eMap(tmp);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.flows.get('a.spec.ts › x › y')).toBe('xy');
  });

  it('throws a config error naming file and line when the file is unusable (§8)', async () => {
    await fsp.writeFile(paths.e2eMapFile(tmp), 'flows:\n  "a › b": ../escape\n');
    await expect(loadE2eMapOrThrow(tmp)).rejects.toThrow(StoreError);
    await expect(loadE2eMapOrThrow(tmp)).rejects.toThrow(
      `flow "../escape" contains a path separator or control character (${paths.e2eMapFile(tmp)}:2)`,
    );
  });

  it('exits 2 for a bad map, as a bad config.yaml does', async () => {
    await fsp.writeFile(paths.e2eMapFile(tmp), 'flws: {}\n');
    await expect(loadE2eMapOrThrow(tmp)).rejects.toMatchObject({ exitCode: 2 });
  });

  it('exits 2 on an ignore list, so the no-op is hit at ingest and not read as coverage', async () => {
    await fsp.writeFile(paths.e2eMapFile(tmp), 'ignore:\n  - ".clock"\n');
    await expect(loadE2eMapOrThrow(tmp)).rejects.toMatchObject({
      exitCode: 2,
      code: 'e2e-ignore-unsupported',
    });
    await expect(loadE2eMapOrThrow(tmp)).rejects.toThrow(
      `${IGNORE_UNSUPPORTED_MESSAGE} (${paths.e2eMapFile(tmp)}:2)`,
    );
  });
});

describe('createE2eMapper', () => {
  const map = (() => {
    const result = parse(
      [
        'flows:',
        '  "checkout.spec.ts › checkout › shows the cart": cart',
        '  "gone.spec.ts › gone › vanished": ghost',
        'steps:',
        '  "checkout.spec.ts › checkout › shows the cart":',
        '    "open the dashboard": dashboard',
        '    "a step nobody runs": orphan',
      ].join('\n'),
    );
    if (!result.ok) throw new Error('fixture map should parse');
    return result.value;
  })();

  it('pins a flow name, matching a title whose line has since moved', () => {
    const mapper = createE2eMapper(map);
    expect(mapper.flowFor('checkout.spec.ts:12 › checkout › shows the cart')).toBe('cart');
    expect(mapper.flowFor('checkout.spec.ts:99 › checkout › shows the cart')).toBe('cart');
  });

  it('returns null for a title it has no opinion about, so the caller derives one', () => {
    const mapper = createE2eMapper(map);
    expect(mapper.flowFor('other.spec.ts:1 › other › thing')).toBeNull();
    expect(mapper.stepIdFor('other.spec.ts:1 › other › thing', 'open the dashboard')).toBeNull();
  });

  it('pins a step id, scoped to the test it was written under', () => {
    const mapper = createE2eMapper(map);
    expect(
      mapper.stepIdFor('checkout.spec.ts:12 › checkout › shows the cart', 'open the dashboard'),
    ).toBe('dashboard');
    // The same step title under a different test is not pinned by it.
    expect(mapper.stepIdFor('gone.spec.ts:1 › gone › vanished', 'open the dashboard')).toBeNull();
  });

  it('warns about every pin no trace asked for, naming step pins by their test (§8)', () => {
    const mapper = createE2eMapper(map);
    mapper.flowFor('checkout.spec.ts:12 › checkout › shows the cart');
    mapper.stepIdFor('checkout.spec.ts:12 › checkout › shows the cart', 'open the dashboard');

    expect(mapper.unmatched()).toEqual([
      'gone.spec.ts › gone › vanished',
      'checkout.spec.ts › checkout › shows the cart › a step nobody runs',
    ]);
    const warning = mapper.unmatchedWarning();
    expect(warning?.kind).toBe(E2E_MAP_UNMATCHED);
    expect(warning?.message).toBe(
      'e2e-map.yaml pins 2 titles no ingested trace contains: ' +
        '"gone.spec.ts › gone › vanished", ' +
        '"checkout.spec.ts › checkout › shows the cart › a step nobody runs" — ' +
        'each pin is doing nothing',
    );
  });

  it('says nothing when every pin was consulted', () => {
    const mapper = createE2eMapper(map);
    mapper.flowFor('checkout.spec.ts:12 › checkout › shows the cart');
    mapper.flowFor('gone.spec.ts:1 › gone › vanished');
    mapper.stepIdFor('checkout.spec.ts:12 › checkout › shows the cart', 'open the dashboard');
    mapper.stepIdFor('checkout.spec.ts:12 › checkout › shows the cart', 'a step nobody runs');
    expect(mapper.unmatched()).toEqual([]);
    expect(mapper.unmatchedWarning()).toBeNull();
  });

  it('counts a lookup that missed as not using the pin, which is the whole point', () => {
    const mapper = createE2eMapper(map);
    // Asking about a *different* test does not mark the ghost pin used.
    mapper.flowFor('unrelated.spec.ts:1 › unrelated › thing');
    expect(mapper.unmatched()).toContain('gone.spec.ts › gone › vanished');
  });

  it('has nothing to warn about when there is no map at all', () => {
    expect(createE2eMapper(emptyE2eMap(FILE)).unmatchedWarning()).toBeNull();
  });
});
