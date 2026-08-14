/**
 * The tool version, as a static export.
 *
 * It lands in `meta.json#env.tool` (spec §6) and in every `--json` envelope, both of which are read
 * by agents, so it must be available synchronously and without touching the filesystem. `version.test.ts`
 * asserts it equals the version in `package.json`, which is what keeps the constant honest.
 */
export const TOOL_VERSION = '0.5.1';

export function toolVersion(): string {
  return TOOL_VERSION;
}
