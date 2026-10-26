// Synthetic HTTP + real WebSocket smoke. Never reuse an owner's browser or keys.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const [base, revision] = process.argv.slice(2);
assert.match(base || '', /^(https:\/\/board\.vasilyvolovich\.com|http:\/\/127\.0\.0\.1:\d+)$/);
assert.match(revision || '', /^[a-f0-9]{40}$/);
const deadline = setTimeout(() => {
  console.error('Deployment smoke timed out');
  process.exit(1);
}, 60_000);
let cookie = '',
  board,
  key;
const providers = [];
async function request(path, method = 'GET', body, auth = true) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth && cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.ok, true, `HTTP ${response.status} for smoke endpoint`);
  return response;
}
async function until(predicate) {
  const end = Date.now() + 15_000;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'WebSocket synchronization timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
}
async function client(page) {
  const provider = new WebsocketProvider(
    base.replace(/^http/, 'ws') + `/sync/${board.id}`,
    page.id,
    new Y.Doc(),
    { WebSocketPolyfill: WebSocket, disableBc: true, params: { key } },
  );
  providers.push(provider);
  provider.messageHandlers[4] = () => {}; // Our durable-write barrier is read below.
  await until(() => provider.synced);
  return provider;
}
async function barrier(provider) {
  const sequence = Math.floor(Math.random() * 1_000_000);
  let saved = false;
  const listener = (data) => {
    const d = decoding.createDecoder(new Uint8Array(data));
    if (decoding.readVarUint(d) === 4 && decoding.readVarUint(d) === sequence) saved = true;
  };
  provider.ws.on('message', listener);
  try {
    const out = encoding.createEncoder();
    encoding.writeVarUint(out, 4);
    encoding.writeVarUint(out, sequence);
    provider.ws.send(encoding.toUint8Array(out));
    await until(() => saved);
  } finally {
    provider.ws.off('message', listener);
  }
}
function closeClients() {
  for (const p of providers.splice(0)) {
    p.destroy();
    p.doc.destroy();
  }
}
try {
  const health = await (await request('/api/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.revision, revision);
  assert.equal(health.schema, 1);
  const html = await (await request('/')).text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+\.(?:js|css))"/g)].map(
    (m) => m[1],
  );
  assert.ok(assets.length > 0, 'Built entry assets missing');
  for (const asset of assets)
    assert.ok((await (await request(asset)).arrayBuffer()).byteLength > 0);
  cookie = (await request('/api/session', 'POST')).headers.get('set-cookie').split(';')[0];
  board = await (
    await request('/api/boards', 'POST', { name: 'Deployment smoke — synthetic' })
  ).json();
  key = (await (await request(`/api/boards/${board.id}/share`)).json()).key;
  const page = (await (await request(`/api/boards/${board.id}/pages`)).json()).items[0];
  const a = await client(page),
    b = await client(page);
  const marker = randomUUID();
  a.doc.getMap('elements').set('deploy-a', { id: 'deploy-a', marker });
  b.doc.getMap('elements').set('deploy-b', { id: 'deploy-b', marker });
  await until(() => a.doc.getMap('elements').size === 2 && b.doc.getMap('elements').size === 2);
  await Promise.all([barrier(a), barrier(b)]);
  const file = {
    id: 'deploy-image',
    mimeType: 'image/png',
    dataURL:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=',
    created: Date.now(),
  };
  await request(`/api/boards/${board.id}/files/${file.id}`, 'PUT', file);
  closeClients();
  const fresh = await client(page);
  assert.equal(fresh.doc.getMap('elements').get('deploy-a').marker, marker);
  assert.equal(fresh.doc.getMap('elements').get('deploy-b').marker, marker);
  assert.equal(
    (await (await request(`/api/boards/${board.id}/files/${file.id}`)).json()).dataURL,
    file.dataURL,
  );
  const denied = await fetch(`${base}/api/boards/${board.id}`, {
    headers: { Cookie: 'pole_owner=' + 'a'.repeat(43) },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(denied.status, 404);
  console.log(
    'PASS: exact revision, built assets, two WebSocket clients, SQLite acknowledgements, fresh client, image and access isolation',
  );
} catch (error) {
  // Do not emit stack/call logs containing capability URLs, cookies or headers.
  console.error(
    'Deployment smoke failed:',
    String(error.message).replace(/([?#&]key=)[A-Za-z0-9_-]+/g, '$1<redacted>'),
  );
  process.exitCode = 1;
} finally {
  closeClients();
  if (board) {
    try {
      await request(`/api/boards/${board.id}`, 'DELETE');
    } catch {
      console.error('Synthetic board cleanup failed');
      process.exitCode = 1;
    }
  }
  clearTimeout(deadline);
}
