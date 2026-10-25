import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as Y from 'yjs';
import { Store } from '../server/database.js';
const dir = await mkdtemp(join(tmpdir(), 'pole-bench-'));
const store = new Store(join(dir, 'benchmark.sqlite'));
const time = (fn: () => void) => {
  const start = performance.now();
  fn();
  return +(performance.now() - start).toFixed(2);
};
let boardId = '',
  pageId = '';
const catalogSeedMs = time(() =>
  store.db.transaction(() => {
    for (let i = 0; i < 500; i++) {
      const board = store.createBoard('benchmark', `Lesson ${i}`);
      boardId = board.id;
      for (let j = 1; j < 20; j++) store.createPage(board.id, `Page ${j + 1}`);
    }
  })(),
);
const catalog: number[] = [],
  pages: number[] = [];
for (let i = 0; i < 50; i++) {
  catalog.push(
    time(() => {
      store.listBoards('benchmark', '', 24, 0);
    }),
  );
  pages.push(
    time(() => {
      store.listPages(boardId, '', 50, 0);
    }),
  );
}
const doc = new Y.Doc();
const map = doc.getMap('elements');
const populateMs = time(() =>
  doc.transact(() => {
    for (let i = 0; i < 10000; i++)
      map.set(`shape${i}`, {
        id: `shape${i}`,
        type: 'rectangle',
        x: i * 20,
        y: 0,
        width: 15,
        height: 15,
        version: 1,
        versionNonce: i,
        isDeleted: false,
      });
  }),
);
let data: Uint8Array = new Uint8Array();
const encodeMs = time(() => {
  data = Y.encodeStateAsUpdate(doc);
});
pageId = store.listPages(boardId, '', 1, 0).items[0].id;
const persistMs = time(() => store.appendUpdate(pageId, data));
let loaded: Y.Doc | undefined;
const loadMs = time(() => {
  loaded = store.loadDocument(pageId);
  loaded.getMap('elements');
});
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(
  JSON.stringify(
    {
      date: new Date().toISOString(),
      node: process.version,
      cpu: cpus()[0]?.model,
      boards: 500,
      pages: 10000,
      activeDocumentShapes: 10000,
      catalogSeedMs,
      catalogMedianMs: median(catalog),
      pageListMedianMs: median(pages),
      populateMs,
      encodeMs,
      documentBytes: data.byteLength,
      persistMs,
      loadMs,
      notes:
        'Synthetic metadata / CRDT / SQLite benchmark. Catalog seeding uses one transaction. Does not measure browser rendering, internet latency, or concurrent classroom capacity.',
    },
    null,
    2,
  ),
);
loaded?.destroy();
doc.destroy();
store.close();
await rm(dir, { recursive: true, force: true });
