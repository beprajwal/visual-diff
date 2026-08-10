/**
 * store/internal/yaml-issues — turning a zod failure over a YAML document into `ValidationIssue`s
 * that point at a file, a line and the offending key (spec §10, row 1).
 *
 * Extracted verbatim from `store/config.ts`, which was the only file that needed it until
 * `.visual-diff/e2e-map.yaml` arrived. Both files are strict-schema YAML the user hand-writes, and
 * both fail for the same reasons — an unknown key, a missing one, a wrong type — so a second copy
 * of this logic would be a second set of wordings for identical mistakes. A silently ignored
 * `flws:` typo is how a user concludes their pins "don't work", which is exactly the failure the
 * config loader already refuses to allow.
 */

import * as YAML from 'yaml';
import { z } from 'zod';

import type { SourceLocation, ValidationIssue } from '../../types.js';

/** Derived from the function rather than named directly, so a yaml type rename cannot break us. */
export type ParsedYamlDocument = ReturnType<typeof YAML.parseDocument>;

export function formatKeyPath(keyPath: readonly (string | number)[]): string {
  let out = '';
  for (const part of keyPath) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out === '' ? part : `.${part}`;
  }
  return out;
}

function nodeRange(node: unknown): number | null {
  if (node !== null && typeof node === 'object' && 'range' in node) {
    const range = (node as { range?: unknown }).range;
    if (Array.isArray(range) && typeof range[0] === 'number') return range[0];
  }
  return null;
}

/**
 * Point at the offending key, falling back to the nearest ancestor that exists in the document —
 * which is what a missing required key needs, since the key itself has no node.
 */
export function locate(
  doc: ParsedYamlDocument,
  lineCounter: YAML.LineCounter,
  file: string,
  keyPath: readonly (string | number)[],
): SourceLocation {
  const key = keyPath.length === 0 ? undefined : formatKeyPath(keyPath);
  for (let i = keyPath.length; i >= 0; i -= 1) {
    const prefix = keyPath.slice(0, i);
    let node: unknown;
    try {
      node = prefix.length === 0 ? doc.contents : doc.getIn(prefix, true);
    } catch {
      node = undefined;
    }
    const offset = nodeRange(node);
    if (offset !== null) {
      const pos = lineCounter.linePos(offset);
      const at: SourceLocation = { file, line: pos.line, column: pos.col };
      if (key !== undefined) at.key = key;
      return at;
    }
  }
  const at: SourceLocation = { file };
  if (key !== undefined) at.key = key;
  return at;
}

export function zodIssues(
  error: z.ZodError,
  doc: ParsedYamlDocument,
  lineCounter: YAML.LineCounter,
  file: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const keyPath = [...issue.path, key];
        issues.push({
          code: 'unknown-key',
          message: `unknown key "${formatKeyPath(keyPath)}"`,
          at: locate(doc, lineCounter, file, keyPath),
        });
      }
      continue;
    }
    if (issue.code === 'invalid_type' && issue.received === 'undefined') {
      issues.push({
        code: 'missing-key',
        message: `missing required key "${formatKeyPath(issue.path)}"`,
        at: locate(doc, lineCounter, file, issue.path),
      });
      continue;
    }
    issues.push({
      code: issue.code === 'invalid_type' ? 'invalid-type' : 'invalid-value',
      message: `${formatKeyPath(issue.path) || 'config'}: ${issue.message}`,
      at: locate(doc, lineCounter, file, issue.path),
    });
  }
  return issues;
}

/** YAML that would not parse at all, located at the character the parser stopped on. */
export function yamlSyntaxIssues(
  doc: ParsedYamlDocument,
  lineCounter: YAML.LineCounter,
  file: string,
): ValidationIssue[] {
  return doc.errors.map((err) => {
    const offset = Array.isArray(err.pos) && typeof err.pos[0] === 'number' ? err.pos[0] : null;
    const pos = offset === null ? null : lineCounter.linePos(offset);
    const at: SourceLocation = { file };
    if (pos !== null) {
      at.line = pos.line;
      at.column = pos.col;
    }
    return { code: 'invalid-yaml', message: err.message, at };
  });
}
