// Run only during a planned offline maintenance window, with deployment paused.
// Application startup deliberately refuses to migrate an existing schema 1 DB.
import Database from 'better-sqlite3';
import { chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from '../server/database.js';
const input = process.argv[2];
if (!input)
  throw new Error('Usage: npm run migrate -- /path/to/board.sqlite (stop the application first)');
const path = resolve(input);
const db = new Database(path, { fileMustExist: true, readonly: true });
let backup = '';
try {
  const version = db.pragma('user_version', { simple: true });
  if (version !== 1) throw new Error(`Expected schema 1, found ${version}; database unchanged`);
  backup = `${path}.pre-schema2-${Date.now()}.sqlite`;
  await db.backup(backup);
  await chmod(backup, 0o600);
  const copy = new Database(backup, { readonly: true, fileMustExist: true });
  try {
    if (
      copy.pragma('integrity_check', { simple: true }) !== 'ok' ||
      copy.pragma('user_version', { simple: true }) !== 1
    )
      throw new Error('Backup verification failed; database unchanged');
  } finally {
    copy.close();
  }
} finally {
  db.close();
}
const store = new Store(path, { allowMigration: true });
try {
  if (store.db.pragma('integrity_check', { simple: true }) !== 'ok')
    throw new Error('Migrated database integrity check failed');
  console.log(`Schema 2 ready. Verified schema 1 backup: ${backup}`);
} finally {
  store.close();
}
