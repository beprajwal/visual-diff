import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LogTail,
  allocatePort,
  portOfUrl,
  probe,
  startDevServer,
  substitutePort,
  waitForReady,
} from './devserver.js';
import { RunnerError } from './errors.js';

const servers: Server[] = [];
const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listenOn(port: number, status = 200): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${port}/`;
}

describe('substitutePort', () => {
  it('replaces both spellings', () => {
    expect(substitutePort('pnpm dev --port $PORT', 5173)).toBe('pnpm dev --port 5173');
    expect(substitutePort('http://localhost:${PORT}/health', 5173)).toBe('http://localhost:5173/health');
  });

  it('leaves a template with no placeholder alone', () => {
    expect(substitutePort('http://localhost:4000/', 5173)).toBe('http://localhost:4000/');
  });
});

describe('portOfUrl', () => {
  it('reads an explicit port and falls back to the scheme default', () => {
    expect(portOfUrl('http://localhost:5173/cart')).toBe(5173);
    expect(portOfUrl('http://localhost/')).toBe(80);
    expect(portOfUrl('https://example.com/')).toBe(443);
    expect(portOfUrl('not a url')).toBeNull();
  });
});

describe('allocatePort', () => {
  it('returns a port nothing is listening on', async () => {
    const port = await allocatePort();
    expect(port).toBeGreaterThan(1024);
    await expect(probe(`http://127.0.0.1:${port}/`, 250)).resolves.toBe(false);
  });
});

describe('probe', () => {
  it('counts any HTTP answer as ready — a 404 still proves the server is listening', async () => {
    const url = await listenOn(await allocatePort(), 404);
    await expect(probe(url)).resolves.toBe(true);
  });
});

describe('waitForReady', () => {
  it('resolves once the server starts answering', async () => {
    const port = await allocatePort();
    const url = `http://127.0.0.1:${port}/`;
    const waiting = waitForReady(url, { timeoutMs: 5_000, intervalMs: 25 });
    setTimeout(() => void listenOn(port), 100);
    await expect(waiting).resolves.toBeUndefined();
  });

  it('fails with a server-not-ready error when the deadline passes', async () => {
    const port = await allocatePort();
    await expect(
      waitForReady(`http://127.0.0.1:${port}/`, { timeoutMs: 200, intervalMs: 25 }),
    ).rejects.toMatchObject({ kind: 'server-not-ready' });
  });

  it('gives up immediately when the process already exited', async () => {
    const port = await allocatePort();
    await expect(
      waitForReady(`http://127.0.0.1:${port}/`, {
        timeoutMs: 10_000,
        stop: () => 'dev server exited',
      }),
    ).rejects.toThrow('dev server exited');
  });
});

describe('LogTail', () => {
  it('keeps only the last N lines, including an unterminated one', () => {
    const tail = new LogTail(3);
    tail.push('a\nb\nc\nd\n');
    tail.push('e');
    expect(tail.text()).toBe('c\nd\ne');
  });

  it('joins chunks that split a line', () => {
    const tail = new LogTail(5);
    tail.push('hel');
    tail.push('lo\nworld\n');
    expect(tail.text()).toBe('hello\nworld');
  });
});

describe('startDevServer', () => {
  it('substitutes $PORT, waits for readiness and stops the child', async () => {
    const script =
      "require('node:http').createServer((q,s)=>{s.end('ok')}).listen(process.env.PORT, '127.0.0.1', ()=>console.log('listening on '+process.env.PORT))";
    const handle = await startDevServer({
      command: `node -e "${script}"`,
      cwd: process.cwd(),
      readyOn: 'http://127.0.0.1:$PORT/',
      readyTimeoutMs: 20_000,
    });
    stops.push(handle.stop);

    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/`);
    await expect(probe(handle.url)).resolves.toBe(true);
    expect(handle.log()).toContain(`listening on ${handle.port}`);

    await handle.stop();
    await expect(probe(handle.url, 250)).resolves.toBe(false);
  });

  it('retains the log when the server never becomes ready (spec §10)', async () => {
    const error = await startDevServer({
      command: 'node -e "console.error(\'boom: missing dependency\')"',
      cwd: process.cwd(),
      readyOn: 'http://127.0.0.1:$PORT/',
      readyTimeoutMs: 3_000,
    }).catch((err: unknown) => err);

    expect(RunnerError.is(error)).toBe(true);
    const runnerError = error as RunnerError;
    expect(runnerError.kind).toBe('server-not-ready');
    expect(runnerError.logName).toBe('server.log');
    expect(runnerError.log).toContain('boom: missing dependency');
  });
});
