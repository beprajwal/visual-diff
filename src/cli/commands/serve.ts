/**
 * `vdiff serve [--open] [--port]` — the live local report (spec §9).
 *
 * The URL is printed (or emitted in the envelope) *before* the process blocks, so an agent can
 * hand the link to a human immediately and keep the server running in the background. The command
 * then waits for SIGINT/SIGTERM and closes the server cleanly, which removes `serve.json`.
 *
 * `--open` is passed through to the report module rather than shelled out here: launching a
 * browser is platform detail, and the CLI holds no domain logic.
 */

import type { ServeInfo, ServeOptions } from '../../types.js';
import type { Invocation } from '../args.js';
import type { CommandContext, CommandResult } from '../command.js';

type ServeInvocation = Extract<Invocation, { kind: 'serve' }>;

export async function serve(
  ctx: CommandContext,
  invocation: ServeInvocation,
): Promise<CommandResult<ServeInfo>> {
  const options: ServeOptions = { open: invocation.open, json: invocation.json };
  if (invocation.port !== undefined) options.port = invocation.port;

  const config = await ctx.ports.loadConfig(ctx.cwd);
  const handle = await ctx.ports.serveReport(config, options);

  return {
    data: handle.info,
    human: [
      `report: ${handle.info.url}`,
      'live: the page follows new runs, and comments you leave come back through `vdiff feedback`.',
      'stop with ctrl-c',
    ],
    after: async () => {
      await ctx.waitForShutdown();
      await handle.close();
    },
  };
}
