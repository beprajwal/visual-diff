# Fixtures

Two fixture applications, with different jobs. They are not alternatives and neither replaces the
other.

| | `storefront/` | `app/` |
|---|---|---|
| Spec | slice-1 §11.2 | api-mocking §9, D14 |
| Question it answers | did the **code** change between two revisions? | did the **network** change between two scenarios? |
| Network | `off` — no backend at all | `replay` — a real recorded Open-Meteo API |
| Carries | a scripted git history of seven commits | a committed HAR and four flows |
| Workspace | no | yes (`private: true`, registered in the root `package.json`) |

```
fixtures/
  storefront/              slice-1: a tiny frontend-only Vite app, at its baseline state
    .visual-diff/          committed config + flow spec (spec §6 git boundary)
  commits/NN-name/         the seven commits laid over it, one per known UI change
    commit.json            message, the change it represents, what the diff should say
    files/…                whole-file overlay copied over the working tree
  build-history.mjs        materialises the storefront history into a throwaway directory

  app/                     api-mocking: the Meridian weather dashboard over Open-Meteo
    .visual-diff/flows/    four flow specs + weather.har, all committed
    scripts/record-har.mjs the one thing here that touches the network, run by hand
    README.md              data source, licence, recording date, and the known runner gap
```

`app/` is where the api-mocking slice's scenarios land — it is the only fixture in the repository
with a real recorded API, so it is the only one that can exercise overlay mode end to end. See
[`app/README.md`](app/README.md), which also records a slice-1 runner gap that this fixture is the
first thing in the repository to reach.

The rest of this file is about `storefront/` and its scripted history.

## Building it

```bash
node fixtures/build-history.mjs --verify            # builds fixtures/.tmp/checkout-history
node fixtures/build-history.mjs --out /tmp/x --json # for a test harness
node fixtures/build-history.mjs --verify-sources    # checks the fixtures only: no build, no git
```

The build **never touches this repository's git history**. It copies `storefront/` into a throwaway
directory, runs `git init` there, and pins `GIT_DIR` and `GIT_WORK_TREE` at that directory for every
subsequent call, so git cannot walk up and find the outer repository. It also refuses to overwrite
any output directory that is not `fixtures/.tmp/…` or under the OS temp directory unless `--force`
is passed. `fixtures/.tmp/` is gitignored.

Commit identities and timestamps are fixed, so the same fixture tree always produces the same SHAs.
A failing integration test is reproducible, and a dep cache keyed on the revision survives rebuilds.

`buildFixtureHistory`, `verifyFixtureHistory`, `verifyOverlaySources` and `showAt` are exported, so
`tests/integration/history.test.ts` can import this module directly rather than shelling out.

## The commits

| # | Change | What the diff must say |
|---|---|---|
| 0 | baseline | The point everything else is compared against |
| 1 | label edit | One `content` finding on the cart CTA: `text: "Pay" -> "Pay now"`, plus a width change |
| 2 | restyle | `style` findings on the CTA (background, border colour, radius). No `content`, and no `layout` — the restyle deliberately changes paint only |
| 3 | layout shift | `layout` findings: the summary and the CTA both move down 40px. Rect deltas, no text change |
| 4 | added step | `flowDiff` gains `{ id: 'receipt', status: 'added' }`; the payment step gains the Place order button |
| 5 | renamed selector | `flowDiff` reports `{ id: 'pay-click', status: 'spec-changed', detail: "selector '#pay' -> '[data-test=pay]'" }` — **not** a removed/added pair |
| 6 | introduced console error | A `console` finding at severity `high` on the `receipt` step |

Each `commit.json` restates its expectation next to the change, and `COMMIT_EXPECTATIONS` in
`build-history.mjs` asserts the *code* actually implements it — cumulatively, so an overlay that
forgets to carry an earlier change forward fails immediately instead of quietly producing a diff
that contradicts the test the commit exists for.

## Why whole-file overlays instead of patches

`commits/NN/files/` holds complete files, not diffs. A patch that stops applying because an
unrelated line moved is a fixture that fails for a reason having nothing to do with the tool under
test. The cost is that each overlay repeats the earlier commits' content, and
`--verify-sources` exists precisely to catch a copy that drifted.

## The storefront itself

Three screens — cart, payment, receipt — with no framework and no backend, so the flow's
`network.mode` is `"off"` and no HAR is needed. Two details are deliberate:

- **`[data-test=order-date]` is genuinely non-deterministic.** The flow masks it. Without the mask
  every single run would report a finding there, which is exactly the noise `mask` exists to kill.
- **Click handling is delegated by `data-action`, not by the selectors the flow uses.** That lets
  commit 5 rename `#pay` to `[data-test=pay]` in the markup and the flow spec without touching the
  event wiring, so the commit isolates the one thing it is supposed to test.

## Adding a commit

1. Create `commits/07-your-change/` with `commit.json` (`message`, `change`, `expect`) and a
   `files/` overlay containing the **complete** content of every file it changes, carried forward
   from the previous commits.
2. Add an entry to `COMMIT_EXPECTATIONS` in `build-history.mjs` and to `CHANGE_SEQUENCE`.
3. Run `node fixtures/build-history.mjs --verify-sources`.
