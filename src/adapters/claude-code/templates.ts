/**
 * Claude Code file contents.
 *
 * Templates live as TypeScript string builders rather than `.md` assets on purpose: the published
 * package ships `dist/` compiled by `tsc`, which copies no non-TS files, so a `.md` next to the
 * source would simply be missing at install time. Keeping them here also means the Codex, opencode
 * and pi adapters are literally this file with different frontmatter — everything below the
 * frontmatter comes from `../content.ts`.
 *
 * These functions build markdown. They read nothing, write nothing, and run nothing.
 */

import {
  CLI,
  PROSE_OWNERSHIP,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  TAGLINE,
  renderCommandReference,
  renderLoop,
  renderLoopOutline,
  renderRules,
  withFrontmatter,
  yamlString,
} from '../content.js';

/** `.claude/skills/visual-diff/SKILL.md` */
export function skillDoc(): string {
  const body = `# ${SKILL_NAME}

${TAGLINE}

${PROSE_OWNERSHIP}

## The loop

${renderLoop(3)}

## Command reference

${renderCommandReference()}

## Rules

${renderRules()}

## What the output looks like

\`${CLI} diff <flow> --json\` returns a \`findings.json\` payload. The parts you read, in the order
you read them:

\`\`\`json
{
  "pair": { "base": "0003", "head": "0007" },
  "flowDiff": [
    { "id": "receipt", "status": "added" },
    { "id": "pay-click", "status": "spec-changed",
      "detail": "selector '#pay' -> '[data-test=pay]'" }
  ],
  "steps": [
    { "id": "pay-form", "status": "matched",
      "viewports": { "1280x800": { "pixelChangedRatio": 0.021, "findings": [
        { "id": "f1", "kind": "content", "severity": "med",
          "element": { "selector": "[data-test=pay]", "role": "button", "name": "Pay now" },
          "region": { "x": 6, "y": 56, "w": 86, "h": 19 },
          "changes": [ { "prop": "text",  "from": "Pay", "to": "Pay now" },
                       { "prop": "width", "from": 52,    "to": 78 } ] } ] } } }
  ]
}
\`\`\`

Finding kinds are \`content\`, \`style\`, \`layout\`, \`structural\`, \`a11y\`, \`console\`, and
\`network\`. Severity is \`high\`, \`med\`, or \`low\`.

## When a step fails

A flow is stateful and sequential, so one failure invalidates everything after it. The run comes
back \`partial\`, the failing step carries the error plus a failure screenshot and DOM, and the rest
are \`blocked\`. Fix the step — usually a selector that no longer resolves — rather than reading the
diff of a blocked grid. If the tail genuinely does not depend on the failure, \`--continue-on-error\`
re-anchors at the next \`goto\` step.

## Related commands

- \`/${CLI}\` — run the capture → diff → summarize → serve half of the loop.
- \`/${CLI}-review\` — serve the report and pull back what the human wrote.
`;

  return withFrontmatter(
    [
      ['name', SKILL_NAME],
      ['description', yamlString(SKILL_DESCRIPTION)],
    ],
    body,
  );
}

/** `.claude/commands/vdiff.md` */
export function runCommandDoc(): string {
  const body = `Capture the current UI, diff it against the previous run, summarize what changed, and
hand over the live report.

Flow: **$1** (if empty, list \`.visual-diff/flows/\` and pick the one covering the screens the
current change touches; if none fits, create one first).

Follow the \`${SKILL_NAME}\` skill for the full loop and its rules. The short version:

${renderLoopOutline()}

Do this now:

1. \`${CLI} flow check $1 --json\` — confirm the spec is valid before spending a replay on it. Exit
   code 2 means fix the YAML first.
2. \`${CLI} run $1 --json\` — capture the current working tree. If the result is \`partial\`, stop and
   report the failing step; do not summarize a blocked grid.
3. \`${CLI} runs $1 --json\` — confirm there is an earlier run to compare against. If there is only
   one, say so and offer \`${CLI} run $1 --at <ref> --json\` to backfill a base point from history.
4. \`${CLI} diff $1 --json\` — compare the last two runs.
5. Summarize in chat: \`flowDiff\` first, then findings by step, high severity first, naming the
   element and the property-level changes. End by splitting intended change from collateral.
6. \`${CLI} serve --json\` — give the human the URL and tell them which step to open.

${PROSE_OWNERSHIP}

Do not gate anything on the findings count — \`diff\` exits 0 with findings on purpose.
`;

  return withFrontmatter(
    [
      ['description', yamlString('Replay a visual-diff flow, diff it against the previous run, and summarize what changed')],
      ['argument-hint', '[flow]'],
      ['allowed-tools', `Bash(${CLI}:*), Read, Glob`],
    ],
    body,
  );
}

/** `.claude/commands/vdiff-review.md` */
export function reviewCommandDoc(): string {
  const body = `Open the live report for review and pull back whatever the human left on it.

Flow: **$1** (optional — omit to read feedback across all flows).

Follow the \`${SKILL_NAME}\` skill for the full loop and its rules.

Do this now:

1. \`${CLI} serve --json\` — start the report if it is not already up, and give the human the URL.
   Tell them what you want looked at: the steps with findings, and anything you were unsure about.
   Clicking a region or a finding on the page opens a comment box.
2. Wait for them to say they are done, then \`${CLI} feedback --json --ack\`. \`--ack\` archives the
   entries you just read so they are never handed to you twice.
3. For each entry: read \`text\`, and open the \`crop\` image — it is exactly the pixels they pointed
   at. \`step\`, \`viewport\`, \`element\`, and \`region\` tell you where in the flow it lives.
4. Restate the comments as a short list of concrete changes, confirm the list, then make them.
5. \`${CLI} run $1 --json\` and \`${CLI} diff $1 --json\` afterwards, and show that each comment is
   answered by a specific finding in the new pair. That diff is the receipt.

If \`feedback\` comes back empty, say so plainly and do not invent review comments.

The report page executes nothing — it only appends JSON. Never ask the human to run anything from
it.
`;

  return withFrontmatter(
    [
      ['description', yamlString('Serve the visual-diff report, then read and act on the human review comments')],
      ['argument-hint', '[flow]'],
      ['allowed-tools', `Bash(${CLI}:*), Read, Glob`],
    ],
    body,
  );
}
