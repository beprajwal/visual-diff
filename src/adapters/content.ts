/**
 * Harness-neutral documentation content.
 *
 * Spec §9 makes the Claude Code integration deliberately thin: a skill describing the loop plus two
 * slash commands, with *all* logic in the CLI, "so the Codex, opencode, and pi adapters in
 * subsystem 1 are near-copies of a markdown file". That is only true if the prose lives in one
 * place and each adapter contributes nothing but frontmatter and file paths — which is exactly what
 * this module is for.
 *
 * Nothing here executes anything. Adapters write markdown and nothing else.
 */

/** The binary every harness shells out to (spec §12). */
export const CLI = 'vdiff';

/** Skill / integration name, shared across harnesses. */
export const SKILL_NAME = 'visual-diff';

export const SKILL_DESCRIPTION =
  'Use when a code change affects the UI and you need to know what visually changed, not just that ' +
  'something did. Replays an agent-authored flow with vdiff, diffs two runs, summarizes the ' +
  'findings, hands the human a live local report, and reads their comments back.';

export const TAGLINE =
  '`vdiff` replays a recorded workflow against two revisions of this project, computes an annotated ' +
  'visual and semantic diff of the two runs, and serves a live local report where a human reviews ' +
  'the change and leaves feedback you read back.';

/**
 * Spec §8: "vdiff emits structured findings only. The Claude Code skill reads findings.json and
 * writes the human sentence." This sentence is the load-bearing one in every adapter's output.
 */
export const PROSE_OWNERSHIP =
  '`vdiff` emits **structured findings only** — it has no API key, no model, and makes no network ' +
  'call. The sentence a human reads is yours to write, because you are the thing that knows *why* ' +
  'the change was made.';

export interface LoopStage {
  /** Stable key, so a harness can reference a single stage. */
  key: string;
  title: string;
  /** Shell lines, shown in a fenced block. */
  commands: string[];
  /** Bullets under the block. */
  notes: string[];
}

/** The loop from spec §9, in order. */
export const LOOP: readonly LoopStage[] = [
  {
    key: 'flow',
    title: 'Ensure a flow exists for the feature under work',
    commands: [
      `${CLI} flow check <flow> --json`,
      `${CLI} flow new <flow> --json`,
    ],
    notes: [
      'Look in `.visual-diff/flows/` first. If a flow already covers the screens your change ' +
        'touches, reuse it — a new flow starts with no history to diff against.',
      'Scaffold with `flow new`, then edit the YAML. The step vocabulary is closed: `goto`, ' +
        '`click`, `fill`, `press`, `hover`, `scroll`, `waitFor`, `viewport`, `mask`, `shoot`, ' +
        '`expect`. Anything else fails validation.',
      'Give every step a stable, meaningful `id`. Runs are aligned by `id`, never by position, and ' +
        'step directories on disk are named by `id` — so ids are load-bearing, not a convenience.',
      '`mask` anything time-dependent or per-session: clocks, order ids, relative timestamps. ' +
        'Unmasked, they produce a finding on every single run and drown the real signal.',
      'Commit `.visual-diff/flows/<flow>.yaml` and `.visual-diff/config.yaml`. Replaying a past ' +
        'revision reads the flow file out of git at that SHA, so an uncommitted flow has nothing ' +
        'to read there.',
      '`flow check` validates without running anything. Use it after every edit; it exits 2 with ' +
        'the file, line, and offending key.',
    ],
  },
  {
    key: 'run',
    title: 'Capture a run',
    commands: [
      `${CLI} run <flow> --json`,
      `${CLI} run <flow> --at <ref> --json`,
    ],
    notes: [
      'Each `run` appends a new run to the store; runs are never overwritten. Two runs of the same ' +
        'flow are always comparable.',
      'With no `--at`, it targets HEAD or the dirty working tree and drives the dev server directly ' +
        'if one is already up — the fast path.',
      '`--at <ref>` backfills a comparison point from history: it materializes a detached worktree ' +
        'under `.visual-diff/cache/`, replays, and appends the result. It never touches your ' +
        'working tree, index, stashes, or HEAD.',
      'Check `status` on the result. `partial` means a step failed and everything downstream is ' +
        '`blocked` — fix the step or pass `--continue-on-error` before reading anything into the ' +
        'diff.',
      'Read the run warnings. `har-miss` means a request was aborted rather than served, and the ' +
        'shots downstream of it are suspect. `unstable-git` means the tree moved mid-run; re-run.',
    ],
  },
  {
    key: 'diff',
    title: 'Diff two runs',
    commands: [
      `${CLI} diff <flow> --json`,
      `${CLI} diff <flow> <base> <head> --json`,
    ],
    notes: [
      'With no run ids it compares the last two runs (N-1 vs N). Use `' +
        `${CLI} runs <flow> --json\` to see the timeline — SHA, dirty flag, status, findings count ` +
        '— and pick explicit endpoints when you want a different pair.',
      '`diff` exits 0 even when it finds things. Findings are information, not a gate.',
      'If it reports that a run was pruned, it hands you the exact `' +
        `${CLI} run … --at …\` command to backfill that point. Run it, then diff again.`,
    ],
  },
  {
    key: 'summarize',
    title: 'Summarize the findings in chat',
    commands: [],
    notes: [
      'Start with `flowDiff`. `added` / `removed` steps mean the workflow itself changed shape; ' +
        '`spec-changed` means the same step id now uses a different selector or action — usually a ' +
        'rename, occasionally an accident. Say which.',
      'Then walk the steps. For each finding, name the element (`element.selector`, `role`, ' +
        '`name`) and the specific `changes` — `text: "Pay" -> "Pay now"`, `width: 52 -> 78`. Never ' +
        'say "the layout shifted" when the payload says which element moved and by how much.',
      'Lead with `high` severity, but report everything. Severity orders the list and colors ' +
        'badges; it never hides a finding.',
      '`console` and `network` findings are step-scoped and carry no region. A new console error is ' +
        'high severity and worth its own line in your summary.',
      'Close with a verdict, split two ways: which findings are the change you intended, and which ' +
        'are collateral you did not. That split is the entire value you add over the raw JSON.',
    ],
  },
  {
    key: 'serve',
    title: 'Hand the report URL to the human',
    commands: [`${CLI} serve --json`],
    notes: [
      'The URL comes back on the result. It binds `127.0.0.1` on an ephemeral port with a ' +
        'per-session token; the UI is prebuilt and self-contained, so nothing is fetched from the ' +
        'network.',
      'Give them the URL *and* a pointer: which step to open, which finding you are unsure about.',
      'The page pushes itself forward — a new run appears live while they review. Leave the server ' +
        'running rather than restarting it after each iteration.',
      'The page executes nothing. It cannot run a build, touch git, or start a process; it only ' +
        'appends JSON. Never tell a human to "run" something from the report.',
    ],
  },
  {
    key: 'feedback',
    title: 'Pull the human comments back',
    commands: [`${CLI} feedback --json --ack`],
    notes: [
      'Comments left on a region or a finding land in `.visual-diff/feedback/pending.jsonl`. ' +
        '`--ack` archives what you just read, so the same comment is never handed to you twice.',
      'Each entry pins the comment to a `step`, `viewport`, `element`, and `region`, and carries a ' +
        '`crop` path. Open the crop image — it is exactly the pixels the human pointed at.',
      'Act on the comments, then go back to **run** and **diff** to prove the fix. Two runs later, ' +
        'the diff of your fix against the run they commented on is the receipt.',
    ],
  },
];

/** The CLI surface from spec §9. Reproduced so an agent never has to guess a flag. */
export const COMMAND_REFERENCE: ReadonlyArray<{ command: string; purpose: string }> = [
  {
    command: `${CLI} install <harness>`,
    purpose: "Write this harness's skill and command files into the project",
  },
  { command: `${CLI} init`, purpose: 'Scaffold config, gitignore rules, and an example flow' },
  { command: `${CLI} flow new|check <name>`, purpose: 'Scaffold or validate a spec without running it' },
  {
    command: `${CLI} run <flow> [--at <ref>] [--viewport ...] [--record|--no-net] [--continue-on-error]`,
    purpose: 'Replay the flow and append a run',
  },
  { command: `${CLI} runs <flow>`, purpose: 'Timeline: SHA, dirty, status, findings count' },
  { command: `${CLI} diff <flow> [base] [head]`, purpose: 'Compute a pair and print the summary (defaults to N-1 vs N)' },
  { command: `${CLI} serve [--open] [--port]`, purpose: 'Serve the live local report' },
  { command: `${CLI} feedback [--json] [--ack]`, purpose: 'Read human comments; --ack archives them' },
  { command: `${CLI} pin|prune <run>`, purpose: 'Exempt a run from retention, or prune it now' },
  { command: `${CLI} install-browser`, purpose: 'Install the Chromium build the runner needs' },
];

/** Invariants an agent must not violate. Every one of these is a spec decision, not a preference. */
export const RULES: readonly string[] = [
  'Every command accepts `--json`. Always pass it — parse the envelope, do not scrape human output.',
  'Exit codes: `0` success, `1` run or replay failure, `2` config or spec error. `diff` exits `0` ' +
    'even when findings exist.',
  '`.visual-diff/flows/` and `.visual-diff/config.yaml` are committed. Runs, diffs, cache, and ' +
    'feedback are ignored — never commit them.',
  'Never rename a step `id` to fix a selector. Change the selector and keep the id: that is what ' +
    'produces the `spec-changed` drift signal instead of a bogus removed/added pair.',
  'There is no `sleep`. The validator rejects it by name, because a fixed sleep is how a ' +
    'half-rendered frame gets captured. Use `waitFor`.',
  'Noise is fixed at the source, not by ignoring output: `mask` in the flow for per-step churn, ' +
    '`diff.ignore` in `config.yaml` for global churn, `diff.minRegionArea` for pixel dust.',
  'Do not add pass/fail thresholds, and do not treat a findings count as a build gate. Findings ' +
    'are information.',
  'Do not write scripts that duplicate what `' + CLI + '` does. All logic lives in the CLI; your job ' +
    'is choosing the runs, reading the JSON, and writing the sentence.',
];

/* ------------------------------------------------------------------ markdown rendering */

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

function fence(lines: readonly string[]): string {
  return ['```bash', ...lines, '```'].join('\n');
}

/** The numbered loop, rendered as markdown sections at the given heading level. */
export function renderLoop(headingLevel = 3): string {
  const hashes = '#'.repeat(headingLevel);
  return LOOP.map((stage, index) => {
    const parts = [`${hashes} ${index + 1}. ${stage.title}`];
    if (stage.commands.length > 0) parts.push(fence(stage.commands));
    parts.push(bullets(stage.notes));
    return parts.join('\n\n');
  }).join('\n\n');
}

/** One-line-per-stage overview, for the short command files. */
export function renderLoopOutline(): string {
  return LOOP.map((stage, index) => `${index + 1}. **${stage.title}**`).join('\n');
}

/** `|` inside a cell would end the column, and several commands carry one (`pin|prune`). */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

export function renderCommandReference(): string {
  const rows = COMMAND_REFERENCE.map(
    (entry) => `| \`${escapeCell(entry.command)}\` | ${escapeCell(entry.purpose)} |`,
  );
  return ['| Command | Purpose |', '|---|---|', ...rows].join('\n');
}

export function renderRules(): string {
  return bullets(RULES);
}

/** Escape hatch used by every adapter's frontmatter: YAML-safe single-line string. */
export function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim()}"`;
}

/** Compose a markdown document with YAML frontmatter. */
export function withFrontmatter(fields: ReadonlyArray<[string, string]>, body: string): string {
  const lines = fields.map(([key, value]) => `${key}: ${value}`);
  return ['---', ...lines, '---', '', body.trim(), ''].join('\n');
}
