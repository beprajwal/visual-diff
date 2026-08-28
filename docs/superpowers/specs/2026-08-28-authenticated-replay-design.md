# Authenticated replay — Design

Date: 2026-08-28
Status: Implemented
Builds on: slice 1 (D1–D9), API mocking (§3 recording, §6 scrubbing)

## 1. Problem

Every replay opens a clean browser context. That is what makes two runs comparable, and it is also
why a flow over anything behind a login captures the login screen on every step. The step vocabulary
is closed and has no notion of a session, so the only way to get past a login today is to type a
credential into a committed flow — which is not a way.

Two real cases drove this:

- An app whose middleware redirects to an external identity provider when a session cookie is
  absent. The e2e suite next door already logs in once and saves a Playwright storage state.
- An app with a plain login form, where an agent wants to script the sign-in as part of the flow
  without the password ever reaching the repository.

## 2. Storage state (`browser.storageState`)

`config.yaml` gains one optional section:

```yaml
browser:
  storageState: .visual-diff/auth/state.json
```

- The value is a path, relative to the project root, of a Playwright storage-state file: the shape
  `BrowserContext.storageState({ path })` writes (cookies + per-origin localStorage). Every context of
  every viewport of every run starts from it, clone-source contexts included.
- The path is resolved at config-load time against the **working tree's** root. A historical
  replay (`--at <ref>`) reads its flow spec from git at that revision but its session from the
  machine it runs on: a session is not a property of a revision.
- A configured file that is not on disk fails the run before anything launches, with kind
  `auth-state-missing` and exit 2. Trusting it would surface as a login page in every shot, which
  reads as a regression in the application rather than a missing file.
- `meta.json` gains an optional `authenticated: true` on runs that used it, so a report can say
  which side of a diff was signed in. Earlier runs read back unchanged.
- The file is a live session and is never copied into a run directory. `vdiff init`'s gitignore
  block already leaves everything under `.visual-diff/` untracked except the committed
  directories, so `.visual-diff/auth/` needs no new rule; the scaffolded `config.yaml` shows the
  key commented out with that note.

## 3. Environment references in `fill`

A `fill` value may contain `${NAME}`, where `NAME` is `[A-Z_][A-Z0-9_]*`. It is replaced from the
environment when the step runs. Nothing else is interpolated: a `$` followed by anything but that
shape is literal text, so ordinary copy needs no escaping and the grammar has one form to learn.

- The flow spec is unchanged, so the structural diff compares references, and the same flow can be
  read from git history for a historical replay.
- `vdiff run` resolves every reference the flow makes **before** launching the browser and fails
  with kind `env-missing`, exit 2, naming the unset variables. Failing on step 4 for a typo in a
  variable name would have spent the install, the dev server and three shots first.
- Every resolved value is handed to the HAR scrubber. On record, the scrubber replaces each value
  wherever a request or response can carry it — request URL, query-string values, post body text
  and params, response body text — with the existing `__REDACTED__` placeholder. A login POST body
  is exactly what a committed HAR would otherwise leak; header and cookie scrubbing (§6 of the mocking
  spec) already covered the rest. `--no-scrub` skips this pass as it skips the others.

## 4. The host a session is bound to

Cookies are scoped to a host. A storage state captured against `app.lvh.me` does nothing for a
server reached at `127.0.0.1`, which is where spawn mode used to point every replay. A flow (or
`config.yaml`) may now write its `baseUrl` with the port placeholder — `http://app.lvh.me:$PORT` —
and spawn mode substitutes the allocated port into *that* URL instead of the loopback default.
`readyOn` still decides the port; `baseUrl` only decides the origin the flow sees. Attach mode is
unchanged: a `baseUrl` with a literal port is probed and, if it answers, driven as before.

## 5. Not in scope

- A `login:` step verb or a `--storage-state` flag. Config-level state covers the recurring case;
  the flow-level login step covers the scripted one. A flag can come when someone needs to run the
  same flow anonymously and signed in from one config.
- Refreshing an expired storage state. The file is the user's; a stale one shows the login page,
  which is the honest outcome.
- Redacting resolved values from screenshots or DOM snapshots. A password field does not render
  its value; an email in an account menu is content the user chose to shoot.
