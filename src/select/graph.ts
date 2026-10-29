/**
 * The import graph a selection walks (selection spec §3, D60).
 *
 * Built from source text with regular expressions rather than from a TypeScript program. The
 * question is "which files import this one", which a module boundary answers the same way a type
 * checker would, in a fraction of the time and with no dependency on the project's toolchain. What
 * the regexes must get right is short and each item has a test: a barrel re-export binds a name to
 * the module that exports it, not to everything the barrel touches; a `type` import binds nothing,
 * because it cannot change what a page renders; a side-effect or dynamic import binds everything.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

/** Repo-relative, `/`-separated. The graph never holds an absolute path. */
export type SourcePath = string;

/** `target -> the files that import it`. */
export type ImportGraph = Map<SourcePath, Set<SourcePath>>;

export type SourceMap = Map<SourcePath, string>;

/** What the graph reads. Anything else is reachable only as an import target (a stylesheet). */
export const SCANNED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

/** Extensions tried, in order, for an import that names none. */
const RESOLVED_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.json',
  '.svg',
] as const;

export const toPosix = (file: string): SourcePath => file.split(path.sep).join('/');

function walk(directory: string, visit: (file: string) => void): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, visit);
    } else if (entry.isFile()) {
      visit(full);
    }
  }
}

const isFile = (file: string): boolean => existsSync(file) && statSync(file).isFile();

/** Every scanned file under the source directories, keyed by repo-relative path. */
export function readSources(root: string, directories: readonly string[]): SourceMap {
  const sources: SourceMap = new Map();
  for (const directory of directories) {
    walk(path.join(root, directory), (full) => {
      if (!SCANNED_EXTENSIONS.has(path.extname(full))) return;
      sources.set(toPosix(path.relative(root, full)), readFileSync(full, 'utf8'));
    });
  }
  return sources;
}

/**
 * The repo-relative file an import specifier names, or null for a package import. Aliases are
 * tried longest first, so `@app/modules/` wins over `@app/` for a specifier both would match.
 */
export function resolveSpecifier(
  root: string,
  importer: SourcePath,
  specifier: string,
  aliases: Readonly<Record<string, string>>,
): SourcePath | null {
  let base: string;
  if (specifier.startsWith('.')) {
    base = path.posix.join(path.posix.dirname(importer), specifier);
  } else {
    const prefixes = Object.keys(aliases).sort((a, b) => b.length - a.length);
    const alias = prefixes.find((prefix) =>
      prefix.endsWith('/') ? specifier.startsWith(prefix) : specifier === prefix,
    );
    if (alias === undefined) return null;
    const target = aliases[alias] as string;
    base = alias.endsWith('/') ? target + specifier.slice(alias.length) : target;
  }
  const candidates = [
    base,
    ...RESOLVED_EXTENSIONS.map((extension) => base + extension),
    ...RESOLVED_EXTENSIONS.map((extension) => path.posix.join(base, `index${extension}`)),
  ];
  const hit = candidates.find((candidate) => isFile(path.join(root, candidate)));
  return hit === undefined ? null : path.posix.normalize(hit);
}

export interface ImportEntry {
  /** The names bound at runtime, as the target module exports them; `*` stands for all of them. */
  names: Set<string>;
  specifier: string;
  reexport: boolean;
}

const IMPORT_FROM = /\bimport\s+(type\s+)?([^'"`;]*?)\s+from\s*['"]([^'"]+)['"]/g;
const EXPORT_FROM = /\bexport\s+(type\s+)?([^'"`;]*?)\s+from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT = /\bimport\s*['"]([^'"]+)['"]/g;
const DYNAMIC = /\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;

/** The names a clause binds, keyed to what the target module calls them. */
export function namesInClause(clause: string, typeOnly: boolean): Set<string> {
  const names = new Set<string>();
  if (typeOnly) return names;
  let rest = clause.trim();
  const braces = rest.match(/\{([^}]*)\}/);
  if (braces !== null) {
    for (const item of (braces[1] as string).split(',')) {
      const name = item.trim();
      if (name === '' || /^type\s+/.test(name)) continue;
      names.add(name.replace(/\s+as\s+[\w$]+$/, ''));
    }
    rest = rest.replace(braces[0], '');
  }
  if (/\*\s+as\s+[\w$]+/.test(rest) || rest.trim() === '*') names.add('*');
  else if (/^[\w$]+/.test(rest.replace(/^,\s*/, '').trim())) names.add('default');
  return names;
}

export function importsOf(text: string): ImportEntry[] {
  const found: ImportEntry[] = [];
  for (const match of text.matchAll(IMPORT_FROM)) {
    found.push({
      names: namesInClause(match[2] as string, match[1] !== undefined),
      specifier: match[3] as string,
      reexport: false,
    });
  }
  for (const match of text.matchAll(EXPORT_FROM)) {
    found.push({
      names: namesInClause(match[2] as string, match[1] !== undefined),
      specifier: match[3] as string,
      reexport: true,
    });
  }
  for (const pattern of [SIDE_EFFECT, DYNAMIC]) {
    for (const match of text.matchAll(pattern)) {
      found.push({ names: new Set(['*']), specifier: match[1] as string, reexport: false });
    }
  }
  return found;
}

interface Reexports {
  named: Map<string, SourcePath>;
  star: SourcePath[];
}

/**
 * Build the graph. A name imported from a barrel depends on the module that exports it; a name the
 * barrel defines itself, or gets from a wholesale `export *`, depends on the barrel and on each of
 * those modules. A `*` import depends on the barrel and everything it re-exports wholesale.
 */
export function buildImportGraph(
  root: string,
  sources: SourceMap,
  aliases: Readonly<Record<string, string>>,
): ImportGraph {
  const graph: ImportGraph = new Map();
  const barrels = new Map<SourcePath, Reexports>();

  const reexportsOf = (file: SourcePath): Reexports => {
    const cached = barrels.get(file);
    if (cached !== undefined) return cached;
    const entry: Reexports = { named: new Map(), star: [] };
    for (const item of importsOf(sources.get(file) ?? '')) {
      if (!item.reexport) continue;
      const target = resolveSpecifier(root, file, item.specifier, aliases);
      if (target === null) continue;
      if (item.names.has('*')) entry.star.push(target);
      for (const name of item.names) if (name !== '*') entry.named.set(name, target);
    }
    barrels.set(file, entry);
    return entry;
  };

  const link = (target: SourcePath, importer: SourcePath): void => {
    if (target === importer) return;
    let importers = graph.get(target);
    if (importers === undefined) {
      importers = new Set();
      graph.set(target, importers);
    }
    importers.add(importer);
  };

  const linkName = (importer: SourcePath, target: SourcePath, name: string, depth: number): void => {
    const barrel = reexportsOf(target);
    const direct = barrel.named.get(name);
    if (direct !== undefined && depth < 8) {
      linkName(importer, direct, name, depth + 1);
      return;
    }
    link(target, importer);
    if (depth < 8) for (const module of barrel.star) linkName(importer, module, name, depth + 1);
  };

  for (const [importer, text] of sources) {
    for (const entry of importsOf(text)) {
      if (entry.names.size === 0) continue;
      const target = resolveSpecifier(root, importer, entry.specifier, aliases);
      if (target === null) continue;
      if (entry.names.has('*')) {
        link(target, importer);
        for (const module of reexportsOf(target).star) link(module, importer);
      } else {
        for (const name of entry.names) linkName(importer, target, name, 0);
      }
    }
  }
  return graph;
}

/** Every file that, directly or through others, imports one of the seeds. Includes the seeds. */
export function filesReaching(graph: ImportGraph, seeds: readonly SourcePath[]): Set<SourcePath> {
  const seen = new Set<SourcePath>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift() as SourcePath;
    for (const importer of graph.get(current) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      queue.push(importer);
    }
  }
  return seen;
}
