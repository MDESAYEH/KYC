import { CustomerTriggerSource, TriggerWork } from '../flexcube/source/customer-trigger.source';
import { FlexcubeKycSource } from '../flexcube/source/flexcube-kyc-source';
import { IFlexcubeSqlExecutor, SqlBinds, SqlRow } from '../flexcube/staging/flexcube-staging';
import { extractBindNames } from '../flexcube/staging/sql-binds';
import { StagingFlexcubeStatusUpdater } from '../flexcube/staging/staging-flexcube-status-updater';
import {
  StagingProcessStatus,
  StagingSubmissionRepository,
} from '../flexcube/staging/staging-submission.repository';
import { ReisFinalStatus } from '../reis/reis-status';

/**
 * The exact SQL text of EVERY statement the integration layer can send to FLEXCUBE, collected by
 * running the real source / repository / updater code against a recording executor that never talks
 * to a database (synthetic arguments, no customer data). The `check:oracle-sql` tool hands each
 * statement to Oracle's parser only.
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

  const source = new FlexcubeKycSource(rec, opts.keypersonTypeColumn);
  await step('source.refreshCorporateSupport', () => source.refreshCorporateSupport(0));
  await step('source.load individual', () => source.load({ ...key, customerType: 'INDIVIDUAL' }));
  await step('source.load corporate', () => source.load({ ...key, customerType: 'CORPORATE' }));

  const trigger = new CustomerTriggerSource(rec, opts.stagingTable, since);
  const triggerNoCutOff = new CustomerTriggerSource(rec, opts.stagingTable);
  const work: TriggerWork = {
    customerNo: 'CATALOG',
    ...key,
    customerType: 'INDIVIDUAL',
    stagingRows: 0,
    higherRows: 0,
    retryCount: 0,
    picked: false,
    recheck: false,
  };
  await step('trigger.findReady, individuals only', () => trigger.findReady(1, false));
  await step('trigger.findReady', () => trigger.findReady(1, true));
  await step('trigger.findReady, no cut-off', () => triggerNoCutOff.findReady(1, true));
  await step('trigger.findRetryDue, individuals only', () => trigger.findRetryDue(1, false, 60));
  await step('trigger.findRetryDue', () => trigger.findRetryDue(1, true, 60));
  await step('trigger.findRecheckDue, individuals only', () =>
    trigger.findRecheckDue(1, false, 60),
  );
  await step('trigger.findRecheckDue', () => trigger.findRecheckDue(1, true, 60));
  await step('trigger.markPicked', () => trigger.markPicked(work));
  await step('trigger.markError', () => trigger.markError(work));

  const repo = new StagingSubmissionRepository(rec, opts.stagingTable, opts.inProgressStatus);
  await step('staging.insertNew', () => repo.insertNew(key, msgId));
  await step('staging.claim', () => repo.claim(key));
  await step('staging.release', () => repo.release(key));
  await step('staging.fail', () => repo.fail(key, { error: 'ORA-00000' }));
  await step('staging.recoverStale', () => repo.recoverStale(5));
  await step('staging.reclaimFailed', () => repo.reclaimFailed(key, '"stage":"VALIDATION"'));
  await step('staging.unclaimFailed', () => repo.unclaimFailed(key));
  await step('staging.scheduleRetry', () => repo.scheduleRetry(key, { request: {}, response: {} }));
  await step('staging.scheduleRetry (response only)', () =>
    repo.scheduleRetry(key, { response: {} }),
  );
  await step('staging.complete', () =>
    repo.complete(key, { status: StagingProcessStatus.SUCCESS, request: {}, response: {} }),
  );
  await step('staging.complete (response only)', () =>
    repo.complete(key, { status: StagingProcessStatus.ERROR, response: {} }),
  );

  const updater = new StagingFlexcubeStatusUpdater(rec, opts.stagingTable);
  await step('updater.finalStatus', () =>
    updater.updateStatus({
      kycRefNo: key.kycRefNo,
      customerNo: null,
      finalStatus: ReisFinalStatus.CUSTOMER,
      seqNo: key.seqNo,
      idempotencyKey: 'catalog',
    }),
  );
  return rec.entries;
}
