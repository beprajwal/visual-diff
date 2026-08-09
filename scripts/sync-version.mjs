/**
 * Rewrites `src/version.ts` from `package.json`.
 *
 * `TOOL_VERSION` is a static export on purpose: it lands in `meta.json#env.tool` and in every
 * `--json` envelope, both read by agents, so it must resolve synchronously without touching the
 * filesystem. `version.test.ts` asserts it equals the manifest — a guard that is only useful if
 * something keeps the two in step.
 *
 * npm runs this from the `version` lifecycle script, after bumping the manifest and before the
 * release commit is created, so the constant and the tag can never disagree. Without it, the
 * version bump itself breaks the test suite and the release fails after publishing nothing.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
const versionPath = fileURLToPath(new URL('../src/version.ts', import.meta.url));

const { version } = JSON.parse(await readFile(manifestPath, 'utf8'));
if (typeof version !== 'string' || version.length === 0) {
  throw new Error(`package.json has no usable version field (got ${JSON.stringify(version)})`);
}

const source = await readFile(versionPath, 'utf8');
const updated = source.replace(
  /export const TOOL_VERSION = '[^']*';/,
  `export const TOOL_VERSION = '${version}';`,
);

if (updated === source && !source.includes(`TOOL_VERSION = '${version}'`)) {
  throw new Error(`could not find the TOOL_VERSION declaration in ${versionPath}`);
}

if (updated !== source) {
  await writeFile(versionPath, updated, 'utf8');
  console.log(`version → ${version} (src/version.ts)`);
} else {
  console.log(`version already ${version}`);
}
