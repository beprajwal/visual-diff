import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ackAllPending,
  ackFeedback,
  appendFeedback,
  readArchivedFeedback,
  readPendingFeedback,
} from './feedback-store.js';
import * as paths from './paths.js';
import type { FeedbackInput } from '../types.js';

let tmp: string;

const AT = new Date('2026-08-08T10:12:00Z');

const COMMENT: FeedbackInput = {
  flow: 'checkout',
  pair: '0003..0007',
  step: 'pay-form',
  viewport: '1280x800',
  findingId: 'f1',
  element: '[data-test=pay]',
  region: { x: 6, y: 56, w: 86, h: 19 },
  text: 'padding is too tight, and this should match the cart CTA',
};

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vdiff-feedback-'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('appendFeedback', () => {
  it('produces the spec §9 entry, with the server owning id, ts and status', async () => {
    const entry = await appendFeedback(tmp, COMMENT, {
      now: AT,
      crop: 'diffs/checkout/0003..0007/crops/f1.png',
    });
    expect(entry).toEqual({
      id: 'fb_01',
      ts: '2026-08-08T10:12:00.000Z',
      flow: 'checkout',
      pair: '0003..0007',
      step: 'pay-form',
      viewport: '1280x800',
      findingId: 'f1',
      element: '[data-test=pay]',
      region: { x: 6, y: 56, w: 86, h: 19 },
      crop: 'diffs/checkout/0003..0007/crops/f1.png',
      text: 'padding is too tight, and this should match the cart CTA',
      status: 'pending',
    });
  });

  it('appends one line per entry, and never a newline inside one', async () => {
    await appendFeedback(tmp, COMMENT, { now: AT });
    await appendFeedback(tmp, { ...COMMENT, text: 'multi\nline\ncomment' }, { now: AT });
    const text = await fsp.readFile(paths.feedbackPendingFile(tmp), 'utf8');
    const lines = text.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string)).toMatchObject({ text: 'multi\nline\ncomment' });
  });

  it('allocates ids past everything already stored, pending and archived alike', async () => {
    const first = await appendFeedback(tmp, COMMENT, { now: AT });
    const second = await appendFeedback(tmp, COMMENT, { now: AT });
    expect([first.id, second.id]).toEqual(['fb_01', 'fb_02']);

    await ackFeedback(tmp, [first.id], { now: AT });
    const third = await appendFeedback(tmp, COMMENT, { now: AT });
    // fb_01 lives in the archive now; reusing it would collide with what the agent already read.
    expect(third.id).toBe('fb_03');
  });

  it('omits absent optional fields rather than writing nulls', async () => {
    const entry = await appendFeedback(
      tmp,
      { flow: 'checkout', pair: '0003..0007', text: 'general note' },
      { now: AT },
    );
    expect(entry.step).toBeUndefined();
    const line = (await fsp.readFile(paths.feedbackPendingFile(tmp), 'utf8')).trim();
    expect(line).not.toContain('null');
    expect(Object.keys(JSON.parse(line) as object).sort()).toEqual([
      'flow',
      'id',
      'pair',
      'status',
      'text',
      'ts',
    ]);
  });
});

describe('readPendingFeedback', () => {
  it('filters by flow and pair', async () => {
    await appendFeedback(tmp, COMMENT, { now: AT });
    await appendFeedback(tmp, { ...COMMENT, flow: 'search', pair: '0000..0001' }, { now: AT });

    expect(await readPendingFeedback(tmp)).toHaveLength(2);
    expect(await readPendingFeedback(tmp, { flow: 'checkout' })).toHaveLength(1);
    expect(await readPendingFeedback(tmp, { pair: '0000..0001' })).toHaveLength(1);
  });

  it('is empty before anything is written', async () => {
    expect(await readPendingFeedback(tmp)).toEqual([]);
  });
});

describe('ackFeedback', () => {
  it('archives exactly what was read and leaves the rest pending', async () => {
    const a = await appendFeedback(tmp, { ...COMMENT, text: 'first' }, { now: AT });
    const b = await appendFeedback(tmp, { ...COMMENT, text: 'second' }, { now: AT });
    // Arrived after the agent read: must survive the ack.
    const c = await appendFeedback(tmp, { ...COMMENT, text: 'third' }, { now: AT });

    const result = await ackFeedback(tmp, [a.id, b.id], { now: AT });

    expect(result.acked.map((entry) => entry.text)).toEqual(['first', 'second']);
    expect(result.acked.every((entry) => entry.status === 'acked')).toBe(true);
    expect(result.acked.every((entry) => entry.ackedAt === '2026-08-08T10:12:00.000Z')).toBe(true);
    expect(result.remaining).toBe(1);
    expect(result.archive).toBe(paths.feedbackArchiveFile(tmp, '2026-08-08'));

    expect((await readPendingFeedback(tmp)).map((entry) => entry.id)).toEqual([c.id]);
    expect((await readArchivedFeedback(tmp)).map((entry) => entry.id)).toEqual([a.id, b.id]);
  });

  it('is a no-op when nothing matches', async () => {
    await appendFeedback(tmp, COMMENT, { now: AT });
    const result = await ackFeedback(tmp, ['fb_99'], { now: AT });
    expect(result.acked).toEqual([]);
    expect(result.archive).toBeNull();
    expect(await readPendingFeedback(tmp)).toHaveLength(1);
  });

  it('appends to an existing archive for the same day', async () => {
    const a = await appendFeedback(tmp, COMMENT, { now: AT });
    await ackFeedback(tmp, [a.id], { now: AT });
    const b = await appendFeedback(tmp, COMMENT, { now: AT });
    await ackFeedback(tmp, [b.id], { now: AT });
    expect(await readArchivedFeedback(tmp, '2026-08-08')).toHaveLength(2);
  });

  it('never destroys a line it could not parse', async () => {
    const a = await appendFeedback(tmp, COMMENT, { now: AT });
    await fsp.appendFile(paths.feedbackPendingFile(tmp), 'this line is not json\n');
    await ackFeedback(tmp, [a.id], { now: AT });
    const text = await fsp.readFile(paths.feedbackPendingFile(tmp), 'utf8');
    expect(text).toBe('this line is not json\n');
  });

  it('acks everything pending for one flow', async () => {
    await appendFeedback(tmp, COMMENT, { now: AT });
    await appendFeedback(tmp, { ...COMMENT, flow: 'search' }, { now: AT });
    const result = await ackAllPending(tmp, { flow: 'checkout' }, { now: AT });
    expect(result.acked).toHaveLength(1);
    expect((await readPendingFeedback(tmp)).map((entry) => entry.flow)).toEqual(['search']);
  });

  it('empties pending.jsonl when everything is acked', async () => {
    await appendFeedback(tmp, COMMENT, { now: AT });
    await ackAllPending(tmp, {}, { now: AT });
    expect(await fsp.readFile(paths.feedbackPendingFile(tmp), 'utf8')).toBe('');
    expect(await readPendingFeedback(tmp)).toEqual([]);
  });
});
