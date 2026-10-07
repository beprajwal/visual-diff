/**
 * `--attach`: the app is already served somewhere, so the run installs nothing, spawns nothing and
 * drives that origin — a `mode: mock` flow included, whose scenario still answers its API.
 *
 * The config's `dev` and `install` commands both fail on purpose: a run that reached either would
 * end `server-not-ready` or `install`, so an `ok` run is the proof that neither was touched. The
 * historical case also proves no worktree was needed for the revision's flow and scenario.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runFlow } from '../../src/runner/index.js'
import { paths } from '../../src/store/index.js'
import type { NetworkEntry, RunResult } from '../../src/types.js'

function chromiumAvailable(): boolean {
  try {
    const { chromium } = require('playwright-core') as typeof import('playwright-core')
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
}

const describeIfBrowser = chromiumAvailable() ? describe : describe.skip

const SERVER = `
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
createServer((req, res) => {
  if (req.url && req.url.startsWith('/api/cart')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ total: 'from the server' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(Number(process.env.PORT), '127.0.0.1');
`

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>cart</title></head>
<body>
  <p data-test="total">loading…</p>
  <script>
    fetch('https://api.example.test/cart')
      .then((r) => r.json())
      .then((data) => {
        document.querySelector('[data-test=total]').textContent = 'total ' + data.total;
      });
  </script>
</body></html>
`

const CONFIG = `app:
  install: exit 9
  dev: node -e "process.exit(3)"
  readyOn: http://127.0.0.1:$PORT/
  readyTimeout: 10s
`

const FLOW = `version: 1
flow: cart
viewports: [400x300]
network: { mode: mock }
scenario: cart
steps:
  - id: cart
    goto: /
    expect:
      - selector: "[data-test=total]"
        text: "total 7.00"
    shoot: true
`

const SCENARIO = `version: 1
scenario: cart
mode: mock
rules:
  - id: cart
    match:
      url: 'https://api.example.test/cart'
    respond:
      status: 200
      body: { total: '7.00' }
`

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() =>
        resolve(typeof address === 'object' && address !== null ? address.port : 0),
      )
    })
  })
}

async function waitUntilServing(url: string): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`app never served ${url}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function networkLog(run: RunResult): Promise<NetworkEntry[]> {
  return JSON.parse(
    await readFile(join(run.runDir, 'steps', 'cart', 'network.json'), 'utf8'),
  ) as NetworkEntry[]
}

let root: string
let app: ChildProcess | undefined
let baseUrl: string
let current: RunResult
let historical: RunResult

beforeAll(async () => {
  if (!chromiumAvailable()) return
  root = await mkdtemp(join(tmpdir(), 'vdiff-attach-'))
  await mkdir(paths.flowsDir(root), { recursive: true })
  await mkdir(join(root, '.visual-diff', 'scenarios'), { recursive: true })
  await writeFile(paths.configFile(root), CONFIG, 'utf8')
  await writeFile(paths.flowFile(root, 'cart'), FLOW, 'utf8')
  await writeFile(join(root, '.visual-diff', 'scenarios', 'cart.yaml'), SCENARIO, 'utf8')
  await writeFile(join(root, 'server.mjs'), SERVER, 'utf8')
  await writeFile(join(root, 'index.html'), HTML, 'utf8')

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  }
  git('init', '-q')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'cart')

  const port = await freePort()
  baseUrl = `http://localhost:${port}/`
  app = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  })
  await waitUntilServing(baseUrl)

  current = await runFlow({ flow: 'cart', cwd: root, attach: true, baseUrl })
  historical = await runFlow({ flow: 'cart', cwd: root, attach: true, baseUrl, at: 'HEAD' })
}, 240_000)

afterAll(async () => {
  app?.kill()
  if (root) await rm(root, { recursive: true, force: true })
})

describeIfBrowser('attach', () => {
  it('drives the running app with no install and no spawn, and records the run as attached', () => {
    expect(current.meta.status).toBe('ok')
    expect(current.meta.mode).toBe('attach')
    expect(current.meta.network).toBe('mock')
  })

  it("answers the mock flow's API from its scenario, never from the app's own server", async () => {
    const api = (await networkLog(current)).filter((entry) =>
      entry.url.includes('api.example.test'),
    )
    expect(api.length).toBeGreaterThan(0)
  })

  it('replays a revision from git alone: no worktree, no install', () => {
    expect(historical.meta.status).toBe('ok')
    expect(historical.meta.mode).toBe('attach')
    expect(historical.meta.revision.ref).toBe('HEAD')
    expect(existsSync(paths.worktreesRoot(root))).toBe(false)
  })
})
