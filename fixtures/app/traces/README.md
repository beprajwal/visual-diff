# Committed Playwright trace archives

Four real Playwright trace archives, recorded from this fixture app, committed so that e2e
ingestion (e2e spec §9, test 1) is tested against archives Playwright actually wrote — hermetically,
with no live test suite, no browser download and no network.

They are fixtures, not build output: `fixtures/` never reaches the published tarball (the root
`package.json` ships `dist` and `README.md` only), so their size is a cost to the repository and to
nobody's install.

| archive | layout | bytes | frames | what it is for |
|---|---|---:|---:|---|
| `dashboard-baseline.zip` | library | 151 177 | 7 | named steps, a duplicated step title, the baseline of the pair |
| `dashboard-changed.zip` | library | 171 086 | 6 | the same test against a changed build — the other half of the pair |
| `search-library.zip` | library | 140 765 | 6 | a library trace with **no step titles at all**, the default library shape |
| `dashboard-runner.zip` | `@playwright/test` | 267 393 | 11 | `test.trace` + one `N-trace.*` prefix per BrowserContext |

Total: **713 kB**. The JPEG screencast frames are almost all of it — they are already compressed, so
the zip cannot shrink them — and how many there are is decided by the browser's compositor rather
than by the workflow, so the count moves by one or two between regenerations and the byte totals
above move with it.

## Recorded from

- `playwright-core` **1.62.1** (the version this repository already depends on)
- Chromium **151.0.7922.34** (revision 1234)
- `@playwright/test` **1.62.1**, for `dashboard-runner.zip` only, installed into a throwaway
  directory and never into any `package.json` here
- trace format version **8**; `origin: 'library'` for three of them, `'testRunner'` for the runner one
- macOS (`platform: darwin`), 2026-08-10

## How to regenerate

```sh
npm run fixture:traces                      # the three library archives — offline, ~20s
node scripts/record-runner-trace.mjs        # the runner archive — needs the npm registry
```

Both are run **by hand**, like `npm run fixture:record`. Nothing in `npm test` or in CI regenerates
them, because a fixture that is rebuilt on every run is not a fixture.

The generators are `scripts/record-traces.mjs` and `scripts/record-runner-trace.mjs`; each explains
its own choices at the top. In outline:

1. `vite build` the app once into a temporary directory.
2. Copy it and apply three documented edits to the copy — accent colour, corner radius, and the list
   heading — so `dashboard-changed` is a *different build*, not a differently rendered one. Each
   edit asserts it matched exactly once, so a silently unmatched patch cannot produce two identical
   archives and a diff test that passes by comparing a thing to itself.
3. Serve each build from `127.0.0.1:5245` — a fixed port, so every URL inside every archive is
   identical from one archive to the next and from one regeneration to the next.
4. Drive the app with Open-Meteo served from the committed `.visual-diff/flows/weather.har`
   (`notFound: 'abort'`), so recording touches the network at no point.

A regeneration rewrites every byte of every archive regardless of whether anything changed: page
GUIDs, wall-clock timestamps and resource sha1s are all new each time. Expect a full-file diff, and
regenerate only when there is a reason to.

## What is in each archive

### `dashboard-baseline.zip` and `dashboard-changed.zip`

One test, titled the way `@playwright/test` titles one:

```
weather.spec.ts:14 › weather dashboard › shows saved locations and opens a forecast
```

with U+203A separators. A library trace has no test concept — the only title it carries is the one
passed to `tracing.startChunk({ title })` — so writing them in the runner's format is what makes
these archives exercise the same title parsing a real suite's archives will. The `:14` is the point:
a test title carries a **line number**, so inserting an import above a test renames every title in
the file. A flow key that keeps it is removed-and-added on an edit that changed nothing.

Steps come from `tracing.group()`, the library's only analogue of `test.step`:

```
open the dashboard → switch to Fahrenheit → open a saved location → read the forecast → read the forecast
```

The last title is repeated on purpose: §8 requires duplicate step titles inside one test to be
disambiguated with a stable suffix and reported once as a notice, and a fixture whose titles are all
unique cannot test that. It ingests as `read-the-forecast` and `read-the-forecast-2`.

`dashboard-changed.zip` records the identical workflow against the patched build, so it carries the
same title, the same flow and the same step ids — the two pair — while differing in the DOM (the
list heading reads `Your places`) and in pixels.

### `search-library.zip`

```
weather.spec.ts:52 › weather dashboard › finds a place by name
```

The same recorder with **no `tracing.group` calls**, which is what a library trace ordinarily looks
like: there are no step titles anywhere in it. Every step id has to be synthesized from the action's
class, method and selector — `waitforselector-data-test-search-hint` — which is a selector rather
than a name, and moves whenever the locator moves. The reader reports it as a `synthesized-step-ids`
notice. This is the degraded case D26 describes, recorded rather than imagined.

### `dashboard-runner.zip`

The layout `playwright-core` cannot produce, and the one a reader that assumes the other silently
mis-parses:

```
test.trace                                    the runner's own tree: hooks, fixtures, test.step, expect
0-trace.trace  0-trace.network                one prefix per BrowserContext …
1-trace.trace  1-trace.network                … and the ordinal is NOT creation order
resources/…                                   shared across all three
```

Note that `test.trace` has **no** `.network` sibling, while the library halves do. A reader that
requires the triple to exist for every prefix fails on exactly this archive; prefixes have to be
discovered by globbing `(.+)\.trace$`, which is what Playwright's own loader does.

The spec it ran is written out by `record-runner-trace.mjs` rather than committed, because it is an
input to a recording rather than a test of this repository. It contains, deliberately: `test.step`
titles including a nested one and a duplicated one, an `expect`, a `beforeEach` hook (so the archive
carries the `Test.hook` / `Test.fixture` infrastructure a reader must skip rather than present as
steps), and a **second BrowserContext**, which is what puts `1-trace.*` in the archive at all.

Its test-results directory was:

```
dashboard-weather-dashboar-4db88-ations-and-opens-a-forecast-chromium-desktop
```

That name is the only place the project name `chromium-desktop` appears. It is not in the archive,
and neither is a retry index or any git metadata — a point §7 of the spec gets wrong, and the reason
those three are reported as missing capabilities rather than guessed at.

## Facts these archives are the evidence for

- **A screenshot is the viewport composite, downscaled, in lossy JPEG.** Every `screencast-frame`
  event here reports 900x600 — the *logical viewport* — while the JPEG on disk is 798x532, because
  frames are scaled to fit an 800x800 box and `deviceScaleFactor` is discarded. Image dimensions
  must be read from the JPEG header; the event is not about the image.
- **Screenshots are not per-step.** Frames come from a CDP screencast throttled to about 5 fps, so a
  step that changed nothing visible has no frame of its own and several steps legitimately resolve
  to one image. The ingest marks those steps `shared`; a report that presents a repeated image as a
  defect is wrong.
- **Snapshots are delta-encoded.** A `frame-snapshot` is not self-contained — unchanged subtrees are
  back-references to a snapshot *n* steps back. `dashboard-baseline.zip` holds ten snapshots whose
  entire document is a single back-reference — `[[1,130]]`, "the document is the one from the
  previous snapshot" — so a reader that opens one in isolation concludes the page is empty.
- **There are no computed styles, no accessibility tree and no element geometry** in any of them,
  at any version, under any configuration. The author's CSS is all there (inline `<style>` text,
  adopted stylesheets as text, external sheets as resources), so the capability is recoverable by
  rehydrating a snapshot in a browser — but it is not *in* the archive.
- **Console recording is unconditional, network is not.** `trace.network` is a zero-byte file
  whenever `snapshots` is off. These were recorded with `{ screenshots: true, snapshots: true }`,
  so all four carry both. `tracing.start()` with no options records neither, which is the *default*
  case rather than an edge case.

## What was stripped, and why

Playwright records the client call site of every API call as an absolute path, in two places: the
`trace.stacks` member, and a `stack` field on individual events (`tracing.group` carries one
inline). For a fixture committed to a public repository that is the home directory of whoever
recorded it, plus a diff on every regeneration from a different checkout.

Both are removed and the archive repacked. Nothing reads either — `trace.stacks` is optional by
construction (the runner's own `test.trace` has no `.stacks` sibling) and `stack` is what the trace
viewer's call tab displays. `tests/traces.test.ts` asserts that no archive names a filesystem path,
and that all four still load through **Playwright's own `TraceModel`**, so "optional" is a tested
claim rather than a hopeful one. Pass `--keep-stacks` to skip the whole step.

Nothing else is touched: every event, every snapshot, every frame and every resource is exactly what
Playwright wrote.

## Known wrinkle: network routing appears as steps

Both generators serve Open-Meteo from the committed HAR, which is what a great many real Playwright
suites do. Each fulfilled request is an API call, so it appears in the trace as an action —
`Route.fulfill` in the library archives, `Fulfill request` in the runner one — and the reader turns
it into a step, because it has a page and is not runner infrastructure.

In the two dashboard archives those calls fall inside a `tracing.group` / `test.step` and are
absorbed into the surrounding step, so nothing shows. In `search-library.zip`, which has no groups,
five of the ten steps are `Route.fulfill`, and they collide into `route-fulfill`, `route-fulfill-2`
… and raise a `duplicate-step-titles` notice about a title no human wrote. `dashboard-runner.zip`
has six `Fulfill request` steps for the same reason.

That is faithfully what the archives contain — it is not a recording artefact to be tidied away —
but whether route handling should be excluded from the steps an ingest reports, the way runner hooks
and fixtures already are, is a question for the reader rather than for these fixtures.
