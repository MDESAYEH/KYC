import 'reflect-metadata';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { DataSource, DataSourceOptions } from 'typeorm';
import { loadConfiguration } from '../config/configuration';
import { loadEnvFile } from '../config/load-env-file';
import { oraCode } from '../flexcube/oracle-error';
import { normalizeSyncStartDate } from '../flexcube/source/flexcube-kyc-source';
import { createFlexcubeSqlExecutor } from '../flexcube/staging/flexcube-status-updater.factory';
import { OracleSqlExecutor } from '../flexcube/staging/oracle-sql-executor';
import { StagingSubmissionRepository } from '../flexcube/staging/staging-submission.repository';
import { buildDataSourceOptions } from '../persistence/database.config';
import { readBackupFile, writeBackupFile } from './staging-backup-file';
import {
  Attestation,
  planReconciliation,
  RECONCILE_CONFIRMATION,
  reconcileNeverSent,
  ROLLBACK_CONFIRMATION,
  rollbackReconciliation,
} from './staging-reconciliation';
import { SqliteLocalEvidence } from './sqlite-local-evidence';

/**
 * CLI: `npm run reconcile:staging [-- options]`   (see docs/flexcube-sync.md)
 *
 * DRY RUN BY DEFAULT: SELECTs only (FLEXCUBE and the local database, opened read-only); prints counts,
 * evidence and the hash of the eligible list. Nothing is written.
 *
 *   --codes ORA-01745,...       Oracle codes whose rows may be restored (default ORA-01745)
 *   --max 500                   maximum rows examined (default 500)
 *   --export-candidates <file>  writes the eligible KYC_REF_NO,SEQ_NO list (mode 600, must not exist)
 *                               so people can check REIS for those systemIds; prints its hash
 *   --attestation <file>        the signed-off JSON a person writes after checking REIS (see docs)
 *   --apply                     restore (E -> N, one conditional UPDATE per row). Also needs
 *                               --backup-file <path> (full rows + manifest, verified first) and
 *                               KYC_RECONCILE_CONFIRM=RESTORE_NEVER_SENT_ROWS
 *   --rollback <backup file>    dry run of the rollback of an earlier reconciliation; with --apply and
 *                               KYC_ROLLBACK_CONFIRM=ROLLBACK_RECONCILIATION it restores the saved values
 *                               for the rows still in the post-restore state
 *
 * It never enables polling and never calls REIS.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function writeNewFile(path: string, content: string): void {
  const fd = openSync(path, 'wx', 0o600); // never overwrites
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfiguration();
  const apply = process.argv.includes('--apply');
  const db = createFlexcubeSqlExecutor(config.flexcube);
  if (!db) throw new Error('FLEXCUBE_DB_* is not configured');
  const repo = new StagingSubmissionRepository(
    db,
    config.flexcube.stagingTable,
    config.flexcube.stagingStatusInProgress,
  );
  // The integration layer's own database, READ-ONLY.
  const options = buildDataSourceOptions(config.database, config.nodeEnv) as DataSourceOptions;
  const local = new DataSource({ ...options, readonly: true } as DataSourceOptions);
  await local.initialize();

  try {
    const rollbackFile = arg('--rollback');
    if (rollbackFile) {
      const report = await rollbackReconciliation({ repo }, readBackupFile(rollbackFile), {
        apply,
        confirmation: process.env.KYC_ROLLBACK_CONFIRM,
      });
      console.log(JSON.stringify(report, null, 2));
      if (!apply)
        console.log(
          `\nDry run: nothing was changed. To roll back, add --apply with KYC_ROLLBACK_CONFIRM=${ROLLBACK_CONFIRMATION}.`,
        );
      return;
    }

    const since = normalizeSyncStartDate(config.flexcube.syncStartDate);
    if (since === undefined) throw new Error('FLEXCUBE_SYNC_START_DATE is missing or invalid');
    const attestationFile = arg('--attestation');
    const attestation = attestationFile
      ? (JSON.parse(readFileSync(attestationFile, 'utf8')) as Attestation)
      : undefined;
    const backupFile = arg('--backup-file');
    if (apply && !backupFile) throw new Error('--apply needs --backup-file <path>');
    const deps = {
      repo,
      local: new SqliteLocalEvidence(local),
      writeBackup: backupFile
        ? async (b: Parameters<typeof writeBackupFile>[1]) => writeBackupFile(backupFile, b)
        : undefined,
    };
    const opts = {
      since,
      errorCodes: (arg('--codes') ?? 'ORA-01745').split(',').map((c) => c.trim()),
      maxRows: Number(arg('--max') ?? 500),
      apply,
      confirmation: process.env.KYC_RECONCILE_CONFIRM,
      attestation,
    };

    const exportFile = arg('--export-candidates');
    if (exportFile) {
      const { eligible } = await planReconciliation(deps, opts);
      writeNewFile(
        exportFile,
        'KYC_REF_NO,SEQ_NO\n' + eligible.map((k) => `${k.kycRefNo},${k.seqNo}`).join('\n') + '\n',
      );
    }
    const report = await reconcileNeverSent(deps, opts);
    console.log(JSON.stringify(report, null, 2));
    if (report.mode === 'dry-run') {
      console.log(
        `\nDry run: nothing was changed. Eligible list hash ${report.eligibleListSha256}. ` +
          `After REIS was checked, a person writes the attestation for exactly this hash; then add --apply --backup-file <path> ` +
          `--attestation <file> and KYC_RECONCILE_CONFIRM=${RECONCILE_CONFIRMATION}.`,
      );
    }
  } finally {
    if (db instanceof OracleSqlExecutor) await db.onModuleDestroy();
    await local.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(oraCode(err), err instanceof Error && err.name !== 'Error' ? `(${err.name})` : '');
  process.exit(1);
});
