import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { BackupBundle, ReconciliationRefusedError, verifyBundle } from './staging-reconciliation';

/**
 * The reconciliation backup file: ONE JSON document {manifest, rows} with the full original rows,
 * created with mode 600 and "wx" (never overwrites), flushed to disk, then READ BACK and verified
 * against its own manifest. It holds customer references: keep it out of the repository and on
 * restricted storage. Keep every backup: it is the audit trail of what was changed and by whom.
 */
export function writeBackupFile(path: string, bundle: BackupBundle): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify(bundle, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Verify what is on disk, not what we meant to write.
  const back = readBackupFile(path);
  if (JSON.stringify(back) !== JSON.stringify(bundle)) {
    throw new ReconciliationRefusedError('the backup file read back differs from what was written');
  }
}

/** Reads a backup file and verifies it against its manifest (refuses an edited or damaged file). */
export function readBackupFile(path: string): BackupBundle {
  let bundle: BackupBundle;
  try {
    bundle = JSON.parse(readFileSync(path, 'utf8')) as BackupBundle;
  } catch {
    throw new ReconciliationRefusedError('the backup file cannot be read');
  }
  verifyBundle(bundle);
  return bundle;
}
