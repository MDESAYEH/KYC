import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';

/**
 * Consistent online backup of the integration layer's local SQLite database.
 *
 * Copying the database file while the service runs is NOT safe: committed transactions may still be
 * in the -wal file (WAL mode) or a write may be half done, so the copy can silently lose data. This
 * uses SQLite's own online backup API (through better-sqlite3), which yields a consistent snapshot
 * while the database stays in use, then verifies the snapshot (integrity_check, table count) and
 * reports its SHA-256. The source is opened read-only; the destination must not exist.
 */
export interface SqliteBackupResult {
  bytes: number;
  sha256: string;
  tables: number;
  integrity: string;
}

export async function backupSqlite(
  source: string,
  destination: string,
): Promise<SqliteBackupResult> {
  if (!existsSync(source)) throw new Error('The SQLite source file does not exist');
  if (existsSync(destination))
    throw new Error('The backup destination already exists (never overwritten)');
  const src = new Database(source, { readonly: true, fileMustExist: true });
  try {
    // Reserve the path exclusively and restrict access BEFORE SQLite writes customer data.
    // The destination directory must also be restricted (Windows uses its inherited ACL).
    closeSync(openSync(destination, 'wx', 0o600));
    await src.backup(destination);
  } finally {
    src.close();
  }
  const copy = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(copy.pragma('integrity_check', { simple: true }));
    const tables = Number(
      (
        copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as {
          n: number;
        }
      ).n,
    );
    if (integrity !== 'ok') throw new Error('The backup failed the SQLite integrity check');
    return {
      bytes: statSync(destination).size,
      sha256: createHash('sha256').update(readFileSync(destination)).digest('hex'),
      tables,
      integrity,
    };
  } finally {
    copy.close();
  }
}
