import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { StoreError } from './errors.js';
import * as paths from './paths.js';

const ROOT = path.resolve('/projects/shop');
const V = path.join(ROOT, '.visual-diff');

describe('the spec §6 tree', () => {
  it('places the e2e title map beside config.yaml (e2e spec D26)', () => {
    expect(paths.e2eMapFile(ROOT)).toBe(path.join(V, 'e2e-map.yaml'));
    expect(paths.E2E_MAP_FILENAME).toBe('e2e-map.yaml');
  });

  it('places runs under runs/<flow>/<runId>', () => {
    expect(paths.runDir(ROOT, 'checkout', '0007')).toBe(path.join(V, 'runs', 'checkout', '0007'));
    expect(paths.runMetaFile(ROOT, 'checkout', '0007')).toBe(
      path.join(V, 'runs', 'checkout', '0007', 'meta.json'),
    );
    expect(paths.runFlowSnapshotFile(ROOT, 'checkout', '0007')).toBe(
      path.join(V, 'runs', 'checkout', '0007', 'flow.snapshot.yaml'),
    );
  });

  it('keys step directories by id, never by ordinal', () => {
    // Inserting a step must not rename every directory after it (spec §6). The ordinal appears
    // nowhere in the path; ordering lives only in flow.snapshot.yaml.
    expect(paths.stepDir(ROOT, 'checkout', '0007', 'pay-form')).toBe(
      path.join(V, 'runs', 'checkout', '0007', 'steps', 'pay-form'),
    );
    expect(paths.relStepResult('pay-form')).toBe('steps/pay-form/step.json');
    expect(paths.relStepResult('pay-form')).not.toMatch(/\d/);
  });

  it('nests one directory per viewport under the step', () => {
    expect(paths.stepViewportDir(ROOT, 'checkout', '0007', 'pay-form', '1280x800')).toBe(
      path.join(V, 'runs', 'checkout', '0007', 'steps', 'pay-form', '1280x800'),
    );
    expect(paths.relShotPaths('pay-form', '390x844')).toEqual({
      screenshot: 'steps/pay-form/390x844/screenshot.png',
      dom: 'steps/pay-form/390x844/dom.json',
      a11y: 'steps/pay-form/390x844/a11y.json',
    });
  });

  it('keeps console and network at the step level, not per viewport', () => {
    expect(paths.relStepConsole('pay-form')).toBe('steps/pay-form/console.json');
    expect(paths.relStepNetwork('pay-form')).toBe('steps/pay-form/network.json');
  });

  it('names the diff directory by the pair', () => {
    expect(paths.diffDir(ROOT, 'checkout', '0003', '0007')).toBe(
      path.join(V, 'diffs', 'checkout', '0003..0007'),
    );
    expect(paths.diffFindingsFile(ROOT, 'checkout', '0003', '0007')).toBe(
      path.join(V, 'diffs', 'checkout', '0003..0007', 'findings.json'),
    );
  });

  it('emits diff blob paths relative to .visual-diff, as the contracts carry them', () => {
    // Matches the spec §9 feedback example verbatim.
    expect(paths.relDiffCrop('checkout', '0003', '0007', 'f1')).toBe(
      'diffs/checkout/0003..0007/crops/f1.png',
    );
    expect(paths.relDiffPixel('checkout', '0003', '0007', 'pay-form', '1280x800')).toBe(
      'diffs/checkout/0003..0007/steps/pay-form/1280x800/pixel.png',
    );
    expect(paths.relDiffRegions('checkout', '0003', '0007', 'pay-form', '1280x800')).toBe(
      'diffs/checkout/0003..0007/steps/pay-form/1280x800/regions.json',
    );
  });

  it('places feedback, cache and locks where §6 says', () => {
    expect(paths.feedbackPendingFile(ROOT)).toBe(path.join(V, 'feedback', 'pending.jsonl'));
    expect(paths.feedbackArchiveFile(ROOT, '2026-08-08')).toBe(
      path.join(V, 'feedback', 'archive', '2026-08-08.jsonl'),
    );
    expect(paths.depsCacheDir(ROOT, 'abc123')).toBe(path.join(V, 'cache', 'deps', 'abc123'));
    expect(paths.worktreeDir(ROOT, '9f8e7d6')).toBe(path.join(V, 'cache', 'worktrees', '9f8e7d6'));
    expect(paths.lockFile(ROOT, 'checkout')).toBe(path.join(V, '.locks', 'checkout.lock'));
  });

  it('spells the flow path the way `git show <sha>:<path>` needs it', () => {
    expect(paths.flowFileRepoPath('checkout')).toBe('.visual-diff/flows/checkout.yaml');
  });
});

describe('segment safety', () => {
  it('accepts the identifiers the spec uses', () => {
    for (const name of ['checkout', 'pay-form', 'pay_form', '1280x800', 'step.1']) {
      expect(paths.isSafeSegment(name)).toBe(true);
    }
  });

  it('refuses anything that could escape the store', () => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b', '.hidden', 'a:b', 'a|b']) {
      expect(paths.isSafeSegment(name)).toBe(false);
      expect(() => paths.assertSafeSegment('flow', name)).toThrow(StoreError);
    }
  });

  it('refuses a traversing flow name before it reaches path.join', () => {
    expect(() => paths.runDir(ROOT, '../../etc', '0007')).toThrow(/path separator/);
  });

  it('rejects a malformed archive date', () => {
    expect(() => paths.feedbackArchiveFile(ROOT, '2026-8-8')).toThrow(StoreError);
  });
});

describe('resolving stored relative paths', () => {
  it('resolves a .visual-diff-relative blob path', () => {
    expect(paths.resolveInsideVdiff(ROOT, 'diffs/checkout/0003..0007/crops/f1.png')).toBe(
      path.join(V, 'diffs', 'checkout', '0003..0007', 'crops', 'f1.png'),
    );
  });

  it('refuses traversal and absolute paths — the report serves blobs through this', () => {
    expect(() => paths.resolveInsideVdiff(ROOT, '../../../etc/passwd')).toThrow(/escapes/);
    expect(() => paths.resolveInsideVdiff(ROOT, 'diffs/../../secrets')).toThrow(/escapes/);
    expect(() => paths.resolveInsideVdiff(ROOT, path.resolve('/etc/passwd'))).toThrow(
      /must be relative/,
    );
  });

  it('round-trips through toVdiffRelative with posix separators', () => {
    const absolute = paths.resolveInsideVdiff(ROOT, 'runs/checkout/0007/meta.json');
    expect(paths.toVdiffRelative(ROOT, absolute)).toBe('runs/checkout/0007/meta.json');
  });

  it('guards run-relative paths too', () => {
    const runDir = paths.runDir(ROOT, 'checkout', '0007');
    expect(paths.resolveInsideRun(runDir, 'steps/pay-form/step.json')).toBe(
      path.join(runDir, 'steps', 'pay-form', 'step.json'),
    );
    expect(() => paths.resolveInsideRun(runDir, '../0006/meta.json')).toThrow(/escapes/);
  });
});
