---
name: visual-diff-report
description: "Publish a flow's report as a hosted page (a Claude artifact, or a handoff to ChatGPT Sites or any static host) and optionally link it from a pull-request comment. Use when the user wants to share a report by link without infrastructure, or asks to publish the diff report."
---

# Publishing a Visual Diff Report

Publish a flow's report as a hosted page — a Claude artifact, a ChatGPT Site, or any static host —
so it can be shared by link with no publish branch and no infrastructure of the user's own. Load
this skill when the user wants to share a report outside the repo, link one from a pull-request
comment, or asks to "publish the report" / "make an artifact of the diff".

The preferred path needs a harness that can publish web pages (an `Artifact` tool or equivalent).
Without one, fall through to the handoff in step 3b — never claim publishing happened when it
did not.

## The shape

`vdiff export --html inline` writes a `report.html` that is complete as a single file: every image
embedded as a `data:` URI, no JavaScript, no external request of any kind. That file, lightly
unwrapped, is the artifact. The published page is a snapshot of one diff — re-publish after a new
run; the URL survives.

## Step 1 — export the self-contained page

```bash
vdiff export <flow> --html inline --json
```

Parse the envelope for `outDir`. If the export warns about missing images, say so before
publishing — a report that says "not in this bundle" is honest, but the user should not discover it
from the artifact.

**Size gate**: check the file before publishing. Artifacts cap at 16MB rendered.

```bash
wc -c < <outDir>/report.html
```

Over ~15MB: re-export with `--images changed` if it was `all`, and if it still does not fit, stop
and tell the user which flow is too heavy rather than publishing a page that will be rejected.

## Step 2 — unwrap the document

`report.html` is a full HTML document: a `<div id="vdiff-root">`, an embedded JSON snapshot, and
the report app as one inline `<script>` (no external request — inline scripts are fine in an
artifact). The artifact host wraps content in its own skeleton, so strip the wrapper and keep the
substance, writing the result to the scratchpad (never into `.visual-diff/`):

1. Keep the `<title>` tag, hoisted to the top of the file.
2. Keep everything between `<body>` and `</body>` **verbatim and in order** — the root div, the
   `<script type="application/json" id="vdiff-snapshot">` block, and the app `<script>`. Do not
   reformat or re-indent the JSON or the script bodies.
3. Drop `<!doctype>`, `<html>`, `<head>`, `<body>`, `<noscript>` and the meta tags.

## Step 3 — publish as an artifact

Publish with the Artifact tool. Conventions that make the link durable and findable:

- **One file path per project + flow**, stable across runs (e.g.
  `<scratchpad>/vdiff-<project>-<flow>.html`, where `<project>` is the repo or package name), so a
  re-publish updates the same URL instead of minting a new one. If this session did not create the
  artifact, find its URL first (the artifact list, or ask) and pass it as `url` — publishing
  without it forks a second page.
- **Title must be unique and identifiable in a gallery of many**: project plus flow, never the flow
  alone — three repos each with a `checkout` flow must not produce three artifacts named
  "Checkout". Shape: `<Project> <Flow> Diff` (e.g. "Acme-Web Checkout Diff"). Put the pair being
  compared in the `description`, not the title — the title stays stable across runs.
- Favicon on first publish only: 📸.
- Artifacts start private. Tell the user the link is theirs to share; nothing was made public.

## Step 3b — no artifact tool: hand off the file

Some harnesses cannot publish pages (there is no API for Claude artifacts, and ChatGPT Sites
deploys only from the ChatGPT app — its CLI cannot save or deploy a Site). The single file is still
the deliverable:

1. Write the unwrapped page where the user will find it, named identifiably:
   `vdiff-<project>-<flow>.html` (as `index.html` inside a directory of that name if a host wants a
   site root).
2. Tell the user where it is and how to publish it: in the ChatGPT app, "Deploy this project with
   Sites" from the file's directory; or any static host / gist / email attachment — the file has no
   external references, so anywhere that serves one object works.

## Step 4 — reference it from the PR comment (optional)

If the user wants the report linked from a pull request:

```bash
vdiff comment <flow> --report-url <artifact-url> --out comment.md
gh pr comment <number> --body-file comment.md   # or --edit-last to update in place
```

The comment stays the GFM finding table it always was; `--report-url` adds the artifact link as the
call to action beside the verdict. `--image-base` is unrelated and still requires a public raw-file
host (D31): an artifact page cannot serve `<img>` tags in a GitHub comment, so without a publish
branch the comment carries numbers and the link, not inline screenshots. Do not promise otherwise.

## What this skill never does

- Post a comment, publish a page, or share anything without the user asking for that step.
- Publish from CI. This is the interactive path; the action's transport story is unchanged.
- Invent a report: no stored diff for the pair means nothing to publish — run the loop first
  (see **visual-diff**).
