<p align="center">
  <img src="assets/cover.png" alt="visual-diff — replay an agent-authored UI flow across revisions; pixels say where changed, the DOM says what changed" width="900">
</p>

<h1 align="center">visual-diff</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@beprajwal/visual-diff"><img alt="npm version" src="https://img.shields.io/npm/v/%40beprajwal%2Fvisual-diff?style=flat-square&logo=npm&logoColor=white&label=npm&color=ff6ab2"></a>
  <a href="https://github.com/beprajwal/visual-diff/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/beprajwal/visual-diff/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI"></a>
  <a href="#on-a-pull-request"><img alt="GitHub Action" src="https://img.shields.io/badge/GitHub%20Action-composite-6ea8ff?style=flat-square&logo=github&logoColor=white"></a>
  <a href="#quickstart-no-install"><img alt="node" src="https://img.shields.io/node/v/%40beprajwal%2Fvisual-diff?style=flat-square&logo=nodedotjs&logoColor=white&label=node"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/%40beprajwal%2Fvisual-diff?style=flat-square&color=56d364"></a>
</p>

Replay an agent-authored UI workflow against one or more revisions of a frontend, capture full
evidence per step, compute annotated visual and semantic diffs between any two runs, and review
them in a live local report where a human leaves feedback the agent reads back.

The package is `@beprajwal/visual-diff`; the binary is `vdiff`.

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
until you ask for it — the package depends on `playwright-core`, so `npx @beprajwal/visual-diff --help`
costs one small download rather than a browser bundle.

```sh
cd your-project

npx @beprajwal/visual-diff install claude-code   # write the visual-diff skill + /vdiff commands into .claude/
npx @beprajwal/visual-diff init                  # scaffold .visual-diff/config.yaml, gitignore rules, a flow
npx @beprajwal/visual-diff install-browser       # one-time Chromium download (the only network step)

# edit .visual-diff/config.yaml (your dev command) and .visual-diff/flows/example.yaml
npx @beprajwal/visual-diff run example           # replay the flow against the working tree
npx @beprajwal/visual-diff run example --at HEAD~1
npx @beprajwal/visual-diff diff example          # findings for the last two runs
npx @beprajwal/visual-diff serve --open          # live local report; hand the URL to a human
```

`install <target>` takes `--dir <path>` to target another directory, `--force` to overwrite files
it wrote before that you have since edited, and `--dry-run` to print what it would write. The agent
harnesses are `claude-code`, `codex`, `opencode` and `pi`; `github-actions` writes CI workflows
instead of skills (see [On a pull request](#on-a-pull-request)). An unrecognised target exits 2 and
lists what is supported, and `vdiff install --list` prints every target with the exact files it would
write.

Requires Node 20 or newer.

## Install it properly

If you would rather not go through `npx` every time, install it globally. That puts `vdiff` on your
`PATH`, so every command in this README works exactly as written, with no prefix.

```sh
npm install -g @beprajwal/visual-diff

vdiff install claude-code
vdiff install-browser     # one-time Chromium download
vdiff init                # scaffold .visual-diff/config.yaml, gitignore rules, example flow
```

To pin the version per project instead — so everyone on the team and CI run the same one — add it
as a dev dependency. The binary lands in `node_modules/.bin`, which `npm run` scripts already have
on their `PATH`; from an interactive shell reach it with `npx vdiff`.

```sh
npm install --save-dev @beprajwal/visual-diff
npx vdiff install claude-code
```

### Or start from the skills

The agent skills also install straight off this repo with the open skills CLI, for any harness it
supports:

```sh
npx skills add beprajwal/visual-diff
```

That path ships the skills alone; the `visual-diff` skill tells the agent to reach the CLI through
`npx @beprajwal/visual-diff` until it is installed. `vdiff install <harness>` remains the fuller
install — it composes per-harness frontmatter and the `/vdiff` slash commands.

## The four core commands

```sh
vdiff run <flow> [--at <ref>]     # replay a flow at the working tree or a historical revision
vdiff diff <flow> [base] [head]   # compute findings for a pair (defaults: N-1 vs N)
vdiff serve [--open]              # live local report: filmstrip, side-by-side, findings, feedback
vdiff feedback [--json] [--ack]   # pull the human comments left in the report
```

Every command accepts `--json` and emits a single envelope object on stdout, which is the
agent-facing API. Exit codes: `0` success, `1` run or replay failure, `2` config or spec error, `3` an
opt-in gate tripped. `vdiff diff` exits `0` even when findings exist — findings are information, not a
gate — and `3` is reachable only from `vdiff comment --fail-on`, which nothing sets by default.

Supporting commands: `vdiff install <target>`, `vdiff init`, `vdiff flow new|check <name>`,
`vdiff runs <flow>`, `vdiff pin|prune <run>`, `vdiff install-browser`, and — with an Anthropic or
OpenAI API key in the environment — `vdiff review <flow>`, which has a model write the review the
agent would have (see [A model reads the diff](#a-model-reads-the-diff)).

## On a pull request

```sh
npx @beprajwal/visual-diff install github-actions   # writes .github/workflows/visual-diff{,-baseline}.yml
```

That is the whole setup. The pull-request workflow replays each flow at the merge-base and at the
head, diffs them, uploads the evidence, and leaves one comment per flow that it updates in place on
every push. The check stays **green**: findings are reported, not enforced, until you set
`fail-on: high` or `fail-on: any` in the workflow.

The pipeline itself lives in a composite action (`beprajwal/visual-diff@v<version>`) rather than in
the file you just installed, so a fix reaches you on the next version bump. The installed workflows
are yours — edit them, and a re-install preserves your edits and says so.

```yaml
- uses: beprajwal/visual-diff@v0.9.0
  with:
    flows: checkout search       # default: every flow in .visual-diff/flows
    fail-on: none                # none | high | any
    baseline: auto               # auto | cache | replay
    publish-branch: ''           # set it to embed screenshots in the comment
    pages-url: ''                # Pages URL serving that branch: the comment links report.html as a page
    anthropic-api-key: ''        # or openai-api-key — a model writes the review the comment opens with
    cli: ''                      # e.g. `npx vdiff` to use the version pinned in package.json
```

### A model reads the diff

Locally, an agent turns the findings into a sentence, because it knows why the change was made. In
CI nobody does, so the comment carried numbers. Give the action one API key and it also carries a
**review**: the single most important change as a headline, every change ranked and marked
`expected` / `unrelated` / `regression` / `unclear`, and a warning block for anything the pull
request's own description does not account for. The pull request title and body are what the model
judges against, so a PR that says "rename the Pay button" and also moves the heading colour gets told
so.

```yaml
- uses: beprajwal/visual-diff@v0.9.0
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}   # or openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    # review-model: claude-opus-5                          # default per provider; gpt-6-astra for OpenAI
```

The provider is whichever key is present (Anthropic when both are). The key reaches exactly one step
and only `vdiff review` reads it; a failed review is a warning, and the comment falls back to the
numbers. The review is stored as `review.json` beside `findings.json`, travels in the bundle, shows
in `report.html`, and always says which model wrote it and what it was shown. It never gates —
`fail-on` still counts findings, not opinions. The same command works anywhere:

```sh
ANTHROPIC_API_KEY=… vdiff review checkout --context pr.md   # or OPENAI_API_KEY; --provider forces one
vdiff comment checkout                                       # picks the stored review up automatically
```

### The report as a site

`publish-branch` already pushes each pull request's `report.html` and images to a branch. Point
GitHub Pages at that branch (Settings → Pages → Deploy from a branch) and tell the action the URL it
serves; the comment's **Open the full report** then opens the interactive page for that pull request:

```yaml
    publish-branch: visual-diff-reports
    pages-url: https://<owner>.github.io/<repo>
```

Who can open it is the repository's Pages visibility — private to the organisation on GitHub
Enterprise Cloud, public otherwise. Pages deploys a pushed branch in about a minute, so the link can
404 briefly after the first push of a new pull request.

Two commands do the rendering, and both work on their own, in any CI system or none:

```sh
vdiff comment <flow> [base] [head]   # the diff as markdown: stdout, or --out <file>
vdiff export  <flow> [base] [head]   # a bundle: findings.json, comment.md, report.html, images/
```

`export --html inline` makes `report.html` self-contained — every image embedded as a `data:` URI,
so the one file is the whole report and can be mailed, attached, or served from anywhere that takes
a single object. `--html both` keeps the linked page and writes `report.inline.html` beside it. The
action forwards this as its `html:` input.

Neither posts, pushes or uploads anything, and neither takes a token — the CLI renders, the action
transports. Two consequences worth knowing before you read a comment and wonder:

- **Screenshots need a URL.** GitHub cannot render an image out of a workflow artifact, so by default
  the comment carries the tables and links to the artifact. Nominate `publish-branch` and the action
  pushes that pull request's diff images to it, which is what makes them embeddable.
- **The base side is the merge-base**, replayed at that revision with that revision's flow spec — not
  the base branch tip, which would report other people's changes as yours. `visual-diff-baseline.yml`
  caches runs from your default branch so most pull requests restore the base side instead of
  replaying it; delete that workflow and every pull request replays, which is slower and identical.

The design is in
[`docs/superpowers/specs/2026-08-11-ci-mode-design.md`](docs/superpowers/specs/2026-08-11-ci-mode-design.md),
including what CI mode deliberately still does not do: no hosting of our own (the report is a page
only where *you* serve it — Pages, a branch, an artifact) and no baseline-approval workflow. The
review and the Pages link are decisions D39 and D40 in the same document.

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

### Flows behind a login

Every replay runs in a clean browser context. Two ways to get past a login screen, neither of which
puts a credential in a committed file:

```yaml
# .visual-diff/config.yaml — a Playwright storage state (cookies + localStorage) every context
# starts from. Relative to the project root; it is a session, so it lives in the untracked part
# of .visual-diff/. A historical replay reads its flow from git and its session from this file.
browser:
  storageState: .visual-diff/auth/state.json
```

```yaml
# .visual-diff/flows/login.yaml — or log in as a step. `${VAR}` in a fill value is read from the
# environment at replay time; the flow keeps the reference, the recorded HAR has the value
# scrubbed, and `vdiff run` refuses to start if a referenced variable is unset.
steps:
  - id: sign-in
    goto: /login
    fill: { "[name=email]": "${VDIFF_EMAIL}", "[name=password]": "${VDIFF_PASSWORD}" }
    click: "[type=submit]"
    waitFor: "[data-test=account-menu]"
    shoot: false
```

The storage-state file is what Playwright's `context.storageState({ path })` writes after a login;
an existing Playwright auth setup project produces one already, and
`npx playwright open --save-storage=.visual-diff/auth/state.json <url>` produces one by hand.
`meta.json` records `authenticated: true` on runs that used it. Cookies are bound to a host, so a
session captured against `app.lvh.me` needs the flow's `baseUrl` written as
`http://app.lvh.me:$PORT` — spawn mode then reaches the dev server through that host rather than
`127.0.0.1`.

## Development

The repo is managed with pnpm, pinned by `packageManager` in `package.json` — run `corepack enable`
once and the right version is used automatically.

```sh
pnpm install
pnpm test            # everything
pnpm test:unit       # colocated unit + golden tests, no browser
pnpm typecheck
pnpm build           # clean dist + tsc emit + report UI bundle + skills + executable bin
```

pnpm is the *development* package manager only. Nothing about the published artifact changes: the
package still lives on the npm registry, `npx @beprajwal/visual-diff` still works, and consumers can
install it with any client. Two steps stay on npm deliberately — `npm pack` and `npm publish` —
because the tarball under test must be the one the registry serves, and npm's trusted publishing is
what signs the release (see the comments in `.github/workflows/release.yml`). Consumers using pnpm
are handled independently: `src/runner/deps.ts` ranks `pnpm-lock.yaml` first when replaying a project,
and the composite action detects it too.

The workspace is declared in `pnpm-workspace.yaml`, and it lists `fixtures/app` only. `fixtures/storefront`
is deliberately left out: the dogfood pipeline points `vdiff` at it as if it were a stranger's project
and lets the tool install its dependencies, which is the code path every real consumer takes.

Bump a version with `pnpm version <patch|minor|major>` (`npm version` behaves identically — both run
the lifecycle script and commit the three files it touches) — the `version` lifecycle script runs
`scripts/sync-version.mjs`, which is the only thing that should ever write `TOOL_VERSION` in
`src/version.ts` and the `version` input default in `action.yml`. Editing `package.json` by hand
skips it, and the release then fails on `src/version.test.ts` after publishing nothing.

`build` empties `dist/` first. `tsc` only ever adds to its `outDir`, so without that step the
compiled remains of a deleted module stay on disk and ship to every consumer — the published tree
has to stay a function of the source tree.

The runtime dependency is `playwright-core`; `playwright` is a devDependency only, because the
published package must not make an `npx` user download browsers before the CLI can print its help.
`vdiff install-browser` fetches Chromium on demand, and the two packages share one browser
registry, so a browser installed either way is found by both.

`jpeg-js` is there for one reason: a Playwright trace stores its screenshots as JPEG, and every
other layer of this tool reads a shot as `screenshot.png` — the store names the file, the diff
engine decodes it with `pngjs`, the report serves it. `vdiff e2e` converts each frame once at
ingest (`src/e2e/image.ts`), which needs a JPEG decoder; Node ships none and `pngjs` only encodes
PNG. It is pure JavaScript with no dependencies of its own and no install script, so it does not
reintroduce the postinstall `playwright` was dropped for.

The skills live in `skills/` as plain markdown — `manifest.json` naming the ids, one
`<id>/SKILL.md` each. `pnpm build:skills` copies that tree to `dist/skills/` so it ships with the
CLI, and fails the build if the manifest names a skill that is not on disk. A harness plugin is only
an envelope around this markdown, which is why the markdown is what the package carries.

The composite action is `action.yml` at the repository root. `tests/packaging/action.test.ts` parses
it alongside the workflows the installer writes and asserts they agree — every input a workflow passes
is an input the action declares, and the version it pins is this build's. What a test cannot do is run
a composite action, so `.github/workflows/dogfood-action.yml` does: dispatch it and the packed tarball
runs the whole pipeline against `fixtures/storefront`, capturing a baseline, restoring it from the
cache with the runs directory deleted, diffing a real overlay commit, and checking the bundle it
produced. It is `workflow_dispatch` only, for the same reason the slow-path job is.

The README artwork lives in `assets/`: `logo.svg` is the mark (also good as the repository avatar and
social preview), `cover.svg` is the banner, and `node scripts/render-assets.mjs` rasterises both to
the PNGs the README embeds. The README points at PNGs, not the SVGs, because npm rewrites relative
image paths to raw.githubusercontent.com, which serves SVG as `text/plain` — an SVG banner renders on
GitHub and breaks on the npm page. `assets/` is development-only and is not published.

`npm pack` runs the build (`prepack`) and produces the tarball a consumer actually gets;
`tests/packaging/pack.test.ts` asserts its shape — executable bin with a shebang, `.d.ts` present,
no sourcemaps, the skills present, and no compiled file without a source file behind it.

## Design

The authoritative design document is
[`docs/superpowers/specs/2026-08-08-visual-diff-design.md`](docs/superpowers/specs/2026-08-08-visual-diff-design.md),
with the build breakdown in
[`docs/superpowers/plans/2026-08-08-visual-diff-implementation-plan.md`](docs/superpowers/plans/2026-08-08-visual-diff-implementation-plan.md).
`src/types.ts` is the single shared contract every module codes against.

## License

MIT
