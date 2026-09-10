import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/promote-action-tag.mjs', import.meta.url));
let root: string;
let repo: string;
let remote: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vdiff-release-'));
  repo = join(root, 'repo');
  remote = join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['clone', remote, repo], { stdio: 'ignore' });
  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'Test');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function release(version: string): string {
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version }));
  git('add', 'package.json');
  git('commit', '-m', version);
  git('tag', '-a', `v${version}`, '-m', version);
  git('push', 'origin', `refs/tags/v${version}`);
  return git('rev-parse', 'HEAD');
}

function promote(version: string): string {
  return execFileSync(process.execPath, [script], {
    cwd: repo, env: { ...process.env, GITHUB_REF_NAME: `v${version}` }, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const target = (major: string) => git('ls-remote', '--refs', 'origin', `refs/tags/v${major}`).split('\t')[0];

it('creates a major tag and advances it across patch and minor releases', () => {
  for (const version of ['0.19.2', '0.19.3', '0.20.0']) {
    const commit = release(version);
    promote(version);
    expect(target('0')).toBe(commit);
    expect(git('rev-parse', `v${version}^{commit}`)).toBe(commit);
  }
});

it('does not let old or repeated releases move the major tag backwards', () => {
  const first = release('0.19.2');
  const latest = release('0.20.0');
  promote('0.20.0');
  promote('0.20.0');
  git('checkout', first);
  promote('0.19.2');
  expect(target('0')).toBe(latest);
});

it('keeps major versions separate and excludes prereleases', () => {
  const zero = release('0.19.2');
  promote('0.19.2');
  const one = release('1.0.0');
  promote('1.0.0');
  release('1.1.0-beta.1');
  promote('1.1.0-beta.1');
  expect(target('0')).toBe(zero);
  expect(target('1')).toBe(one);
});

it.each(['version', 'commit'])('refuses to promote a tag with a mismatched %s', mismatch => {
  release('0.19.2');
  if (mismatch === 'version') release('0.19.3');
  else git('commit', '--allow-empty', '-m', 'unreleased change');
  expect(() => promote('0.19.2')).toThrow();
  expect(target('0')).toBe('');
});
