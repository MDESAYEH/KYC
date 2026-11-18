import 'reflect-metadata';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
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
import {
  formatBackup,
  parseBackup,
  reconcileNeverSent,
  RECONCILE_CONFIRMATION,
  rollbackRestore,
  ROLLBACK_CONFIRMATION,
} from './staging-reconciliation';

/**
 * CLI: `npm run reconcile:staging [-- options]`
 *
 * DRY RUN BY DEFAULT: only SELECTs on FLEXCUBE and on the local database; prints counts. Nothing
 * is written. Restores E rows that the ORA-01745 incident closed although nothing was sent (see
 * staging-reconciliation.ts for the proof required).
 *
 *   --kyc <KYC_REF_NO>      only this KYC (SELECT and UPDATE)
 *   --all                   every eligible row (explicit; required with --apply when no --kyc)
 *   --codes ORA-01745,...   Oracle codes whose rows may be restored (default ORA-01745)
 *   --max 500               maximum rows examined (default 500)
 *   --apply                 really restore (UPDATE E -> N, one row at a time, re-checked)
 *   --backup-file <path>    required with --apply: every original value is written there first
 *                           (JSON lines, mode 600, the file must not exist; keep it OUT of git)
 *   environment KYC_RECONCILE_CONFIRM=RESTORE_NEVER_SENT_ROWS is also required with --apply
 *
 *   --rollback <backup>     put the rows of a backup back to their original E values (dry run;
 *                           with --apply and KYC_RECONCILE_CONFIRM=ROLLBACK_RESTORED_ROWS), only
 *                           rows still exactly as the restore left them; --kyc narrows it
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
  const onlyKyc = arg('--kyc');
  const all = process.argv.includes('--all');
  const rollbackFile = arg('--rollback');

  const db = createFlexcubeSqlExecutor(config.flexcube);
  if (!db) throw new Error('FLEXCUBE_DB_* is not configured');
  const repo = new StagingSubmissionRepository(
    db,
    config.flexcube.stagingTable,
    config.flexcube.stagingStatusInProgress,
  );

  if (rollbackFile) {
    try {
      const report = await rollbackRestore(repo, parseBackup(readFileSync(rollbackFile, 'utf8')), {
        apply,
        confirmation: process.env.KYC_RECONCILE_CONFIRM,
        onlyKycRefNo: onlyKyc,
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.mode === 'dry-run') {
        console.log(
          `\nDry run: nothing was changed. To roll back, run with --apply and KYC_RECONCILE_CONFIRM=${ROLLBACK_CONFIRMATION}.`,
        );
      }
    } finally {
      if (db instanceof OracleSqlExecutor) await db.onModuleDestroy();
    }
    return;
  }
  if (apply && !backupFile) throw new Error('--apply needs --backup-file <path>');

  // The integration layer's own database, READ-ONLY: proof that no REIS submission was started.
  const options = buildDataSourceOptions(config.database, config.nodeEnv) as DataSourceOptions;
  const local = new DataSource({ ...options, readonly: true } as DataSourceOptions);
  await local.initialize();
  const cases = new TypeOrmKycCaseRepository(local);

  try {
    const report = await reconcileNeverSent(
      {
        repo,
        hasLocalCase: async (ref) => (await cases.findByKycRefNo(ref)) !== null,
        writeBackup: backupFile
          ? async (rows) => {
              const fd = openSync(backupFile, 'wx', 0o600); // fails if it exists
              try {
                writeSync(fd, formatBackup(rows, { since, codes }));
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
        onlyKycRefNo: onlyKyc,
        all,
        apply,
        confirmation: process.env.KYC_RECONCILE_CONFIRM,
      },
    );
    console.log(JSON.stringify(report, null, 2));
    if (report.mode === 'dry-run') {
      console.log(
        `\nDry run: nothing was changed. To restore the ${report.eligible} proven-never-sent rows, review this, then run with ${onlyKyc ? '--kyc <ref>' : '--all'} --apply --backup-file <path> and KYC_RECONCILE_CONFIRM=${RECONCILE_CONFIRMATION}.`,
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
