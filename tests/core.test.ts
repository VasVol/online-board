import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { Store, hash } from '../server/database.js';
import { SceneBinding, readElements } from '../src/canvas/scene.js';
import { circleBounds } from '../src/canvas/geometry.js';
const shape = (id: string, version = 1, extra = {}) =>
  ({
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    version,
    versionNonce: version,
    isDeleted: false,
    index: `a${id}`,
    ...extra,
  }) as ExcalidrawElement;

test('circle stays circular in all four drag directions', () => {
  for (const end of [
    { x: 30, y: 70 },
    { x: -30, y: 70 },
    { x: 30, y: -70 },
    { x: -30, y: -70 },
  ]) {
    const box = circleBounds({ x: 0, y: 0 }, end);
    assert.equal(box.width, 70);
    assert.equal(box.height, 70);
    assert.equal(box.x, end.x < 0 ? -70 : 0);
    assert.equal(box.y, end.y < 0 ? -70 : 0);
  }
});
test('catalog pagination does not load drawings, pages stay isolated, last page protected', () => {
  const store = new Store(':memory:');
  const owner = hash('owner');
  for (let n = 0; n < 125; n++) store.createBoard(owner, `Board ${n}`);
  assert.equal(store.listBoards(owner, '', 24, 0).items.length, 24);
  assert.equal(store.listBoards(owner, '', 24, 120).items.length, 5);
  assert.equal(store.listBoards(hash('other'), '', 24, 0).total, 0);
  assert.equal(
    (store.db.prepare('SELECT count(*) as n FROM documents').get() as { n: number }).n,
    0,
  );
  const board = store.createBoard(owner, 'Math');
  const first = store.listPages(board.id, '', 50, 0).items[0];
  assert.equal(store.deletePage(first.id), false);
  const next = store.createPage(board.id, 'Next');
  assert.equal(store.deletePage(first.id), true);
  assert.equal(store.page(first.id), undefined);
  assert.equal(store.page(next.id)?.name, 'Next');
  store.close();
});
test('literal search and case-independent SQL inputs stay bounded', () => {
  const s = new Store(':memory:');
  s.createBoard('a', '100% correct');
  s.createBoard('a', '1000 tasks');
  s.createBoard('a', 'Геометрия');
  assert.equal(s.listBoards('a', 'геометрия', 20, 0).total, 1);
  assert.equal(s.listBoards('a', '%', 20, 0).total, 1);
  assert.equal(s.listBoards('a', "' OR 1=1 --", 20, 0).total, 0);
  s.close();
});
test('independent offline edits converge and tombstones survive reconnection', () => {
  const a = new Y.Doc(),
    b = new Y.Doc();
  const sa = new SceneBinding(a, () => {}),
    sb = new SceneBinding(b, () => {});
  sa.publish([shape('a')]);
  sb.publish([shape('b')]);
  const au = Y.encodeStateAsUpdate(a),
    bu = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, bu);
  Y.applyUpdate(b, au);
  assert.deepEqual(readElements(sa.elements), readElements(sb.elements));
  assert.equal(sa.elements.size, 2);
  sa.publish([shape('a', 2, { isDeleted: true }), shape('b')]);
  sb.publish([shape('a'), shape('b', 2, { x: 300 })]);
  const au2 = Y.encodeStateAsUpdate(a),
    bu2 = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, bu2);
  Y.applyUpdate(b, au2);
  assert.deepEqual(readElements(sa.elements), readElements(sb.elements));
  assert.equal(sa.elements.get('a')?.isDeleted, true);
  assert.equal(sa.elements.get('b')?.x, 300);
  sa.destroy();
  sb.destroy();
  a.destroy();
  b.destroy();
});
test('remote moves do not get echoed as local edits and queued stale frames cannot overwrite newer versions', () => {
  const doc = new Y.Doc();
  let rendered: ExcalidrawElement[] = [];
  const bridge = new SceneBinding(doc, (e) => {
    rendered = e;
  });
  bridge.publish([shape('a')]);
  doc.getMap('elements').set('a', shape('a', 8, { x: 500 }));
  let count = 0;
  doc.on('update', () => count++);
  bridge.publish(rendered);
  assert.equal(count, 0);
  bridge.publish([shape('a', 2, { x: 4 })]);
  assert.equal(doc.getMap<ExcalidrawElement>('elements').get('a')?.x, 500);
  bridge.destroy();
  doc.destroy();
});
test('durable update log and transactional compaction recover identical documents', () => {
  const store = new Store(':memory:');
  const board = store.createBoard('a', 'test');
  const page = store.listPages(board.id, '', 1, 0).items[0];
  const doc = new Y.Doc();
  doc.on('update', (u: Uint8Array) => store.appendUpdate(page.id, u));
  doc.getMap('elements').set('x', shape('x'));
  let loaded = store.loadDocument(page.id);
  assert.deepEqual(loaded.getMap('elements').toJSON(), doc.getMap('elements').toJSON());
  store.compact(page.id, doc);
  doc.getMap('elements').set('y', shape('y'));
  loaded.destroy();
  loaded = store.loadDocument(page.id);
  assert.deepEqual(loaded.getMap('elements').toJSON(), doc.getMap('elements').toJSON());
  loaded.destroy();
  doc.destroy();
  store.close();
});
test('a queued frame must not undo a remote winner with equal version and a different nonce', () => {
  const doc = new Y.Doc();
  const old = shape('a', 20, { versionNonce: 100, index: 'a1' });
  doc.getMap('elements').set('a', old);
  const bridge = new SceneBinding(doc, () => {});
  const remote = shape('a', 20, { versionNonce: 200, index: 'a1' });
  doc.getMap('elements').set('a', remote);
  bridge.publish([old]);
  assert.equal(bridge.elements.get('a')?.versionNonce, 200);
  // Index repair may normalize the renderer's copy without creating a user edit.
  const normalized = shape('a', 21, { versionNonce: 300, index: 'a2' });
  bridge.acceptRemote([normalized]);
  bridge.publish([normalized]);
  assert.equal(bridge.elements.get('a')?.versionNonce, 200);
  bridge.publish([shape('a', 22, { versionNonce: 400, index: 'a2', x: 42 })]);
  assert.equal(bridge.elements.get('a')?.x, 42);
  bridge.destroy();
  doc.destroy();
});
