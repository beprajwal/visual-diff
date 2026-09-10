/** Advance the action's major tag after a stable release has been published successfully. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const stable = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const releaseTag = process.env.GITHUB_REF_NAME ?? '';
const version = stable.exec(releaseTag);
if (!version) {
  console.log(`Skipping major tag promotion for non-stable ref: ${releaseTag}`);
  process.exit(0);
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const commit = git('rev-parse', 'HEAD');
if (`v${manifest.version}` !== releaseTag || git('rev-parse', `${releaseTag}^{commit}`) !== commit) {
  throw new Error('The checked-out commit and package version must match the release tag');
}

const majorTag = `v${version[1]}`;
const ref = `refs/tags/${majorTag}`;
const previous = git('ls-remote', '--refs', 'origin', ref).split('\t')[0];
if (previous) {
  git('fetch', '--no-tags', 'origin', ref);
  const current = JSON.parse(git('show', 'FETCH_HEAD:package.json'));
  const currentVersion = stable.exec(`v${current.version}`);
  if (!currentVersion || currentVersion[1] !== version[1]) {
    throw new Error(`${majorTag} does not point to a stable release in the expected major`);
  }
  const minorDelta = BigInt(version[2]) - BigInt(currentVersion[2]);
  const patchDelta = BigInt(version[3]) - BigInt(currentVersion[3]);
  if (minorDelta < 0n || (minorDelta === 0n && patchDelta <= 0n)) {
    console.log(`${majorTag} already points to ${current.version}; not moving it to ${manifest.version}`);
    process.exit(0);
  }
}

// A concurrent release can advance the tag after our read. Reject that race instead of
// overwriting it; rerunning the workflow will compare against the new version.
git('push', `--force-with-lease=${ref}:${previous}`, 'origin', `${commit}:${ref}`);
console.log(`${majorTag} now points to ${releaseTag} (${commit})`);
