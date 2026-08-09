/**
 * YAML frontmatter composition, shared by every harness adapter.
 *
 * The `SKILL.md` bodies under `skills/` carry no frontmatter at all: which keys a harness wants —
 * `name`, `description`, `argument-hint`, `allowed-tools` — is the one thing that genuinely differs
 * between Claude Code, Codex, opencode and pi. Composing it here, from the neutral manifest, is what
 * lets the same markdown ship to all of them.
 *
 * Nothing here reads or writes a file.
 */

/**
 * A nested one-level map, as `metadata:` is (D17, and the Agent Skills spec's only sanctioned home
 * for client-specific keys). Values are emitted verbatim, so quote through `yamlString` — the spec
 * requires string values, and unquoted `0.2.0` or `1.0` do not survive a YAML parse as strings.
 */
export type FrontmatterMap = Readonly<Record<string, string>>;

/** Either a scalar or a one-level map. Deeper nesting is not a shape any harness asks for. */
export type FrontmatterValue = string | FrontmatterMap;

/** A single frontmatter field. Values are emitted verbatim, so quote through `yamlString`. */
export type FrontmatterField = readonly [key: string, value: FrontmatterValue];

/**
 * YAML-safe double-quoted scalar on one line. Descriptions come from `manifest.json` and may contain
 * colons, quotes and newlines, every one of which would otherwise change the parse.
 */
export function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim()}"`;
}

/** A YAML flow sequence of quoted scalars: `["a", "b"]`. */
export function yamlList(values: readonly string[]): string {
  return `[${values.map((value) => yamlString(value)).join(', ')}]`;
}

/** Strip the quoting `yamlString` applied. Leaves an already-bare scalar alone. */
export function yamlUnquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/**
 * Compose a markdown document with YAML frontmatter above a body.
 *
 * A map value is emitted as an indented block under a bare key. An *empty* map is dropped entirely
 * rather than emitted as a bare `metadata:`, which YAML reads as null and at least one harness
 * rejects as a malformed field.
 */
export function withFrontmatter(fields: readonly FrontmatterField[], body: string): string {
  const lines: string[] = [];
  for (const [key, value] of fields) {
    if (typeof value === 'string') {
      lines.push(`${key}: ${value}`);
      continue;
    }
    const entries = Object.entries(value);
    if (entries.length === 0) continue;
    lines.push(`${key}:`);
    for (const [child, childValue] of entries) lines.push(`  ${child}: ${childValue}`);
  }
  return ['---', ...lines, '---', '', body.trim(), ''].join('\n');
}

/**
 * Split a composed document back into its frontmatter lines and body. Null when it has none.
 *
 * Nested fields are flattened to `parent.child` keys, so a caller reading the version stamp asks
 * for `metadata.x-vdiff-version` and gets one string back. The parent key is retained with an empty
 * value, which is what it literally carries on the line.
 */
export function splitFrontmatter(doc: string): { fields: Record<string, string>; body: string } | null {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(doc.replace(/\r\n/g, '\n'));
  if (match === null) return null;
  const fields: Record<string, string> = {};
  let parent: string | null = null;
  for (const line of (match[1] as string).split('\n')) {
    if (line.trim() === '') continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    const nested = /^\s/.test(line);
    if (nested && parent !== null) {
      fields[`${parent}.${key}`] = value;
      continue;
    }
    fields[key] = value;
    parent = value === '' ? key : null;
  }
  return { fields, body: match[2] as string };
}
