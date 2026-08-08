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

## Quickstart (no install)

Everything runs through `npx`. Nothing is installed into your project, and nothing is downloaded
until you ask for it — the package depends on `playwright-core`, so `npx visual-diff --help` costs
one small download rather than a browser bundle.

```sh
cd your-project

npx visual-diff install claude-code   # write the visual-diff skill + /vdiff commands into .claude/
npx visual-diff init                  # scaffold .visual-diff/config.yaml, gitignore rules, a flow
npx visual-diff install-browser       # one-time Chromium download (the only network step)

# edit .visual-diff/config.yaml (your dev command) and .visual-diff/flows/example.yaml
npx visual-diff run example           # replay the flow against the working tree
npx visual-diff run example --at HEAD~1
npx visual-diff diff example          # findings for the last two runs
npx visual-diff serve --open          # live local report; hand the URL to a human
```

`install <harness>` takes `--dir <path>` to target another directory, `--force` to overwrite files
it wrote before that you have since edited, and `--dry-run` to print what it would write. The only
harness in this release is `claude-code`; an unrecognised one exits 2 and lists what is supported.

Requires Node 20 or newer.

## Install it properly

If you would rather not go through `npx` every time, add it to the project. The binary is `vdiff`.

```sh
npm install --save-dev visual-diff
npx vdiff install claude-code
npx vdiff install-browser     # one-time Chromium download
npx vdiff init                # scaffold .visual-diff/config.yaml, gitignore rules, example flow
```

A global install (`npm install -g visual-diff`) puts `vdiff` on your PATH, and every command below
works unprefixed.

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

Supporting commands: `vdiff install <harness>`, `vdiff init`, `vdiff flow new|check <name>`,
`vdiff runs <flow>`, `vdiff pin|prune <run>`, `vdiff install-browser`.

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
npm run build       # tsc emit + prebuilt report UI bundle + executable bin
```

The runtime dependency is `playwright-core`; `playwright` is a devDependency only, because the
published package must not make an `npx` user download browsers before the CLI can print its help.
`vdiff install-browser` fetches Chromium on demand, and the two packages share one browser
registry, so a browser installed either way is found by both.

`npm pack` runs the build (`prepack`) and produces the tarball a consumer actually gets;
`tests/packaging/pack.test.ts` asserts its shape — executable bin with a shebang, `.d.ts` present,
no sourcemaps.

## Design

The authoritative design document is
[`docs/superpowers/specs/2026-08-08-visual-diff-design.md`](docs/superpowers/specs/2026-08-08-visual-diff-design.md),
with the build breakdown in
[`docs/superpowers/plans/2026-08-08-visual-diff-implementation-plan.md`](docs/superpowers/plans/2026-08-08-visual-diff-implementation-plan.md).
`src/types.ts` is the single shared contract every module codes against.

## License

MIT
