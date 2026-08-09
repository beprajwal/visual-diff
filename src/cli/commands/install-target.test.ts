/**
 * Scope resolution (harness-packaging spec §3 D16, §5).
 *
 * Three rules, and the interesting one is the third: `--dir` overrides the *root* and leaves the
 * layout alone. Getting that backwards would make `--global --dir <tmp>` write project paths, which
 * is precisely the combination every global-scope test in this suite relies on to avoid installing
 * into the machine running it.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SCOPES, resolveTarget, scopeRoot } from './install-target.js';

const CWD = resolve('/project');
const HOME = resolve('/home/u');

describe('scopeRoot', () => {
  it('roots a project install at the invocation directory and a global one at home', () => {
    expect(scopeRoot('project', CWD, HOME)).toBe(CWD);
    expect(scopeRoot('global', CWD, HOME)).toBe(HOME);
  });

  it('reports both scopes, project first — the order --list and --check walk', () => {
    expect(SCOPES).toEqual(['project', 'global']);
  });

  it('lets a --dir override the root of every scope, so --check can look where --dir wrote', () => {
    expect(scopeRoot('project', CWD, HOME, '/elsewhere')).toBe(resolve('/elsewhere'));
    expect(scopeRoot('global', CWD, HOME, '/elsewhere')).toBe(resolve('/elsewhere'));
  });

  it('resolves a relative --dir override against the invocation directory, never against home', () => {
    expect(scopeRoot('global', CWD, HOME, 'staging')).toBe(resolve(CWD, 'staging'));
    expect(scopeRoot('global', CWD, HOME, 'staging')).not.toBe(resolve(HOME, 'staging'));
  });
});

describe('resolveTarget', () => {
  it('defaults to a project install rooted at the invocation directory', () => {
    expect(resolveTarget({}, CWD, HOME)).toEqual({ scope: 'project', root: CWD });
  });

  it('--global selects the user-level layout under the home directory', () => {
    expect(resolveTarget({ global: true }, CWD, HOME)).toEqual({ scope: 'global', root: HOME });
  });

  it('--dir overrides the root, relative to the invocation directory', () => {
    expect(resolveTarget({ dir: 'packages/web' }, CWD, HOME)).toEqual({
      scope: 'project',
      root: resolve(CWD, 'packages/web'),
    });
  });

  it('takes an absolute --dir as given', () => {
    expect(resolveTarget({ dir: resolve('/elsewhere') }, CWD, HOME)).toEqual({
      scope: 'project',
      root: resolve('/elsewhere'),
    });
  });

  it('--dir overrides the root but not the layout, so --global --dir stays a global install', () => {
    expect(resolveTarget({ global: true, dir: 'staging' }, CWD, HOME)).toEqual({
      scope: 'global',
      root: resolve(CWD, 'staging'),
    });
  });

  it('never resolves the home directory for a project install', () => {
    expect(resolveTarget({}, CWD, HOME).root).not.toBe(HOME);
    expect(resolveTarget({ dir: 'x' }, CWD, HOME).root).not.toBe(HOME);
  });
});
