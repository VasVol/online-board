import Database from 'better-sqlite3';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as Y from 'yjs';
import type { Board, Page } from '../shared/types.js';

export const secret = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export type StoredBoard = Board & { owner: string; shareKey: string };
export class Store {
  db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.function('fold', { deterministic: true }, (value: unknown) =>
      String(value).normalize('NFKC').toLocaleLowerCase('ru-RU'),
    );
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 1) throw new Error('Database schema is newer than this application');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL,
        shareKey TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, deletedAt INTEGER);
      CREATE INDEX IF NOT EXISTS boards_owner ON boards(owner, deletedAt, updatedAt DESC);
      CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, boardId TEXT NOT NULL REFERENCES boards(id),
        name TEXT NOT NULL, position INTEGER NOT NULL, createdAt INTEGER NOT NULL, deletedAt INTEGER);
      CREATE INDEX IF NOT EXISTS pages_board ON pages(boardId, deletedAt, position);
      CREATE TABLE IF NOT EXISTS documents (pageId TEXT PRIMARY KEY REFERENCES pages(id), snapshot BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, pageId TEXT NOT NULL REFERENCES pages(id), data BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS updates_page ON updates(pageId);
      CREATE TABLE IF NOT EXISTS files (boardId TEXT NOT NULL REFERENCES boards(id), id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(boardId, id));
      PRAGMA user_version = 1;
    `);
  }
  createBoard(owner: string, name: string) {
    return this.db.transaction(() => {
      const board: StoredBoard = {
        id: randomBytes(12).toString('base64url'),
        name,
        owner,
        shareKey: secret(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.db
        .prepare(
          'INSERT INTO boards (id,name,owner,shareKey,createdAt,updatedAt) VALUES (@id,@name,@owner,@shareKey,@createdAt,@updatedAt)',
        )
        .run(board);
      this.createPage(board.id, 'Страница 1');
      return board;
    })();
  }
  board(id: string) {
    return this.db.prepare('SELECT * FROM boards WHERE id=? AND deletedAt IS NULL').get(id) as
      StoredBoard | undefined;
  }
  page(id: string) {
    return this.db
      .prepare(
        'SELECT id,boardId,name,position,createdAt FROM pages WHERE id=? AND deletedAt IS NULL',
      )
      .get(id) as Page | undefined;
  }
  listBoards(owner: string, q: string, limit: number, offset: number) {
    const args = [owner, `%${q.replace(/[\\%_]/g, '\\$&')}%`];
    const condition = "owner=? AND deletedAt IS NULL AND fold(name) LIKE fold(?) ESCAPE '\\'";
    const total = (
      this.db.prepare(`SELECT count(*) AS n FROM boards WHERE ${condition}`).get(...args) as {
        n: number;
      }
    ).n;
    const items = this.db
      .prepare(
        `SELECT id,name,createdAt,updatedAt,(SELECT count(*) FROM pages WHERE boardId=boards.id AND deletedAt IS NULL) AS pageCount FROM boards WHERE ${condition} ORDER BY updatedAt DESC,id LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as Board[];
    return { items, total, limit, offset };
  }
  listPages(boardId: string, q: string, limit: number, offset: number) {
    const args = [boardId, `%${q.replace(/[\\%_]/g, '\\$&')}%`];
    const condition = "boardId=? AND deletedAt IS NULL AND fold(name) LIKE fold(?) ESCAPE '\\'";
    const total = (
      this.db.prepare(`SELECT count(*) AS n FROM pages WHERE ${condition}`).get(...args) as {
        n: number;
      }
    ).n;
    const items = this.db
      .prepare(
        `SELECT id,boardId,name,position,createdAt FROM pages WHERE ${condition} ORDER BY position,id LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as Page[];
    return { items, total, limit, offset };
  }
  createPage(boardId: string, name: string): Page {
    return this.db.transaction(() => {
      const position = (
        this.db
          .prepare('SELECT coalesce(max(position),-1)+1 AS n FROM pages WHERE boardId=?')
          .get(boardId) as { n: number }
      ).n;
      const page = {
        id: randomBytes(12).toString('base64url'),
        boardId,
        name,
        position,
        createdAt: Date.now(),
      };
      this.db
        .prepare(
          'INSERT INTO pages(id,boardId,name,position,createdAt) VALUES (@id,@boardId,@name,@position,@createdAt)',
        )
        .run(page);
      this.touch(boardId);
      return page;
    })();
  }
  touch(boardId: string) {
    this.db.prepare('UPDATE boards SET updatedAt=? WHERE id=?').run(Date.now(), boardId);
  }
  renameBoard(id: string, name: string) {
    this.db.prepare('UPDATE boards SET name=?,updatedAt=? WHERE id=?').run(name, Date.now(), id);
  }
  renamePage(id: string, name: string) {
    this.db.prepare('UPDATE pages SET name=? WHERE id=?').run(name, id);
  }
  deletePage(id: string) {
    return this.db.transaction(() => {
      const page = this.page(id);
      if (!page) return false;
      if (this.listPages(page.boardId, '', 1, 0).total <= 1) return false;
      this.db.prepare('UPDATE pages SET deletedAt=? WHERE id=?').run(Date.now(), id);
      return true;
    })();
  }
  deleteBoard(id: string) {
    this.db.prepare('UPDATE boards SET deletedAt=? WHERE id=?').run(Date.now(), id);
  }
  rotateKey(id: string) {
    const key = secret();
    this.db.prepare('UPDATE boards SET shareKey=? WHERE id=?').run(key, id);
    return key;
  }
  loadDocument(pageId: string): Y.Doc {
    const doc = new Y.Doc();
    const row = this.db.prepare('SELECT snapshot FROM documents WHERE pageId=?').get(pageId) as
      { snapshot: Buffer } | undefined;
    if (row) Y.applyUpdate(doc, row.snapshot);
    for (const update of this.db
      .prepare('SELECT data FROM updates WHERE pageId=? ORDER BY id')
      .iterate(pageId) as Iterable<{ data: Buffer }>)
      Y.applyUpdate(doc, update.data);
    return doc;
  }
  appendUpdate(pageId: string, data: Uint8Array) {
    this.db.prepare('INSERT INTO updates(pageId,data) VALUES (?,?)').run(pageId, Buffer.from(data));
  }
  compact(pageId: string, doc: Y.Doc) {
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO documents(pageId,snapshot) VALUES (?,?) ON CONFLICT(pageId) DO UPDATE SET snapshot=excluded.snapshot',
        )
        .run(pageId, Buffer.from(Y.encodeStateAsUpdate(doc)));
      this.db.prepare('DELETE FROM updates WHERE pageId=?').run(pageId);
    })();
  }
  putFile(boardId: string, id: string, data: unknown) {
    this.db
      .prepare('INSERT OR IGNORE INTO files(boardId,id,data) VALUES (?,?,?)')
      .run(boardId, id, JSON.stringify(data));
  }
  getFile(boardId: string, id: string) {
    const row = this.db
      .prepare('SELECT data FROM files WHERE boardId=? AND id=?')
      .get(boardId, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  close() {
    this.db.close();
  }
}
