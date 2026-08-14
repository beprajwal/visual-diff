/**
 * The published name is `@beprajwal/visual-diff`; the bin is `vdiff`. Those are different strings,
 * and the product is called "visual-diff" in prose, so the unscoped name reads as correct
 * everywhere and is wrong in exactly one place: where it names the *package* a user installs.
 *
 * `npm install visual-diff` fetches an unrelated package published in 2015. Every hint that tells
 * a user to do that is a live wrong instruction, and they hide in error paths — the Chromium-missing
 * hint, the dependency-check hint, the missing-skills hint. Three were fixed by hand and a fourth
 * arrived in new code the same day, which is what makes this a guard rather than an assertion on
 * one message: it scans everything a user can read and fails on the class.
 *
 * Only package-identifier positions count. A skill id (`visual-diff-flows`), a directory
 * (`.claude/skills/visual-diff/`) and the product name in a sentence are all legitimately unscoped.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Directories a user's eyes or a runtime error message can reach. */
const ROOTS = ['src', 'scripts', 'skills', 'docs'];
const ROOT_FILES = ['README.md'];

const SCANNED = /\.(ts|tsx|mts|mjs|js|md|json)$/;

/**
 * Positions where `visual-diff` is naming the npm package rather than the product or a skill.
 * Each pattern requires the name to sit immediately after an install/import verb, so the scope
 * being present (`npx @beprajwal/visual-diff`) puts a `@beprajwal/` between them and no longer
 * matches — the patterns detect the *absence* of the scope by construction.
 */
const UNSCOPED = [
  { label: 'npx', re: /\bnpx\s+(?:-y\s+|--yes\s+)?visual-diff\b/g },
  { label: 'npm install', re: /\bnpm\s+(?:i|install|add)\s+(?:-g\s+|--global\s+)?visual-diff\b/g },
  // The repo is developed with pnpm, so its docs and hints reach for pnpm verbs too. Without these
  // the guard would keep passing while a new unscoped `pnpm add visual-diff` sat in the README.
  { label: 'pnpm dlx', re: /\bpnpm\s+dlx\s+visual-diff\b/g },
  { label: 'pnpm add', re: /\bpnpm\s+(?:i|install|add)\s+(?:-g\s+|--global\s+)?visual-diff\b/g },
  { label: 'reinstall hint', re: /\b[Rr]einstall\s+visual-diff\b/g },
  { label: 'import specifier', re: /\bfrom\s+['"]visual-diff['"/]/g },
  { label: 'require specifier', re: /\brequire\(\s*['"]visual-diff['"/]/g },
];

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // an optional directory (docs/, skills/) simply has nothing to scan
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else if (SCANNED.test(entry.name)) found.push(full);
  }
  return found;
}

describe('the published package name', () => {
  it('is never written unscoped where it names the package to install or import', async () => {
    const files = [
      ...ROOT_FILES.map((file) => join(repoRoot, file)),
      ...(await Promise.all(ROOTS.map((root) => walk(join(repoRoot, root))))).flat(),
    ];

    const offences: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const lines = source.split('\n');
      for (const { label, re } of UNSCOPED) {
        for (const line of lines) {
          re.lastIndex = 0;
          if (re.test(line)) {
            offences.push(`${relative(repoRoot, file)}: [${label}] ${line.trim()}`);
          }
        }
      }
    }

    expect(offences).toEqual([]);
  });

  it('scans a non-trivial number of files, so an empty glob cannot pass as clean', async () => {
    // Without this, a rename of `src/` would turn the guard above into a test that asserts nothing.
    const files = (await Promise.all(ROOTS.map((root) => walk(join(repoRoot, root))))).flat();
    expect(files.length).toBeGreaterThan(50);
  });

  it('catches each unscoped form, and clears the scoped one', () => {
    // Pins the patterns themselves: the guard is only worth its runtime if these still match.
    const bad = [
      'Run `npx visual-diff init` to start.',
      'npm install -g visual-diff',
      'npm i visual-diff',
      'pnpm add -g visual-diff',
      'pnpm dlx visual-diff init',
      'Reinstall visual-diff, or run `npm run build`.',
      "import { runFlow } from 'visual-diff';",
      'const v = require("visual-diff");',
    ];
    for (const line of bad) {
      const hit = UNSCOPED.some(({ re }) => {
        re.lastIndex = 0;
        return re.test(line);
      });
      expect(hit, line).toBe(true);
    }

    const good = [
      'Run `npx @beprajwal/visual-diff init` to start.',
      'npm install -g @beprajwal/visual-diff',
      'pnpm add -g @beprajwal/visual-diff',
      'Reinstall @beprajwal/visual-diff, or run `pnpm build`.',
      "import { runFlow } from '@beprajwal/visual-diff';",
      'The visual-diff skill teaches the loop.', // product name in prose
      'writes .claude/skills/visual-diff/SKILL.md', // a path
      'id: visual-diff-flows', // a skill id
      'npx vdiff run checkout', // the bin, which is not the package name
    ];
    for (const line of good) {
      const hit = UNSCOPED.some(({ re }) => {
        re.lastIndex = 0;
        return re.test(line);
      });
      expect(hit, line).toBe(false);
    }
  });
});
