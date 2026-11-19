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
import { SingleKycTrialRepository } from './single-kyc-trial.repository';
import { CustomerTriggerSource, ReadyCustomer } from '../flexcube/source/customer-trigger.source';

/**
 * The exact SQL text of EVERY statement the integration layer can send to FLEXCUBE, collected by
 * running the real source / repository / updater / single-trial code against a recording executor
 * that never talks to a database (synthetic arguments, no customer data). The `check:oracle-sql`
 * tool hands each statement to Oracle's parser only; tests check the same list against the bind
 * guard and the parse-only guard.
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
    try {
      await run(); // synthetic data may fail mapping: the SQL issued before that is recorded
    } catch {
      /* ignored on purpose */
    }
  };
  const since = '2026-01-01T00:00:00';
  const key = { kycRefNo: 'CATALOG', seqNo: 1 };
  const msgId = '00000000-0000-4000-8000-000000000000';
  const individual: PendingKyc = { ...key, customerType: 'INDIVIDUAL' };
  const corporate: PendingKyc = { ...key, customerType: 'CORPORATE' };
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

  const source = new FlexcubeKycSource(rec, opts.stagingTable, since, opts.keypersonTypeColumn);
  await step('source.findPending, individuals only', () => source.findPending(1));
  await step('source.findOwnStuckNew, individuals only', () => source.findOwnStuckNew(1));
  await step('source.refreshCorporateSupport', () => source.refreshCorporateSupport(0));
  await step('source.findPending', () => source.findPending(1));
  await step('source.findOwnStuckNew', () => source.findOwnStuckNew(1));
  await step('source.load individual', () => source.load(individual));
  await step('source.load corporate', () => source.load(corporate));

  const trigger = new CustomerTriggerSource(rec, opts.stagingTable, since, true);
  const ready: ReadyCustomer = {
    customerNo: 'CATALOG',
    kycRefNo: key.kycRefNo,
    seqNo: 1,
    kycModNo: 1,
    customerType: 'INDIVIDUAL',
    stagingRows: 0,
  };
  await step('trigger.findReady, individuals only', () => trigger.findReady(1));
  await step('trigger.findReady', () => trigger.findReady(1, true));
  await step('trigger.markPicked', () => trigger.markPicked(ready));
  await step('trigger.markError', () => trigger.markError(ready));

  const repo = new StagingSubmissionRepository(rec, opts.stagingTable, opts.inProgressStatus);
  await step('staging.insertNew', () => repo.insertNew(key, msgId));
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

  for (const vocabulary of ['approved-blocked', 'clean-pending-blocked'] as const) {
    const updater = new StagingFlexcubeStatusUpdater(rec, opts.stagingTable, vocabulary);
    await step(`updater.finalStatus (${vocabulary})`, () =>
      updater.updateStatus({
        kycRefNo: key.kycRefNo,
        customerNo: null,
        finalStatus: ReisFinalStatus.CUSTOMER,
        seqNo: key.seqNo,
        idempotencyKey: 'catalog',
      }),
    );
  }

  if (!['N', 'E', 'S'].includes(opts.inProgressStatus)) {
    const trial = new SingleKycTrialRepository(rec, opts.stagingTable, opts.inProgressStatus);
    await step('trial.master', () => trial.master());
    await step('trial.restoreNeverSent', () => trial.restoreNeverSent(backupRow));
    await step('trial.claim', () => trial.claim(msgId));
    await step('trial.markPicked (trigger U -> P)', () => trial.markPicked());
    await step('trial.release', () => trial.release(msgId));
    await step('trial.markTriggerError (trigger P -> E)', () => trial.markTriggerError());
    await step('trial.storeIntent', () => trial.storeIntent(msgId, {}));
    await step('trial.writeWireStatus', () => trial.writeWireStatus('CLEAN', msgId));
    await step('trial.complete', () => trial.complete(msgId, {}, true));
  }
  return rec.entries;
}
