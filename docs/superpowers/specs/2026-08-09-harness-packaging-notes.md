# Harness packaging (subsystem 1) — parked design notes

Date: 2026-08-09
Status: **Parked mid-design.** Decisions below are settled; the spec was never written.
Resumed by re-reading this file, not by re-deciding.

## Locked decisions

- **Thin parity.** Write the instruction/skill files each harness actually reads, plus its command
  concept where it has one. Where a harness has no skill mechanism, fall back to an instructions
  file pointing at the CLI. Rejected: native-per-harness (four codepaths, four ways to break) and
  lowest-common-denominator (one `AGENTS.md`, weakest integration).
- **Project-local default, `--global` to opt out.** A solo user wants install-once; a team wants the
  skills committed beside `.visual-diff/flows/` so everyone drives the tool identically. Needs a
  precedence rule when both exist — undecided, and the first thing to settle on resume.
- **Version stamp plus `vdiff install --check`.** Installed skills are copies that document specific
  flags; a stale copy describing a removed flag is the failure mode. Explicit check and
  `--force` update. Rejected: auto-refresh on `vdiff run`, which mutates a committed directory
  unprompted and produces surprise diffs in the user's tree.
- **Shared-first paths.** Target `.agents/skills/` where the harness reads it, native paths where it
  does not. Gets cheaper as more agents adopt the convention. Install output must name the real
  directory — `vdiff install codex` writing something not called "codex" is otherwise confusing.

## Research findings (verified 2026-08-09)

**SKILL.md is a cross-agent standard**, not a Claude Code format. Claude Code, Codex, Copilot,
Cursor, Gemini CLI and pi read the same `name`/`description` frontmatter plus markdown body, with
progressive disclosure. Slice 1's choice to keep bodies harness-neutral and compose frontmatter at
install time already matches the ecosystem.

| harness | skills (project / global) | commands | instructions |
|---|---|---|---|
| Claude Code | `.claude/skills/` / `~/.claude/skills/` | `.claude/commands/*.md` | — |
| Codex | `.agents/skills/` (repo + global) | `~/.codex/prompts` | `AGENTS.md`, `~/.codex/AGENTS.md` |
| pi | `.pi/skills/<n>/SKILL.md` / `~/.pi/agent/skills/` | — (`/skill:name`) | `AGENTS.md`, `AGENTS.override.md` |
| opencode | **unverified** | `.opencode/commands/*.md` / `~/.config/opencode/commands/` | `AGENTS.md` |

Sources: <https://learn.chatgpt.com/docs/customization/overview>,
<https://opencode.ai/docs/commands/>,
<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>,
<https://github.com/badlogic/pi-skills>

### Unverified — do not guess these on resume

1. **opencode skill support.** Only commands and `AGENTS.md` are documented. Plan was
   `skills: null` plus a commands + `AGENTS.md` fallback. Recheck before implementing.
2. **pi SKILL.md frontmatter fields.** Docs describe paths, not required fields.
3. **Codex `.agents/skills` precedence** between repo-level and global.

## Design fragments already agreed

- Harness registry is **data, not code**: `{ id, label, skills, commands, instructions, frontmatter }`.
  A fifth harness is a table entry.
- `AGENTS.md` is **edited, never overwritten** — a delimited `<!-- vdiff:start -->…<!-- vdiff:end -->`
  block, replaced on reinstall, surrounding content untouched. The user owns that file.

## Not yet designed

Install precedence when both project and global exist; the version-stamp format; how four harnesses
get tested without installing any of them; rollout and docs.
