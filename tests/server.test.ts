import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { createApp } from '../server/app.js';
import type { Board, PageList, Page } from '../shared/types.js';

async function until(fn: () => boolean, timeout = 6000) {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'pole-test-'));
  const path = join(dir, 'board.sqlite');
  let app = createApp({ dbPath: path });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  let base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const auth = await fetch(`${base}/api/session`, { method: 'POST' });
  const cookie = auth.headers.get('set-cookie')!.split(';')[0];
  async function req<T>(path: string, method = 'GET', body?: unknown, key?: string, owner = true) {
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        Cookie: owner ? cookie : 'pole_owner=' + 'a'.repeat(43),
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: (await r.json()) as T };
  }
  const board = (await req<Board>('/boards', 'POST', { name: 'Математика' })).body;
  const key = (await req<{ key: string }>(`/boards/${board.id}/share`)).body.key;
  const page = (await req<PageList<Page>>(`/boards/${board.id}/pages`)).body.items[0];
  const clients: WebsocketProvider[] = [];
  function client(pageId = page.id, access = key) {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(
      base.replace('http', 'ws') + `/sync/${board.id}`,
      pageId,
      doc,
      {
        WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
        disableBc: true,
        params: { key: access },
      },
    );
    clients.push(provider);
    return provider;
  }
  return {
    get app() {
      return app;
    },
    base,
    req,
    board,
    key,
    page,
    client,
    path,
    async restart() {
      for (const c of clients) {
        c.destroy();
        c.doc.destroy();
      }
      clients.length = 0;
      await app.close();
      app = createApp({ dbPath: path });
      await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    },
    async close() {
      for (const c of clients) {
        c.destroy();
        c.doc.destroy();
      }
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('HTTP capabilities: private catalog, guest editing, owner-only deletion, revocation and page isolation', async () => {
  const s = await setup();
  try {
    assert.equal(
      (await s.req<PageList<Board>>('/boards', 'GET', undefined, undefined, false)).body.total,
      0,
    );
    assert.equal(
      (await s.req(`/boards/${s.board.id}`, 'GET', undefined, undefined, false)).status,
      404,
    );
    const guest = await s.req<{ board: Record<string, unknown> }>(
      `/boards/${s.board.id}`,
      'GET',
      undefined,
      s.key,
      false,
    );
    assert.equal(guest.status, 200);
    assert.equal(guest.body.board.owner, undefined);
    assert.equal(guest.body.board.shareKey, undefined);
    assert.equal(
      (await s.req(`/boards/${s.board.id}`, 'PATCH', { name: 'Урок' }, s.key, false)).status,
      200,
    );
    assert.equal(
      (await s.req(`/boards/${s.board.id}`, 'DELETE', undefined, s.key, false)).status,
      403,
    );
    assert.equal((await s.req(`/boards/${s.board.id}/pages/${s.page.id}`, 'DELETE')).status, 409);
    const other = (await s.req<Board>('/boards', 'POST', { name: 'Private' })).body;
    assert.equal((await s.req(`/boards/${other.id}/pages/${s.page.id}`)).status, 404);
    assert.equal((await s.req('/boards?limit=1000000')).status, 400);
    assert.equal((await s.req('/boards', 'POST', { name: ' '.repeat(10) })).status, 400);
    await s.req(`/boards/${s.board.id}/share`, 'POST');
    assert.equal(
      (await s.req(`/boards/${s.board.id}`, 'GET', undefined, s.key, false)).status,
      404,
    );
  } finally {
    await s.close();
  }
});

test('two WebSocket clients, durable acknowledgements, offline merge, presence and restart', async () => {
  const s = await setup();
  try {
    const a = s.client(),
      b = s.client();
    await until(() => a.synced && b.synced);
    a.doc.getMap('elements').set('alice', { id: 'alice', x: 1 });
    b.doc.getMap('elements').set('bob', { id: 'bob', x: 2 });
    await until(() => a.doc.getMap('elements').size === 2 && b.doc.getMap('elements').size === 2);
    let ack = 0;
    a.messageHandlers[4] = (_e, d) => {
      ack = decoding.readVarUint(d);
    };
    const out = encoding.createEncoder();
    encoding.writeVarUint(out, 4);
    encoding.writeVarUint(out, 123);
    a.ws!.send(encoding.toUint8Array(out));
    await until(() => ack === 123);
    const persisted = s.app.store.loadDocument(s.page.id);
    assert.equal(persisted.getMap('elements').size, 2);
    persisted.destroy();
    a.awareness.setLocalStateField('name', 'Аня');
    await until(() => [...b.awareness.getStates().values()].some((x) => x.name === 'Аня'));
    b.disconnect();
    await until(() => !b.wsconnected);
    b.doc.getMap('elements').set('offline', { id: 'offline', x: 9 });
    a.doc.getMap('elements').set('online', { id: 'online', x: 8 });
    b.connect();
    await until(() => a.doc.getMap('elements').size === 4 && b.doc.getMap('elements').size === 4);
    assert.deepEqual(a.doc.getMap('elements').toJSON(), b.doc.getMap('elements').toJSON());
    const page2 = (await s.req<Page>(`/boards/${s.board.id}/pages`, 'POST', { name: 'Other' }))
      .body;
    const c = s.client(page2.id);
    await until(() => c.synced);
    assert.equal(c.doc.getMap('elements').size, 0);
    await s.restart();
    const restored = s.client();
    await until(() => restored.synced);
    assert.equal(restored.doc.getMap('elements').size, 4);
  } finally {
    await s.close();
  }
});

test('revocation closes active sockets and invalid links cannot open rooms', async () => {
  const s = await setup();
  try {
    const wrong = s.client(s.page.id, 'bad');
    let code = 0;
    wrong.on('connection-close', (event: CloseEvent | null) => {
      code = event?.code || 0;
    });
    await until(() => code === 4403);
    assert.equal(s.app.sync.rooms.size, 0);
    const good = s.client();
    await until(() => good.synced);
    let revoked = 0;
    good.on('connection-close', (event: CloseEvent | null) => {
      revoked = event?.code || 0;
    });
    await s.req(`/boards/${s.board.id}/share`, 'POST');
    await until(() => revoked === 4403);
    await until(() => s.app.sync.rooms.size === 0, 5000);
  } finally {
    await s.close();
  }
});

test('cross-origin writes and socket upgrades are denied; files use board permissions', async () => {
  const s = await setup();
  try {
    const response = await fetch(`${s.base}/api/boards`, {
      method: 'POST',
      headers: { Origin: 'https://evil.invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'csrf' }),
    });
    assert.equal(response.status, 403);
    const file = {
      id: 'example',
      mimeType: 'image/png',
      dataURL: 'data:image/png;base64,aGVsbG8=',
      created: 1,
    };
    assert.equal(
      (await s.req(`/boards/${s.board.id}/files/example`, 'PUT', file, s.key, false)).status,
      200,
    );
    assert.equal(
      (await s.req(`/boards/${s.board.id}/files/example`, 'GET', undefined, undefined, false))
        .status,
      404,
    );
    assert.deepEqual(
      (await s.req(`/boards/${s.board.id}/files/example`, 'GET', undefined, s.key, false)).body,
      file,
    );
    assert.equal(
      (
        await s.req(`/boards/${s.board.id}/files/bad`, 'PUT', {
          ...file,
          id: 'bad',
          mimeType: 'text/html',
        })
      ).status,
      400,
    );
  } finally {
    await s.close();
  }
});

test('storage failure is never acknowledged or compacted into a successful snapshot', async () => {
  const s = await setup();
  try {
    const a = s.client();
    await until(() => a.synced);
    a.shouldReconnect = () => false;
    const original = s.app.store.appendUpdate.bind(s.app.store);
    s.app.store.appendUpdate = () => {
      throw new Error('Simulated disk failure');
    };
    let closeCode = 0;
    a.on('connection-close', (event) => {
      closeCode = event?.code || 0;
    });
    a.doc.getMap('elements').set('unsaved', { x: 1 });
    await until(() => closeCode === 1011);
    s.app.store.appendUpdate = original;
    await until(() => s.app.sync.rooms.size === 0);
    const stored = s.app.store.loadDocument(s.page.id);
    assert.equal(stored.getMap('elements').has('unsaved'), false);
    stored.destroy();
  } finally {
    await s.close();
  }
});

test('acknowledged data survives SIGKILL of a separate test server process', async () => {
  const { fork } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'pole-crash-'));
  const dbPath = join(dir, 'db.sqlite');
  const child = fork('tests/fixtures/crash-server.ts', {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, TEST_DB: dbPath },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  let client: WebsocketProvider | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.once('message', (data) => resolve((data as { port: number }).port));
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Server exited: ${code}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    const session = await fetch(base + '/api/session', { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(base + '/api/boards', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Crash fixture' }),
    });
    const board = (await response.json()) as Board;
    const key = (
      (await (
        await fetch(`${base}/api/boards/${board.id}/share`, { headers: { Cookie: cookie } })
      ).json()) as { key: string }
    ).key;
    const page = (
      (await (
        await fetch(`${base}/api/boards/${board.id}/pages`, { headers: { Cookie: cookie } })
      ).json()) as PageList<Page>
    ).items[0];
    client = new WebsocketProvider(
      `ws://127.0.0.1:${port}/sync/${board.id}`,
      page.id,
      new Y.Doc(),
      {
        WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
        disableBc: true,
        params: { key },
        shouldReconnect: () => false,
      },
    );
    await until(() => client!.synced);
    client.doc.getMap('elements').set('durable', { x: 42 });
    let ack = false;
    client.messageHandlers[4] = () => {
      ack = true;
    };
    const out = encoding.createEncoder();
    encoding.writeVarUint(out, 4);
    encoding.writeVarUint(out, 7);
    client.ws!.send(encoding.toUint8Array(out));
    await until(() => ack);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    const { Store } = await import('../server/database.js');
    const store = new Store(dbPath);
    try {
      const doc = store.loadDocument(page.id);
      assert.deepEqual(doc.getMap('elements').get('durable'), { x: 42 });
      doc.destroy();
    } finally {
      store.close();
    }
  } finally {
    client?.destroy();
    client?.doc.destroy();
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
