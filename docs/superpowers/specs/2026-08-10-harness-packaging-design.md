# Harness Packaging — Design (Subsystem 1: Codex, opencode, pi)

Date: 2026-08-10
Status: Approved for planning
Builds on: `2026-08-08-visual-diff-design.md` (slice 1, D1–D9)
Supersedes: `2026-08-09-harness-packaging-notes.md` (parked notes; kept for history)

## 1. Problem

Slice 1 shipped `vdiff install claude-code`, which writes three skills and two commands into
`.claude/`. The CLI was built harness-agnostic on purpose, and the skills were made real files with
harness-neutral bodies precisely so other agents could be added cheaply.

This slice adds Codex, opencode and pi, and makes installed files maintainable — an installed skill
is a copy that documents specific commands and flags, and a copy that has drifted from the CLI is
worse than no copy at all.

## 2. Scope

### In

- Codex, opencode and pi adapters, alongside the existing Claude Code one
- A harness registry expressed as data, so a fifth harness is a table entry rather than new code
- Project-local and global install targets, with a precedence rule
- Version stamping and `vdiff install --check` drift detection
- `AGENTS.md` block management for the harnesses that read it

### Explicit non-goals

- **No MCP adapter.** Worth revisiting once MCP configuration is uniform across these four; today it
  is not, and it would trade a one-line `npx` install for per-harness setup.
- **No hook-based push feedback.** Pull (`vdiff feedback`) is the only mechanism all four share
  (D6). Hooks are a per-harness bonus, not a baseline.
- **No harness-specific skill content.** The neutrality test stays load-bearing: bodies are shared,
  and only frontmatter and paths differ.
- **No new CLI capability.** This slice changes where files land and how they stay current. Nothing
  about capture, diffing or the report changes.

## 3. Decisions and rationale

Continues the decision record. Slice 1 is D1–D9; API mocking is D10–D14.

**D15 — Thin parity, not native-per-harness.**
Write the instruction and skill files each harness actually reads, plus its command concept where it
has one. Where a harness has no skill mechanism, fall back to an instructions file pointing at the
CLI. Rejected: using each harness's richest mechanism (four codepaths, four ways to break, for
capability the CLI already provides) and a single lowest-common-denominator `AGENTS.md` (weakest
integration, and it discards the skill support three of the four genuinely have).

**D16 — Project-local by default, `--global` to opt out, project wins.**
The two cases are genuinely different: a solo user wants install-once-per-machine, a team wants
skills committed beside `.visual-diff/flows/` so everyone drives the tool identically. When both
exist, the project install wins, matching how every one of these harnesses resolves its own config.
`vdiff install --check` reports both, so a stale global copy shadowed by a project copy is still
visible rather than silently ignored.

**D17 — Version stamp in frontmatter, checked on demand, never auto-applied.**
Installed files carry `x-vdiff-version` (the CLI version that wrote them) and `x-vdiff-source` (the
package name). `vdiff install --check` reports drift; `--force` rewrites. Frontmatter because it
survives the file being copied between machines, and an unknown key is ignored by every harness that
reads this format. Rejected: auto-refreshing installed files during `vdiff run`, which mutates a
committed directory unprompted and produces surprise diffs in the user's working tree — and, for a
project install, in their next commit.

**D18 — Shared `.agents/skills/` where the harness reads it, native paths where it does not.**
`.agents/skills/` is an emerging cross-agent convention; targeting it gets cheaper as more agents
adopt it. Claude Code and pi read their own directories, so they get those. Rejected: always writing
native paths (the same three skills duplicated into several directories of one repo, free to drift)
and writing only the shared directory (breaks Claude Code and pi outright). Install output always
names the real directory written, because `vdiff install codex` writing something not called "codex"
is otherwise baffling.

**D19 — `AGENTS.md` is edited within a delimited block, never overwritten.**
Three of the four harnesses read `AGENTS.md`, and the user owns that file. The adapter manages only
the content between `<!-- vdiff:start -->` and `<!-- vdiff:end -->`, replacing that span on
reinstall and leaving everything else byte-identical. If the file does not exist it is created
containing just the block. Rejected: appending (duplicates on every reinstall) and overwriting
(destroys the user's own instructions, which is unrecoverable if uncommitted).

## 4. The harness registry

Each harness is a data entry. Adding a fifth is a table row.

```ts
interface Harness {
  id: 'claude-code' | 'codex' | 'opencode' | 'pi'
  label: string
  skills: Target | null        // null = no skill mechanism
  commands: Target | null
  instructions: Target | null  // AGENTS.md-style
  frontmatter: (skill: SkillMeta, version: string) => Record<string, unknown>
}
interface Target { project: string; global: string }
```

### Path map

Verified against current documentation on 2026-08-09; sources in §8.

| harness | skills (project / global) | commands | instructions |
|---|---|---|---|
| Claude Code | `.claude/skills/` / `~/.claude/skills/` | `.claude/commands/*.md` | — |
| Codex | `.agents/skills/` (repo + global) | `~/.codex/prompts` | `AGENTS.md`, `~/.codex/AGENTS.md` |
| pi | `.pi/skills/<n>/SKILL.md` / `~/.pi/agent/skills/` | — (invoked as `/skill:name`) | `AGENTS.md`, `AGENTS.override.md` |
| opencode | **none — see below** | `.opencode/commands/*.md` / `~/.config/opencode/commands/` | `AGENTS.md` |

### opencode has no skills entry, deliberately

opencode's documentation describes commands and `AGENTS.md`; it does not document a skill mechanism.
Rather than guess a path, opencode gets `skills: null` and receives commands plus an `AGENTS.md`
block pointing at the CLI and at `.agents/skills/`. **This is recorded as unverified as of
2026-08-09, not as a design choice** — if opencode supports skills, this entry should gain one.

Two further items were deliberately not resolved and must be checked during implementation rather
than assumed:

1. **pi's SKILL.md frontmatter fields.** Its documentation describes paths, not required fields.
2. **Codex `.agents/skills` precedence** between repository-level and global.

Both are cheap to verify from the harness itself; neither is safe to invent.

## 5. Install behaviour

```
vdiff install <harness> [--global] [--dir <path>] [--force] [--dry-run]
vdiff install --list                 harnesses, their targets, and what would be written
vdiff install --check [<harness>]    report drift without writing
```

- Default target is project-local; `--global` writes the user-level target; `--dir` overrides both.
- Existing files are never overwritten without `--force`; the conflict names the file.
- `--dry-run` prints every path it would write and writes nothing.
- Unknown harness exits 2, listing the supported ones.
- Output names the actual directory written, including when it resolves to `.agents/skills/`.
- `--json` on every subcommand, snapshot-tested: these shapes are the agent-facing API.

### Drift

`vdiff install --check` compares `x-vdiff-version` in each installed file against the running CLI
and reports, per harness and per scope: current, stale (with both versions), missing, or modified
locally (content hash differs from what that version would have written). Exit code 0 always — drift
is information, consistent with `vdiff diff` exiting 0 with findings.

A command that notices a stale stamp prints one line pointing at `vdiff install --check`. It does
not fix anything.

## 6. Errors

| Situation | Behaviour |
|---|---|
| unknown harness | exit 2, listing supported harnesses |
| existing file, no `--force` | exit 2, naming the file and suggesting `--force` |
| target directory not writable | exit 2, naming the path and the underlying error |
| `AGENTS.md` exists with a malformed block (start without end) | exit 2; never guess where the block ends |
| harness has no skill mechanism | not an error — falls back per D15, and says so in the output |

## 7. Testing

1. **Path-map assertions per harness.** The registry is data, so tests assert what files would be
   written where, into a temp directory, for every harness and both scopes. This is the bulk of the
   coverage.
2. **One real round trip for Claude Code**, the only harness we can actually verify end to end here:
   install into a temp directory, read the files back, confirm frontmatter and content.
3. **`AGENTS.md` block management** — created when absent, replaced in place on reinstall,
   surrounding content byte-identical, malformed block rejected. Property-tested against files with
   content before, after, and both.
4. **Drift detection** — current, stale, missing and locally-modified each produce the right report.
5. **Neutrality** — the existing test stays: shipped SKILL.md bodies contain no harness-specific
   syntax. Extended to assert that everything harness-specific arrives via frontmatter or the
   `AGENTS.md` block.
6. **Idempotency** — installing twice changes nothing the second time.
7. **CLI `--json` snapshots** for `install`, `--list` and `--check`.

**Stated plainly in this spec because it would otherwise be mistaken for coverage:** tests 1 and 3–7
prove we write the files we intend. They do **not** prove Codex, opencode or pi actually read them.
That requires running those harnesses, which this slice does not do. The path map is only as good as
the documentation it was derived from, and §4 names the three items known to be unverified.

## 8. Sources

Verified 2026-08-09:

- Codex customization — <https://learn.chatgpt.com/docs/customization/overview>
- opencode commands — <https://opencode.ai/docs/commands/>
- pi extensions — <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- Cross-agent SKILL.md convention — <https://github.com/badlogic/pi-skills>

SKILL.md is a cross-agent format rather than a Claude Code one: the same `name`/`description`
frontmatter and markdown body, with progressive disclosure, is read by Claude Code, Codex, Copilot,
Cursor, Gemini CLI and pi. Slice 1's choice to keep bodies neutral and compose frontmatter at install
time already matches where the ecosystem landed, which is why this slice is small.
