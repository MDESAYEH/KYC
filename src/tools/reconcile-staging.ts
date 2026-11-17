import 'reflect-metadata';
import { closeSync, openSync, writeSync } from 'node:fs';
import { DataSource, DataSourceOptions } from 'typeorm';
import { loadConfiguration } from '../config/configuration';
import { loadEnvFile } from '../config/load-env-file';
import { normalizeSyncStartDate } from '../flexcube/source/flexcube-kyc-source';
import { createFlexcubeSqlExecutor } from '../flexcube/staging/flexcube-status-updater.factory';
import { OracleSqlExecutor } from '../flexcube/staging/oracle-sql-executor';
import { StagingSubmissionRepository } from '../flexcube/staging/staging-submission.repository';
import { buildDataSourceOptions } from '../persistence/database.config';
import { TypeOrmKycCaseRepository } from '../persistence/typeorm-kyc-case.repository';
import { oraCode } from '../flexcube/oracle-error';
import { reconcileNeverSent, RECONCILE_CONFIRMATION } from './staging-reconciliation';

/**
 * CLI: `npm run reconcile:staging [-- options]`
 *
 * DRY RUN BY DEFAULT: only SELECTs on FLEXCUBE and on the local database; prints counts. Nothing
 * is written. Restores E rows that the ORA-01745 incident closed although nothing was sent (see
 * staging-reconciliation.ts for the proof required).
 *
 *   --codes ORA-01745,...   Oracle codes whose rows may be restored (default ORA-01745)
 *   --max 500               maximum rows examined (default 500)
 *   --apply                 really restore (UPDATE E -> N, one row at a time)
 *   --backup-file <path>    required with --apply: the rows are written there first (mode 600,
 *                           the file must not exist; keep it OUT of the repository)
 *   environment KYC_RECONCILE_CONFIRM=RESTORE_NEVER_SENT_ROWS is also required with --apply
 *
 * It never re-enables polling and never calls REIS. The local database is opened read-only.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfiguration();
  const apply = process.argv.includes('--apply');
  const since = normalizeSyncStartDate(config.flexcube.syncStartDate);
  if (since === undefined) throw new Error('FLEXCUBE_SYNC_START_DATE is missing or invalid');
  const codes = (arg('--codes') ?? 'ORA-01745').split(',').map((c) => c.trim());
  const maxRows = Number(arg('--max') ?? 500);
  const backupFile = arg('--backup-file');
  if (apply && !backupFile) throw new Error('--apply needs --backup-file <path>');

  const db = createFlexcubeSqlExecutor(config.flexcube);
  if (!db) throw new Error('FLEXCUBE_DB_* is not configured');

  // The integration layer's own database, READ-ONLY: proof that no REIS submission was started.
  const options = buildDataSourceOptions(config.database, config.nodeEnv) as DataSourceOptions;
  const local = new DataSource({ ...options, readonly: true } as DataSourceOptions);
  await local.initialize();
  const cases = new TypeOrmKycCaseRepository(local);

  try {
    const report = await reconcileNeverSent(
      {
        repo: new StagingSubmissionRepository(
          db,
          config.flexcube.stagingTable,
          config.flexcube.stagingStatusInProgress,
        ),
        hasLocalCase: async (ref) => (await cases.findByKycRefNo(ref)) !== null,
        writeBackup: backupFile
          ? async (rows) => {
              const fd = openSync(backupFile, 'wx', 0o600); // fails if it exists
              try {
                writeSync(fd, 'KYC_REF_NO,SEQ_NO\n');
                for (const r of rows) writeSync(fd, `${r.kycRefNo},${r.seqNo}\n`);
              } finally {
                closeSync(fd);
              }
            }
          : undefined,
      },
      {
        since,
        errorCodes: codes,
        maxRows,
        apply,
        confirmation: process.env.KYC_RECONCILE_CONFIRM,
      },
    );
    console.log(JSON.stringify(report, null, 2));
    if (report.mode === 'dry-run') {
      console.log(
        `\nDry run: nothing was changed. To restore the ${report.eligible} proven-never-sent rows, review this, then run with --apply --backup-file <path> and KYC_RECONCILE_CONFIRM=${RECONCILE_CONFIRMATION}.`,
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
