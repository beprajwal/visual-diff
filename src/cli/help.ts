/**
 * cli — usage text, generated from the command table so it can never drift from what parses.
 */

import { COMMANDS } from './args.js';
import type { CommandResult } from './command.js';
import type { HelpData, VersionData } from './shapes.js';

const HEADER = [
  'vdiff — replay a UI workflow across revisions, diff the results, review them live.',
  '',
  'Usage: vdiff <command> [options]',
  '',
];

const FOOTER = [
  '',
  'Every command accepts --json and emits a single envelope object on stdout.',
  'Exit codes: 0 success, 1 run or replay failure, 2 config or spec error, 3 gate tripped.',
  '`vdiff diff` exits 0 even when findings exist — findings are information, not a gate.',
  'Exit 3 is reachable only from `vdiff comment --fail-on high|any`, which nothing sets by default.',
];

export function help(topic?: string): CommandResult<HelpData> {
  const entries = Object.entries(COMMANDS).map(([name, spec]) => ({
    name,
    usage: spec.usage,
    summary: spec.summary,
  }));

  if (topic !== undefined) {
    const spec = COMMANDS[topic];
    if (spec !== undefined) {
      return {
        data: { usage: [spec.usage], commands: [{ name: topic, usage: spec.usage, summary: spec.summary }] },
        human: [spec.usage, '', `  ${spec.summary}`, ...FOOTER],
      };
    }
  }

  const width = entries.reduce((max, entry) => Math.max(max, entry.usage.length), 0);
  const human = [
    ...HEADER,
    ...entries.map((entry) => `  ${entry.usage.padEnd(width)}   ${entry.summary}`),
    ...FOOTER,
  ];

  return { data: { usage: entries.map((entry) => entry.usage), commands: entries }, human };
}

export function version(value: string): CommandResult<VersionData> {
  return { data: { version: value }, human: [value] };
}
