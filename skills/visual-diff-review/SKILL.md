# Reviewing a Visual Diff

Load this skill when a diff exists and needs interpreting, or when the user has left comments on the
report. This is the half of the loop that runs *after* `vdiff diff`.

## Interpreting findings

```bash
vdiff diff <flow> --json
```

Findings are scoped to a step, a viewport, and an element. Each carries a `kind` and a `severity`.

| kind | what it means |
|---|---|
| `content` | text or child nodes changed |
| `style` | a computed style property changed |
| `layout` | something moved or resized |
| `structural` | a node was added or removed |
| `a11y` | role, accessible name, or contrast changed |
| `console` | a console error appeared that was not there before |
| `network` | a request had no recorded response |

`console` and `network` findings are step-scoped: they carry no `viewport` and no `region`, and they
live on `step.findings` rather than inside a viewport.

Severity is `high`, `med` or `low`. **Severity orders the list. It never filters it.** A `low` finding
you did not intend matters more than a `high` finding you made on purpose. Sort by intent, not by
badge colour.

## The question to answer for the user

Not "what changed" — the report already shows that. The question is **"is this what you meant?"**

Work through the findings and put each into one of three buckets:

1. **Intended** — you made this change on purpose. Say so briefly and move on.
2. **Unintended but harmless** — a side effect you can explain. Name it and the cause.
3. **Unintended and suspicious** — you cannot explain it. Stop and investigate before reporting done.

Bucket 3 is the reason the tool exists. Never let a finding you cannot explain pass silently into a
completion claim.

Name the element and the property-level change, not the vibe: `element.selector`, `role`, `name`, and
the entries in `changes` (`text: "Pay" -> "Pay now"`, `width: 52 -> 78`). "The layout shifted" is a
worse sentence than the JSON it came from.

## Signals worth escalating

- **A new `console` finding.** Something started throwing. Nearly always worth investigating before
  anything else, regardless of how it looks.
- **An `a11y` finding that removes an accessible name.** A control just became unusable to screen
  readers, usually invisibly.
- **A `spec-changed` entry in `flowDiff`.** The same step id now resolves through a different
  selector or action — the workflow definition and the app disagree about how to reach a screen.
  The other `flowDiff` statuses are `matched`, `added`, `removed`, `failed` and `blocked`.
- **A step that came back `failed` and was `ok` before.** The workflow broke; that outranks every
  cosmetic finding in the run.
- **`har-miss` warnings on the run.** The screen may have rendered without data, making its findings
  meaningless.

## Comparing more than two iterations

```bash
vdiff runs <flow> --json           # the timeline: run id, revision, mode, status, findings, flags
vdiff diff <flow> 0003 0007 --json # any two points
```

When you have iterated several times, diffing the newest against the *original* is often more useful
than against the previous run — successive small diffs hide cumulative drift. Check both when the
user asks whether a redesign landed.

If a run has been pruned, its timeline row survives and the report offers the exact
`vdiff run <flow> --at <ref>` command to backfill it; historical points can always be recaptured by
replay.

## Pulling human feedback back

The report lets the user click a region and comment on it. Those comments queue for you:

```bash
vdiff feedback --json          # read pending comments
vdiff feedback --json --ack    # read them and archive what you read
```

Each entry carries the flow, the pair, and — when the comment was anchored to something — `step`,
`viewport`, `findingId`, `element` (the selector), `region`, and a `crop` path pointing at exactly the
region the user marked. Look at the crop — it is more precise than the prose. Crop paths are relative
to the `.visual-diff` directory.

Use `--ack` only once you have actually read and acted on the entries. Acking without acting loses
the user's feedback silently. Anything the user appends while you were working stays pending for the
next pull.

Work the comments in order, make the changes, then run the loop again:

```bash
vdiff run <flow> --json && vdiff diff <flow> --json
```

The report is live — the user's open page follows the new run on its own. Do not tell them to reload.
The page executes nothing; it only appends JSON. Never ask them to run something from it.

## Closing the loop honestly

When reporting back, state plainly:

- what you changed in response to each comment
- what the new diff shows, including anything still unresolved
- anything you chose not to change, and why

If a finding you cannot explain is still present, say so. A visual diff tool whose summary says
"all good" while the report shows an unexplained change is worse than no tool — it teaches the user
to stop looking.
