# Flow Selection — Design (only the flows a change reaches)

Decisions continue the CI mode numbering: D59 to D63.

## 1. Problem

The action replays every flow in `.visual-diff/flows` on both sides of every pull request. For a
project with thirty flows that is sixty replays, most of them of pages the pull request did not
touch, and on a base side that is a shared deployment the parallel load is what produces
intermittent step timeouts under four-way concurrency. A pull request that changes one
page should replay the flows that visit that page, and a reviewer should be able to see why those
and not others.

## 2. Scope

### In

- `vdiff select`: from a set of changed files to the flows that reach them, with the reason per
  flow and the changed source no flow reaches.
- A `select:` section in `config.yaml` describing the app enough to walk from a file to a route:
  source directories, the pages directory and its router convention, import aliases, globs that
  mean "everything", and rules for files found by name rather than by import.
- A `covers:` key on a flow spec for the source its routes cannot show.
- The action asks the selector when `flows` is empty and the section exists, and skips the replay
  when nothing is reached.

### Explicit non-goals

- A TypeScript program. The graph is read from source text with regular expressions; the three
  things that would make a regex graph useless are handled (D60) and the rest is accepted.
- Routers other than the Next.js pages router. The adapter interface takes a second one; until then
  an app on another router declares coverage with `covers:`.
- Deciding what a flow *should* cover. The selector reports what it could not attribute; a human
  writes the flow or the `covers:` glob.

## 3. Decisions and rationale

**D59 — A flow is reached through its routes, its own file, its scenario, its fixtures, or its
`covers:` globs; some changes reach every flow at once.**

Five kinds of evidence, each named in the result. A changed flow spec replays that flow, new or
not. A changed scenario replays the flows declaring it. A changed file under `.visual-diff/` that a
flow or its scenario names — an upload, a served body — replays those flows. A changed source file
reaches a flow when a page one of the flow's `goto`/`readyOn` routes visits imports it, through any
number of hops. A changed file matching a flow's `covers:` glob reaches that flow. And a change to
`config.yaml`, to the installed workflows, or to a glob in `select.all` reaches every flow, because
it changes what every replay means. The caller may also say "everything" with a reason of its own —
the action does, for a labelled pull request.

**D60 — Barrels bind by name, `import type` binds nothing, and a side-effect import binds all.**

Without the first, a page importing `Button` from `components/index.ts` depends on every file the
barrel re-exports, and one shared barrel makes every component reach every page. Without the
second, a type imported from a data table's module carries that module to pages that never render
it; on the first project this ran against, that alone halved a typical selection. The third is the honest default
for `import './x.css'`, `import('./lazy')` and `require()`: nothing in the clause says what is used.

**D61 — A file whose users name it rather than import it is seeded from the files that mention
the name.**

A translation namespace is imported by one resources index that imports every namespace, and that
index is imported by the app shell. Followed as imports, any string change reaches every page. The
`named:` rule in `select:` captures the name from the file's path and seeds the walk from the files
whose text mentions it, skipping the index. One rule shape covers i18n namespaces, lazily loaded
registries and plugin tables.

**D62 — Routes come from the flow's URLs, normalised the way a deployment would read them.**

The origin, query and hash go. A leading `${VAR}` segment is a base path the deployment supplies;
the configured `basePath` is the same thing written down; both go. Any other `${VAR}` segment is a
parameter and matches one segment of anything. A URL ending in a file extension names an asset and
matches no page. The most specific page wins, literal segments over parameters over catch-alls,
which is the router's own rule.

**D63 — Nothing selected is an answer, and the action acts on it; a selector that fails is not.**

`vdiff select` exits 0 with `mode: none` when no flow reaches the change, and the action skips the
replay, the diff and the comment, leaving the step summary that names the changed source no flow
covers. That is the information a reviewer needs: either the change renders nothing, or a flow is
missing. A selector that errors, by contrast, says nothing about coverage, so the action replays
every flow and warns — selection trades time for nothing, never coverage for time.

## 4. The command

```
vdiff select [--base <rev>] [--changed <file>] [--all <reason>] [--summary <file>]
```

`--base` diffs the working tree against the merge-base with `rev` and adds untracked files, so an
uncommitted edit counts locally and a pull request's merge commit counts in CI. `--changed` takes a
file of paths, `-` for stdin; the two combine. `--all` skips the walk with the given reason.
`--summary` appends the markdown summary to a file — `$GITHUB_STEP_SUMMARY`. The envelope carries
`mode` (`all` | `some` | `none`), `flows`, `everything`, `reasons`, `skipped` (reached but
`ci: false`), `unattributed`, `warnings`, and what the selection was computed from.

## 5. The action

Two inputs: `select` (`auto` | `off`, default `auto`) and `select-all-label` (default
`visual-diff: all`). Two outputs: `flows` and `selection` (`named` | `all` | `some` | `none`).
The select step runs after the install, because the resolve step runs before the CLI exists; every
pull-request step after it is skipped when `selection` is `none`.

## 6. Testing

`src/select/select.test.ts` builds a small Next.js-shaped repository on disk — three pages, a barrel,
a type-only import, a namespace file with its index, five flows — and asserts one test per kind of
evidence in D59 plus the two fan-out guards in D60 and the rule in D61. `routes.test.ts` pins the
normalisation in D62 and the router's specificity order. The command is tested with git faked
through `spawn` and the selector faked through the ports; the envelope shape is pinned in
`main.test.ts`; `action.test.ts` pins the new inputs and outputs.

## 7. Addendum: registries, read by their changed lines

**D65 — A registry is read by the lines a change touches, and reaches the files that mention the
names on them.**

Some files are lists other files read: a feature-flag map, a route table, an icon set. Nearly every
page imports one, so walked as a file, adding one flag replayed nearly every flow — and flags are
added weekly. A `registries` rule names such a file and a `keys` pattern over a changed line; every
capture of every match is a name, and the walk starts from the source files mentioning those names
instead of from the file. A match written identically on both sides of the diff is cancelled, so a
list kept on one line and rewritten whole to add a key touches that key and not its neighbours; a
match whose value changed keeps every capture, since whatever read the old value now reads another.
A changed line that is neither blank, a comment, nor matched is a change to how the file works, and
the file is walked whole as before. A name nothing mentions yet reaches no flow and is not reported
as uncovered. The lines come from `git diff -U0` against the merge-base, so a registry is read this
way only under `--base`; given `--changed` alone it is an ordinary file. A registry that resolves
takes precedence over a `select.all` glob matching the same file.

On the first project measured, edits that added or changed one flag went from 26 of 29 flows to
between 0 and 12.

**D66 — A stylesheet is a registry of classes.**

`css: true` reads a stylesheet: the names are the classes of the rules each changed line sits in,
the classes a changed selector line writes, and what `@keyframes`, Tailwind's `@custom-variant` and
`@utility` define (a `-*` utility is matched as a prefix). Each class also names its BEM element and
block, because a library that builds `menu__item--active` from a prefix is mentioned only as `menu`.
Comment prose is no change. A changed line under a rule with no class — `body`, `:root`, an element —
styles every page that loads the sheet, so the file is handled whole, which for a global stylesheet
means `select.all` answers. So does a class no source mentions, since a rule for a class nothing
names is either built at runtime or used only by other rules.
