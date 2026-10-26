import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { DeploymentGate, listenDeploymentControl } from '../server/deployment.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
test('deploy lease refuses active clients, blocks new writes/sockets, releases and expires', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pole-deploy-'));
  const gate = new DeploymentGate(30, 150);
  const app = createApp({
    dbPath: join(dir, 'board.sqlite'),
    deployment: gate,
    revision: 'b'.repeat(40),
  });
  const path = join(dir, 'control.sock');
  const closeControl = await listenDeploymentControl(path, gate);
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const control = (route: string, method = 'POST') =>
    new Promise<number>((resolve, reject) => {
      const req = request({ socketPath: path, path: route, method }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      });
      req.on('error', reject);
      req.end();
    });
  try {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await (await fetch(base + '/api/health')).json()).revision, 'b'.repeat(40));
    const cookie = (await fetch(base + '/api/session', { method: 'POST' })).headers
      .get('set-cookie')!
      .split(';')[0];
    const board = await (
      await fetch(base + '/api/boards', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Synthetic deployment test' }),
      })
    ).json();
    const pages = await (
      await fetch(base + `/api/boards/${board.id}/pages`, { headers: { Cookie: cookie } })
    ).json();
    const ws = new WebSocket(
      base.replace('http', 'ws') + `/sync/${board.id}/${pages.items[0].id}`,
      { headers: { Cookie: cookie } },
    );
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    await sleep(40);
    assert.equal(gate.clients, 1);
    assert.equal(await control('/acquire'), 409);
    assert.equal(
      await control('/acquire-now'),
      200,
      'development override is private and explicit',
    );
    assert.equal(gate.clients, 1, 'acquiring a lease does not discard an existing client');
    assert.equal((await fetch(base + '/api/session', { method: 'POST' })).status, 503);
    assert.equal(await control('/release'), 200);
    ws.close();
    await new Promise<void>((r) => ws.once('close', r));
    assert.equal(await control('/acquire'), 409, 'requires quiet period after disconnect');
    await sleep(40);
    assert.equal(await control('/acquire'), 200);
    assert.equal((await fetch(base + '/api/session', { method: 'POST' })).status, 503);
    const denied = new WebSocket(
      base.replace('http', 'ws') + `/sync/${board.id}/${pages.items[0].id}`,
      { headers: { Cookie: cookie } },
    );
    const status = await new Promise<number>((resolve, reject) => {
      denied.on('unexpected-response', (_req, res) => {
        res.resume();
        resolve(res.statusCode!);
        denied.terminate();
      });
      denied.on('error', () => {});
      denied.on('open', () => reject(new Error('Lease accepted a client')));
    });
    assert.equal(status, 503);
    assert.equal(await control('/release'), 200);
    assert.equal((await fetch(base + '/api/session', { method: 'POST' })).status, 200);
    assert.equal(await control('/acquire'), 200);
    await sleep(180);
    assert.equal(
      (await fetch(base + '/api/session', { method: 'POST' })).status,
      200,
      'crashed deployer cannot leave app paused',
    );
    assert.equal(await control('/unknown', 'GET'), 404);
    assert.equal(
      (await fetch(base + '/api/deploy/acquire', { method: 'POST' })).status,
      404,
      'no public control endpoint',
    );
  } finally {
    await closeControl();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('deployment smoke runs real two-client protocol and cleans its synthetic board', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const dir = await mkdtemp(join(tmpdir(), 'pole-smoke-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<script src="/assets/synthetic.js"></script>');
  await writeFile(join(dir, 'assets', 'synthetic.js'), '// synthetic test asset');
  const app = createApp({
    dbPath: join(dir, 'board.sqlite'),
    staticDir: dir,
    revision: 'a'.repeat(40),
  });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    const { stdout } = await promisify(execFile)(
      'node',
      ['scripts/deploy-smoke.mjs', base, 'a'.repeat(40)],
      { timeout: 30_000 },
    );
    assert.match(stdout, /PASS:/);
    const active = app.store.db
      .prepare('SELECT count(*) AS n FROM boards WHERE deletedAt IS NULL')
      .get() as { n: number };
    assert.equal(active.n, 0);
    const files = app.store.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number };
    assert.equal(files.n, 1);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
