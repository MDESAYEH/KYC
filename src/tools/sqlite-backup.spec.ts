import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { backupSqlite } from './sqlite-backup';

describe('SQLite online backup (consistent while the service is running)', () => {
  let dir: string;
  let live: Database.Database;
  const file = (name: string) => join(dir, name);
  const rows = (path: string) => {
    const db = new Database(path, { readonly: true });
    try {
      return (db.prepare('SELECT COUNT(*) AS n FROM kyc_case').get() as { n: number }).n;
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kyc-sqlite-'));
    live = new Database(file('live.sqlite'));
    live.pragma('journal_mode = WAL');
    live.pragma('wal_autocheckpoint = 0'); // committed data stays in the -wal file
    live.exec('CREATE TABLE kyc_case (id INTEGER PRIMARY KEY, ref TEXT)');
    live.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // the empty table is in the main file
    const ins = live.prepare('INSERT INTO kyc_case (ref) VALUES (?)');
    for (let i = 0; i < 50; i++) ins.run(`r${i}`);
  });
  afterEach(() => {
    live.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a plain copy of the open database file LOSES the committed rows still in the WAL', () => {
    copyFileSync(file('live.sqlite'), file('plain-copy.sqlite'));
    expect(rows(file('plain-copy.sqlite'))).toBe(0); // the 50 committed rows are not in the copy
    expect(rows(file('live.sqlite'))).toBe(50);
  });

  it('the online backup contains every committed row while the database stays open', async () => {
    const result = await backupSqlite(file('live.sqlite'), file('backup.sqlite'));
    expect(rows(file('backup.sqlite'))).toBe(50);
    expect(result).toMatchObject({ integrity: 'ok', tables: 1 });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.bytes).toBeGreaterThan(0);
    if (process.platform !== 'win32')
      expect(statSync(file('backup.sqlite')).mode & 0o777).toBe(0o600);
    // the live database keeps working and can be backed up again
    live.prepare('INSERT INTO kyc_case (ref) VALUES (?)').run('more');
    await backupSqlite(file('live.sqlite'), file('backup2.sqlite'));
    expect(rows(file('backup2.sqlite'))).toBe(51);
  });

  it('never overwrites a backup and refuses a missing source', async () => {
    await backupSqlite(file('live.sqlite'), file('b.sqlite'));
    await expect(backupSqlite(file('live.sqlite'), file('b.sqlite'))).rejects.toThrow(
      'already exists',
    );
    await expect(backupSqlite(file('nope.sqlite'), file('c.sqlite'))).rejects.toThrow(
      'does not exist',
    );
    expect(existsSync(file('c.sqlite'))).toBe(false);
  });

  it('a restored backup is a working database (restore test in an isolated folder)', async () => {
    await backupSqlite(file('live.sqlite'), file('backup.sqlite'));
    copyFileSync(file('backup.sqlite'), file('restored.sqlite')); // what the rollback does, after stopping the service
    const restored = new Database(file('restored.sqlite'));
    try {
      expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(
        (restored.prepare('SELECT COUNT(*) AS n FROM kyc_case').get() as { n: number }).n,
      ).toBe(50);
      restored.prepare('INSERT INTO kyc_case (ref) VALUES (?)').run('after-restore');
    } finally {
      restored.close();
    }
  });
});
