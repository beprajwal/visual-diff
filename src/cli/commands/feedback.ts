/**
 * `vdiff feedback [--json] [--ack]` — pull the comments a human left in the report (D6, spec §9).
 *
 * Delivery is pull-based because that is the only mechanism all four target harnesses share.
 * `--ack` archives exactly what this invocation read into `feedback/archive/<date>.jsonl`, so the
 * same comment is never handed to an agent twice, and anything appended while the agent was
 * working stays pending for the next pull.
 *
 * Each entry carries a crop path, which is the point: the agent can look at exactly the thing the
 * human pointed at.
 */

import type { FeedbackEntry } from '../../types.js';
import type { Invocation } from '../args.js';
import type { CommandContext, CommandResult } from '../command.js';
import type { FeedbackData } from '../shapes.js';

type FeedbackInvocation = Extract<Invocation, { kind: 'feedback' }>;

function describe(entry: FeedbackEntry): string[] {
  const where = [
    entry.flow,
    entry.pair,
    entry.step ?? null,
    entry.viewport ?? null,
    entry.findingId ?? null,
    entry.element ?? null,
  ]
    .filter((part): part is string => part !== null)
    .join('  ');

  const lines = [`[${entry.id}] ${entry.ts}  ${where}`];
  for (const line of entry.text.split('\n')) lines.push(`    ${line}`);
  if (entry.crop !== undefined) lines.push(`    crop: ${entry.crop}`);
  return lines;
}

export async function feedback(
  ctx: CommandContext,
  invocation: FeedbackInvocation,
): Promise<CommandResult<FeedbackData>> {
  const config = await ctx.ports.loadConfig(ctx.cwd);
  const store = await ctx.ports.openStore(config);
  const pending = await store.readPendingFeedback();

  let archive: string | null = null;
  let entries = pending;
  if (invocation.ack && pending.length > 0) {
    const acked = await store.ackFeedback(pending);
    archive = acked.archive;
    entries = acked.acked;
  }

  const human: string[] =
    entries.length === 0
      ? ['no pending feedback']
      : [`${entries.length} pending ${entries.length === 1 ? 'comment' : 'comments'}`, ''];
  for (const entry of entries) human.push(...describe(entry));
  if (archive !== null) {
    human.push('');
    human.push(`acked ${entries.length} → ${archive}`);
  }

  return {
    data: { count: entries.length, entries, acked: invocation.ack, archive },
    human,
  };
}
