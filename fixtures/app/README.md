# Meridian — the weather fixture app

A small weather dashboard over [Open-Meteo](https://open-meteo.com/), used as the visual-diff
fixture application with a **real recorded API** (api-mocking spec §9, D14), and as the source of
the README screenshots.

It is an npm workspace (`private: true`) of the visual-diff repository: Vite, Preact, and nothing
else.

---

## Data source, licence, and when it was recorded

| | |
|---|---|
| **Source** | Open-Meteo — `api.open-meteo.com`, `geocoding-api.open-meteo.com`, `air-quality-api.open-meteo.com` |
| **Licence** | Weather data by [Open-Meteo.com](https://open-meteo.com/), licensed **CC-BY-4.0** |
| **API key** | None. Open-Meteo's free tier needs no credential, which is why this API was chosen |
| **Recorded** | **2026-08-09** (entry timestamps `20:39:20Z`–`20:39:33Z`) |
| **Recording** | `.visual-diff/flows/weather.har` — 15 entries, ~85 KB, committed |
| **Attribution** | Rendered in the app footer, and repeated in `log.comment` inside the HAR |

**Tests never reach the network.** Every run replays the committed HAR. Recording is a separate,
deliberate, manual act:

```bash
npm run fixture:record -w fixtures/app      # from the repository root
npm run fixture:record                      # from fixtures/app
npm run fixture:record -- --dry-run --json  # fetch and report, write nothing
```

It is **not** part of `npm test` and never should be. If it were, the test suite would depend on a
third party's uptime and rate limits, and the responses would change under it — which is precisely
the non-determinism the tool exists to remove.

After re-recording, update the **Recorded** date above.

### What the recorder guarantees

`scripts/record-har.mjs` refuses to write a recording it cannot vouch for, rather than committing a
subtly broken one:

- **Status is asserted per request.** The two deliberate `400`s must still be `400`; if Open-Meteo
  ever starts accepting a latitude of 999, the error screen would be a fiction and the recorder
  fails instead.
- **CORS is asserted.** Open-Meteo only emits `access-control-allow-origin` when the request carries
  an `Origin`, and it must be `*`. A recording without it replays into a browser that blocks every
  response — every screen becomes the error state, for a reason nothing in the file mentions.
- **Transfer headers are dropped.** A HAR stores the *decoded* body, so a surviving
  `content-encoding: gzip` or stale `content-length` corrupts the replayed response.
- **Credentials are scrubbed unconditionally** — `Authorization`, `Cookie`, `Set-Cookie` — matching
  `DEFAULTS.alwaysRedactHeaders` in `src/types.ts`. Open-Meteo sends none of them; a recorder that
  only scrubs when it expects to find something leaks the first time an endpoint changes.
- **Only Open-Meteo origins are recorded.**

`tests/har.test.ts` re-asserts all of it against the committed file.

---

## The screens

| Screen | Route | What it is for |
|---|---|---|
| Location list | `#/` | Four saved locations, four independent forecast requests, four sparklines |
| Forecast detail | `#/location/<slug>` | Current conditions, the **SVG time-series chart**, the seven-day strip, air quality |
| Ad-hoc point | `#/at/<lat>,<lon>?label=…` | Where a search result leads; also how the error state is reached |
| Units toggle | `?units=c` / `?units=f` | Part of the route, so it is both clickable and directly addressable |
| Empty | search for `zzzzzzzz` | Open-Meteo returns `200` with **no `results` key at all** — a real empty response |
| Loading | any cold navigation | Per-panel skeletons; the air-quality card can still be loading while the rest is done |
| Error | `#/at/999,13.405` | A real `400 {"error": true, "reason": "Latitude must be in range…"}` |

The chart is the reason the fixture exists. Every coordinate in it is arithmetic over
`hourly.temperature_2m` and `hourly.precipitation_probability`, so a scenario that patches one
number in the recorded payload moves a curve by a few pixels and changes nothing else on the page —
a change no DOM diff describes usefully and no human spots by eye.

### Endpoints

All three the api-mocking spec's example scenarios target:

| Endpoint | Glob the spec uses | Recorded |
|---|---|---|
| `api.open-meteo.com/v1/forecast` | `**/v1/forecast**` | 4 locations + 1 search destination + 1 error |
| `air-quality-api.open-meteo.com/v1/air-quality` | `**/v1/air-quality**` | 4 locations + 1 search destination + 1 error |
| `geocoding-api.open-meteo.com/v1/search` | `**/v1/search**` | `san`, `reykjavik`, `zzzzzzzz` |

---

## Flows

`.visual-diff/flows/`, all replaying the one `weather.har`, all at `1280x800` and `390x844`:

| Flow | Covers |
|---|---|
| `locations.yaml` | The list, then Fahrenheit, then back to Celsius |
| `forecast.yaml` | Detail reached by **click** and by **direct navigation**, the chart, air quality, units |
| `search.yaml` | Idle prompt → results → a result's forecast → back → the genuinely empty result |
| `states.yaml` | The recorded `400` error screen, an unknown saved location, an unknown route |
| `detail.yaml` | The detail screen, anchored on what a scenario cannot take away — the flow to capture *both ways* |
| `detail-mock.yaml` | `detail.yaml` with `network: mock` and no recording at all (D13) |

Validate them with the real CLI:

```bash
cd fixtures/app && node ../../dist/cli/index.js flow check forecast
```

`forecast.yaml` deliberately reaches the detail screen twice, once by clicking and once by
navigating. Clicking arrives with the forecast already fetched by the list; a direct `goto` arrives
cold, with both requests in flight. A `delay` scenario only produces a loading state on the second.

**Known and deliberate**: the `states` flow records two console errors. Chromium logs
`Failed to load resource: … 400 (Bad Request)` for each recorded `400`. No application code writes
them and nothing can suppress them. They are identical on every run, so two runs of that flow diff
to zero `console` findings — a third one would be real.

`detail.yaml` exists because `forecast.yaml` cannot host a scenario that empties the forecast: it
waits on `chart-line` and counts the 48 precipitation bars, and an empty hourly series removes the
very elements it waits for, so the run fails on the wait instead of screenshotting the empty state.
`detail.yaml` waits only on `current-conditions`, `temperature-chart` (the *card*, which wraps
either the chart or its empty state) and `air-quality` — all present in both renderings.

---

## Scenarios

`.visual-diff/scenarios/`, committed alongside the flows because a historical replay reads them out
of git at the target SHA (api-mocking spec §5 "Storage"):

| Scenario | Mode | What it does |
|---|---|---|
| `empty-forecast.yaml` | `overlay` | Merge-patches `hourly.temperature_2m` to `[]`, so the chart renders "No hourly readings" while the rest of the screen stays the real recorded payload |
| `mock-detail.yaml` | `mock` | Answers both endpoints from invented bodies, with no recording involved at all |

```bash
cd fixtures/app
node ../../dist/cli/index.js scenario list
node ../../dist/cli/index.js run detail                            # the recorded state
node ../../dist/cli/index.js run detail --scenario empty-forecast  # the empty state
node ../../dist/cli/index.js diff detail 0000 0001                 # labelled `cross-scenario`
node ../../dist/cli/index.js run detail-mock --scenario mock-detail
```

`tests/scenarios.test.ts` drives both against the committed HAR without a browser, and asserts that
every rule's glob matches a URL `src/api.js` really builds — a glob that matches nothing is the
failure §8 calls the most important line in the section, because the run succeeds and the
screenshot is the recorded state while its author believes it is the patched one.

---

## Trace archives

`traces/` holds four **real Playwright trace archives** recorded from this app, committed so that
e2e ingestion (e2e spec §9, test 1) is tested against archives Playwright actually wrote rather than
against hand-built zips that only prove the reader agrees with our assumptions.

| Archive | Layout | What it is for |
|---|---|---|
| `dashboard-baseline.zip` | library | Named steps from `tracing.group`, including a deliberately duplicated title |
| `dashboard-changed.zip` | library | The same test against a build with three documented edits — the pair that makes a diff non-empty |
| `search-library.zip` | library | No step titles at all, so every step id is synthesized from a selector |
| `dashboard-runner.zip` | `@playwright/test` | `test.trace` plus one `N-trace.*` prefix per BrowserContext |

```bash
npm run fixture:traces -w fixtures/app         # the three library archives — offline
node scripts/record-runner-trace.mjs           # the runner archive — needs the npm registry
```

Both are manual, like `fixture:record`. The library archives need no dependency beyond the
`playwright-core` this repository already has; the runner archive is recorded by installing
`@playwright/test` into a throwaway directory outside the repository, because adding it to a
`package.json` here would put a browser download back into every install.

`traces/README.md` documents what each archive contains, what was stripped from them and why, and
the facts about trace screenshots and snapshots that they are the evidence for.

---

## Running it

```bash
npm run dev -w fixtures/app       # Vite dev server
npm run build -w fixtures/app     # production build
npm test -w fixtures/app          # this fixture's own suite (see the caveat below)
```

`npm test -w fixtures/app` runs `vitest` against `fixtures/app/vitest.config.js`. It is **not**
collected by the repository's root `npm test`, because the root `vitest.config.ts` excludes
`fixtures/**` — the fixture tree is input to the integration tests there. Adding
`fixtures/app/tests/**/*.test.ts` to the root config (and narrowing the `fixtures/**` exclusion)
would fold these into the main run.

The suite is:

| File | What it protects |
|---|---|
| `tests/api.test.ts` | Request URLs, spelled out byte for byte, and every error mapping |
| `tests/units.test.ts` | C/F conversion and formatting |
| `tests/chart.test.ts` | Chart geometry, including empty, flat and single-point series |
| `tests/transform.test.ts` | Payload → view model, mostly for fields a scenario removed |
| `tests/router.test.ts` | Hash routes and their round trip |
| `tests/har.test.ts` | The committed recording: coverage, CORS, headers, payload shape, scrubbing |
| `tests/flows.test.ts` | The flow specs, parsed by the repository's own parser |
| `tests/replay.e2e.test.ts` | **Every flow, executed in Chromium, served entirely from the HAR** |
| `tests/traces.test.ts` | The committed trace archives: readable by this repository's reader *and* by Playwright's own, and still containing the properties they were recorded for |

---

## How the recording and the dev server divide the work

`vdiff run <flow>` replays this app end to end. Two layers of interception make that work, and the
order of the two is the whole design (`src/runner/browser.ts#newContext`):

1. an **app-origin backstop** is registered first, so Playwright reaches it last. It lets
   `localhost` / `127.0.0.1` / `[::1]` / `data:` / `blob:` through to the dev server and aborts
   everything else;
2. the **recording** goes on top with `notFound: 'fallback'`, so a request it cannot answer falls
   *down the handler chain* rather than out to the network.

The result for this fixture: the Vite document, the modules and the styles are served by Vite, the
two Open-Meteo endpoints are served from `weather.har`, and nothing reaches the internet. A run
reports `har 4 hit / 0 miss` for `detail` — the API calls only. Requests the dev server answered are
recorded in `network.json` as `bypassed` rather than as HAR hits, so the coverage number means what
it says.

This mattered here first. The slice-1 storefront (`fixtures/storefront`) runs `network: off`, and
its recording, made with `--record`, contains the dev server's own document — so replaying it never
needed the backstop. A recording made against a real API cannot contain the dev server at all: the
port is ephemeral, so the URLs would differ on every run.

`tests/replay.e2e.test.ts` scopes its own routing the same way, deliberately, so that suite cannot
pass while `vdiff run` fails.
