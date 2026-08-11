/**
 * Rewrites `src/version.ts` and `action.yml` from `package.json`.
 *
 * `TOOL_VERSION` is a static export on purpose: it lands in `meta.json#env.tool` and in every
 * `--json` envelope, both read by agents, so it must resolve synchronously without touching the
 * filesystem. `version.test.ts` asserts it equals the manifest — a guard that is only useful if
 * something keeps the two in step.
 *
 * npm runs this from the `version` lifecycle script, after bumping the manifest and before the
 * release commit is created, so the constant and the tag can never disagree. Without it, the
 * version bump itself breaks the test suite and the release fails after publishing nothing.
 *
 * `action.yml` carries the same version twice over: its `version` input defaults to the package
 * version it installs, and the workflows `vdiff install github-actions` writes pin `@v<version>` from
 * `TOOL_VERSION` (CI spec D34). A tag whose action installed a different release of the CLI would
 * produce comments nobody can reproduce, so the default is stamped here and asserted by
 * `tests/packaging/action.test.ts`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
const versionPath = fileURLToPath(new URL('../src/version.ts', import.meta.url));
const actionPath = fileURLToPath(new URL('../action.yml', import.meta.url));

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

/*
 * `action.yml`: the `version` input's default, which is the release of the CLI the action installs.
 *
 * Matched on the input's own `default:` rather than on any `default:` in the file, because several
 * other inputs have one and a greedy replacement would set `fail-on` to a version number.
 */
const actionSource = await readFile(actionPath, 'utf8');
const actionPattern = /(\n  version:\n(?:.*\n)*?    default: ')[^']*(')/;
if (!actionPattern.test(actionSource)) {
  throw new Error(`could not find the version input's default in ${actionPath}`);
}
const actionUpdated = actionSource.replace(actionPattern, `$1${version}$2`);
if (actionUpdated !== actionSource) {
  await writeFile(actionPath, actionUpdated, 'utf8');
  console.log(`version → ${version} (action.yml)`);
} else {
  console.log(`action.yml already ${version}`);
}
