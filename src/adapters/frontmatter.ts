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

/** A single frontmatter field. Values are emitted verbatim, so quote through `yamlString`. */
export type FrontmatterField = readonly [key: string, value: string];

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

/** Compose a markdown document with YAML frontmatter above a body. */
export function withFrontmatter(fields: readonly FrontmatterField[], body: string): string {
  const lines = fields.map(([key, value]) => `${key}: ${value}`);
  return ['---', ...lines, '---', '', body.trim(), ''].join('\n');
}

/** Split a composed document back into its frontmatter lines and body. Null when it has none. */
export function splitFrontmatter(doc: string): { fields: Record<string, string>; body: string } | null {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(doc.replace(/\r\n/g, '\n'));
  if (match === null) return null;
  const fields: Record<string, string> = {};
  for (const line of (match[1] as string).split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { fields, body: match[2] as string };
}
