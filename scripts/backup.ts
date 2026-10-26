import Database from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const source = resolve(process.env.DATA_DIR || 'data', 'board.sqlite');
if (!existsSync(source)) throw new Error(`Database not found: ${source}`);
const target = resolve(
  process.argv[2] ||
    `${process.env.BACKUP_DIR || 'backups'}/pole-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`,
);
if (existsSync(target)) throw new Error('Refusing to overwrite an existing backup');
await mkdir(dirname(target), { recursive: true, mode: 0o700 });
const db = new Database(source, { readonly: true });
try {
  await db.backup(target);
  await chmod(target, 0o600);
  const check = new Database(target, { readonly: true });
  try {
    if (check.pragma('integrity_check', { simple: true }) !== 'ok')
      throw new Error('Backup integrity check failed');
  } finally {
    check.close();
  }
  console.log(`Verified backup: ${target}`);
} finally {
  db.close();
}
