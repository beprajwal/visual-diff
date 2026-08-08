# visual-diff

Replay an agent-authored UI workflow against one or more revisions of a frontend, capture full
evidence per step, compute annotated visual and semantic diffs between any two runs, and review
them in a live local report where a human leaves feedback the agent reads back.

The package is `visual-diff`; the binary is `vdiff`.

- **Pixels say *where* changed, the DOM says *what* changed.** A pixel diff finds changed regions,
  each region is hit-tested against a DOM snapshot to name the responsible element, and those
  elements are tree-diffed for the specific property change.
- **Flows are declarative YAML with a closed step vocabulary**, so two versions of a workflow can be
  compared structurally without executing either one.
- **Runs are append-only and git-anchored**, so any two runs are comparable and a missing point is
  offered as a backfill rather than an error.
- **The report never executes anything.** It appends structured JSON feedback to a file; an agent
  decides what to do with it.

## Install

```sh
npm install --save-dev visual-diff
npx vdiff install-browser     # one-time Chromium download
npx vdiff init                # scaffold .visual-diff/config.yaml, gitignore rules, example flow
```

Requires Node 20 or newer.

## The four core commands

```sh
vdiff run <flow> [--at <ref>]     # replay a flow at the working tree or a historical revision
vdiff diff <flow> [base] [head]   # compute findings for a pair (defaults: N-1 vs N)
vdiff serve [--open]              # live local report: filmstrip, side-by-side, findings, feedback
vdiff feedback [--json] [--ack]   # pull the human comments left in the report
```

Every command accepts `--json` and emits a single envelope object on stdout, which is the
agent-facing API. Exit codes: `0` success, `1` run or replay failure, `2` config or spec error.
`vdiff diff` exits `0` even when findings exist — findings are information, not a gate.

Supporting commands: `vdiff init`, `vdiff flow new|check <name>`, `vdiff runs <flow>`,
`vdiff pin|prune <run>`, `vdiff install-browser`.

## A flow spec

```yaml
version: 1
flow: checkout
baseUrl: http://localhost:5173
viewports: [1280x800, 390x844]
network: { mode: replay, har: checkout.har }
steps:
  - id: cart
    goto: /cart
    waitFor: "[data-test=cart-list]"
    mask: ["[data-test=order-date]"]
  - id: pay-form
    click: "[data-test=pay]"
    waitFor: "text=Payment"
```

Step `id`s are stable and load-bearing: diffs align runs by `id`, never by index. `.visual-diff/flows/`
and `.visual-diff/config.yaml` must be committed; runs, diffs, cache and feedback are ignored.

## Development

```sh
npm install
npm run test        # everything
npm run test:unit   # colocated unit + golden tests, no browser
npm run typecheck
npm run build       # tsc emit + prebuilt report UI bundle
```

## Design

The authoritative design document is
[`docs/superpowers/specs/2026-08-08-visual-diff-design.md`](docs/superpowers/specs/2026-08-08-visual-diff-design.md),
with the build breakdown in
[`docs/superpowers/plans/2026-08-08-visual-diff-implementation-plan.md`](docs/superpowers/plans/2026-08-08-visual-diff-implementation-plan.md).
`src/types.ts` is the single shared contract every module codes against.

## License

MIT
