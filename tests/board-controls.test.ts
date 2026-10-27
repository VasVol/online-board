import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { Store } from '../server/database.js';
import { createApp } from '../server/app.js';
import type { BoardEvent } from '../shared/board-controls.js';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error('Timed out waiting for board event');
}

test('schema 1 migration preserves documents, files and access; grid survives reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pole-grid-migration-'));
  const path = join(dir, 'board.sqlite');
  try {
    let store = new Store(path);
    const board = store.createBoard('synthetic-owner', 'Migration');
    const page = store.listPages(board.id, '', 1, 0).items[0];
    const doc = new Y.Doc();
    doc.getMap('elements').set('stroke', { id: 'stroke', version: 1 });
    store.compact(page.id, doc);
    doc.destroy();
    store.putFile(board.id, 'picture', { data: 'synthetic image' });
    // Reconstruct precisely the previous columns on a synthetic database only.
    store.db.exec(
      'ALTER TABLE boards DROP COLUMN gridEnabled; ALTER TABLE boards DROP COLUMN gridRevision; PRAGMA user_version=1;',
    );
    store.close();
    assert.throws(() => new Store(path), /offline backup and explicit migration/);
    const result = await promisify(execFile)(process.execPath, [
      '--import',
      'tsx',
      'scripts/migrate-schema.ts',
      path,
    ]);
    assert.match(result.stdout, /Verified schema 1 backup/);
    const backups = (await readdir(dir)).filter(
      (name) => name.includes('.pre-schema2-') && name.endsWith('.sqlite'),
    );
    assert.equal(backups.length, 1);
    assert.equal((await stat(join(dir, backups[0]))).mode & 0o777, 0o600);
    const backup = new Database(join(dir, backups[0]), { readonly: true });
    assert.equal(backup.pragma('user_version', { simple: true }), 1);
    assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok');
    backup.close();
    store = new Store(path);
    assert.equal(store.db.pragma('user_version', { simple: true }), 2);
    assert.deepEqual(store.grid(board.id), { enabled: false, revision: 0 });
    assert.equal(store.board(board.id)?.owner, board.owner);
    assert.equal(store.board(board.id)?.shareKey, board.shareKey);
    assert.equal(store.listPages(board.id, '', 1, 0).items[0].id, page.id);
    const restored = store.loadDocument(page.id);
    assert.deepEqual(restored.getMap('elements').get('stroke'), { id: 'stroke', version: 1 });
    restored.destroy();
    assert.deepEqual(store.getFile(board.id, 'picture'), { data: 'synthetic image' });
    assert.deepEqual(store.setGrid(board.id, true), { enabled: true, revision: 1 });
    store.close();
    store = new Store(path);
    assert.deepEqual(store.grid(board.id), { enabled: true, revision: 1 });
    assert.equal(store.db.pragma('integrity_check', { simple: true }), 'ok');
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed migration rolls back all column changes and schema version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pole-grid-rollback-'));
  const path = join(dir, 'board.sqlite');
  try {
    const store = new Store(path);
    store.createBoard('owner', 'Keep me');
    store.db.exec('ALTER TABLE boards DROP COLUMN gridEnabled; PRAGMA user_version=1;');
    store.close();
    // The second ALTER fails because gridRevision is already present.
    assert.throws(() => new Store(path, { allowMigration: true }), /duplicate column/);
    const db = new Database(path);
    assert.equal(db.pragma('user_version', { simple: true }), 1);
    assert.equal(
      (db.pragma('table_info(boards)') as { name: string }[]).some(
        (column) => column.name === 'gridEnabled',
      ),
      false,
    );
    assert.equal((db.prepare('SELECT name FROM boards').get() as { name: string }).name, 'Keep me');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('board controls persist before broadcast, gather is owner-only and reaches different pages once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pole-controls-'));
  const app = createApp({ dbPath: join(dir, 'board.sqlite') });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const cookie = (await fetch(base + '/api/session', { method: 'POST' })).headers
    .get('set-cookie')!
    .split(';')[0];
  async function req(path: string, method: string, body?: unknown, key?: string, owner = true) {
    return fetch(base + '/api' + path, {
      method,
      headers: {
        Cookie: owner ? cookie : 'pole_owner=' + 'a'.repeat(43),
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }
  const board = await (await req('/boards', 'POST', { name: 'Controls' })).json();
  const key = app.store.board(board.id)!.shareKey;
  const one = app.store.listPages(board.id, '', 1, 0).items[0];
  const two = app.store.createPage(board.id, 'Two');
  const other = app.store.createBoard('other-owner', 'Unrelated');
  const sockets: WebSocket[] = [];
  async function connect(boardId = board.id, pageId = one.id, access = key) {
    const events: BoardEvent[] = [];
    const ws = new WebSocket(
      base.replace('http', 'ws') + `/sync/${boardId}/${pageId}?key=${access}`,
    );
    sockets.push(ws);
    ws.on('message', (data) => {
      const decoder = decoding.createDecoder(new Uint8Array(data as Buffer));
      if (decoding.readVarUint(decoder) === 5)
        events.push(JSON.parse(decoding.readVarString(decoder)));
    });
    await until(() => events.length > 0);
    return { ws, events };
  }
  try {
    const a = await connect(),
      b = await connect(board.id, two.id);
    const unrelated = await connect(
      other.id,
      app.store.listPages(other.id, '', 1, 0).items[0].id,
      other.shareKey,
    );
    assert.deepEqual(a.events, [{ type: 'grid', enabled: false, revision: 0 }]);
    assert.equal(
      (await req(`/boards/${board.id}/grid`, 'PATCH', { enabled: true }, undefined, false)).status,
      404,
    );
    const response = await req(`/boards/${board.id}/grid`, 'PATCH', { enabled: true }, key, false);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enabled: true, revision: 1 });
    await until(() => a.events.length === 2 && b.events.length === 2);
    assert.deepEqual(a.events[1], { type: 'grid', enabled: true, revision: 1 });
    assert.equal(app.store.grid(board.id).enabled, true);
    assert.equal(unrelated.events.length, 1);
    const snapshot = await connect();
    assert.deepEqual(snapshot.events, [{ type: 'grid', enabled: true, revision: 1 }]);
    const setGrid = app.store.setGrid.bind(app.store);
    app.store.setGrid = () => {
      throw new Error('Synthetic grid storage failure');
    };
    assert.equal((await req(`/boards/${board.id}/grid`, 'PATCH', { enabled: false })).status, 500);
    app.store.setGrid = setGrid;
    await sleep(30);
    assert.equal(a.events.length, 2);
    assert.equal(app.store.grid(board.id).enabled, true);
    const command = {
      pageId: two.id,
      source: randomUUID(),
      viewport: { x: -500, y: 300, zoom: 1.5 },
    };
    assert.equal(
      (await req(`/boards/${board.id}/gather`, 'POST', command, key, false)).status,
      403,
    );
    assert.equal(
      (
        await req(`/boards/${board.id}/gather`, 'POST', {
          ...command,
          pageId: app.store.listPages(other.id, '', 1, 0).items[0].id,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await req(`/boards/${board.id}/gather`, 'POST', {
          ...command,
          viewport: { x: 0, y: 0, zoom: 0 },
        })
      ).status,
      400,
    );
    assert.equal((await req(`/boards/${board.id}/gather`, 'POST', command)).status, 200);
    await until(() => a.events.length === 3 && b.events.length === 3);
    assert.deepEqual(a.events[2], b.events[2]);
    assert.deepEqual(a.events[2], {
      type: 'gather',
      id: (a.events[2] as { id: string }).id,
      ...command,
    });
    assert.equal(unrelated.events.length, 1);
    const fresh = await connect();
    assert.equal(fresh.events.length, 1, 'old gather commands are not replayed');
    // A guest cannot forge server control messages through the Yjs socket.
    const out = encoding.createEncoder();
    encoding.writeVarUint(out, 5);
    encoding.writeVarString(out, JSON.stringify(a.events[2]));
    const closed = new Promise<number>((resolve) =>
      fresh.ws.once('close', (code) => resolve(code)),
    );
    fresh.ws.send(encoding.toUint8Array(out));
    assert.equal(await closed, 4400);
    assert.equal(a.events.length, 3);
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
