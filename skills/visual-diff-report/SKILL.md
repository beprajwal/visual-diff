# Publishing a Visual Diff Report

Publish a flow's report as a hosted page — today, a Claude artifact — so it can be shared by link
with no static host, no publish branch, no infrastructure. Load this skill when the user wants to
share a report outside the repo, link one from a pull-request comment, or asks to "publish the
report" / "make an artifact of the diff".

This skill needs a harness that can publish web pages (an `Artifact` tool or equivalent). Without
one, stop and say so: there is no API for publishing artifacts, so the CLI cannot do this alone.

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

`report.html` is a full HTML document. The artifact host wraps content in its own skeleton, so
strip the wrapper and keep the substance, writing the result to the scratchpad (never into
`.visual-diff/`):

1. Keep the `<title>` tag, hoisted to the top of the file.
2. Keep the `<style>` block verbatim — the page's CSS already handles dark mode via
   `prefers-color-scheme`.
3. Keep everything between `<body>` and `</body>`.
4. Drop `<!doctype>`, `<html>`, `<head>`, `<body>` and the meta tags.

## Step 3 — publish

Publish with the Artifact tool. Conventions that make the link durable:

- **One file path per flow**, stable across runs (e.g. `<scratchpad>/vdiff-<flow>.html`), so a
  re-publish updates the same URL instead of minting a new one. If this session did not create the
  artifact, find its URL first (the artifact list, or ask) and pass it as `url` — publishing
  without it forks a second page.
- Title: the flow name (e.g. "Checkout Visual Diff"). Favicon on first publish only: 📸.
- Artifacts start private. Tell the user the link is theirs to share; nothing was made public.

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
