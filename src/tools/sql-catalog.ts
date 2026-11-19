import { FlexcubeKycSource, PendingKyc } from '../flexcube/source/flexcube-kyc-source';
import { IFlexcubeSqlExecutor, SqlBinds, SqlRow } from '../flexcube/staging/flexcube-staging';
import { extractBindNames } from '../flexcube/staging/sql-binds';
import { StagingFlexcubeStatusUpdater } from '../flexcube/staging/staging-flexcube-status-updater';
import {
  StagingBackupRow,
  StagingProcessStatus,
  StagingSubmissionRepository,
} from '../flexcube/staging/staging-submission.repository';
import { ReisFinalStatus } from '../reis/reis-status';
  StagingSubmissionRepository,
} from '../flexcube/staging/staging-submission.repository';
import { ReisFinalStatus } from '../reis/reis-status';
import { SingleKycTrialRepository } from './single-kyc-trial.repository';
import { CustomerTriggerSource, ReadyCustomer } from '../flexcube/source/customer-trigger.source';
 */
export interface CatalogEntry {
  /** Which code path issues it (for the report). */
  name: string;
  sql: string;
  /** Bind names as the code sends them (upper-case, in order of first use). */
  bindNames: string[];
  kind: 'query' | 'execute';
}

class RecordingExecutor implements IFlexcubeSqlExecutor {
  entries: CatalogEntry[] = [];
  current = '';

  private add(sql: string, kind: CatalogEntry['kind']): void {
    if (this.entries.some((e) => e.sql === sql)) return;
    this.entries.push({
      name: this.current,
      sql,
      kind,
      bindNames: extractBindNames(sql).map((n) => n.toUpperCase()),
    });
  }

  async execute(sql: string, _binds: SqlBinds): Promise<{ rowsAffected: number }> {
    this.add(sql, 'execute');
    return { rowsAffected: 1 };
  }

  async query(sql: string, _binds: SqlBinds): Promise<SqlRow[]> {
    this.add(sql, 'query');
    if (sql.includes('ALL_TAB_COLUMNS')) return [{ N: 1 }];
    // detail SELECTs of load() need exactly one row; lists may be empty
    if (/FROM STTM_KYC_(RETAIL|CORPORATE) /.test(sql)) return [{}];
    return [];
  }
}

export interface CatalogOptions {
  stagingTable: string;
  inProgressStatus: string;
  keypersonTypeColumn: string;
}

export async function collectSqlCatalog(opts: CatalogOptions): Promise<CatalogEntry[]> {
  const rec = new RecordingExecutor();
  const step = async (name: string, run: () => Promise<unknown>) => {
    rec.current = name;
  const backupRow: StagingBackupRow = {
    ...key,
    msgId,
    processStatus: StagingProcessStatus.ERROR,
    request: null,
    response: '{"error":"ORA-01745"}',
    retryCount: 1,
    reqDate: null,
    resDate: null,
    reisFinalStatus: null,
  };
  await step('staging.claim', () => repo.claim(key));
  await step('staging.release', () => repo.release(key));
  await step('staging.fail', () => repo.fail(key, { error: 'ORA-00000' }));
  await step('staging.complete', () =>
    repo.complete(key, { status: StagingProcessStatus.SUCCESS, request: {}, response: {} }),
  );
  await step('staging.findStuckInProgress', () => repo.findStuckInProgress(15, 1));
  await step('staging.findDeliveryRisk', () => repo.findDeliveryRisk(5, 1));
  await step('reconcile.findNeverSentTechnicalErrors', () =>
    repo.findNeverSentTechnicalErrors(since, ['ORA-01745'], 1),
  );
  await step('reconcile.restoreNeverSent', () =>
    repo.restoreNeverSent(key, 'ORA-01745', since, msgId, null),
  );
  await step('reconcile.readRowForBackup', () => repo.readRowForBackup(key));
  await step('reconcile.isUntouchedSinceRestore', () => repo.isUntouchedSinceRestore(backupRow));
  await step('reconcile.rollbackRestoredRow', () => repo.rollbackRestoredRow(backupRow));
  return rec.entries;
}
