import { FlexcubeKycSource, PendingKyc } from '../flexcube/source/flexcube-kyc-source';
import { IFlexcubeSqlExecutor, SqlBinds, SqlRow } from '../flexcube/staging/flexcube-staging';
import { extractBindNames } from '../flexcube/staging/sql-binds';
import { StagingFlexcubeStatusUpdater } from '../flexcube/staging/staging-flexcube-status-updater';
import {
  NeverSentRow,
  StagingProcessStatus,
  StagingSubmissionRepository,
} from '../flexcube/staging/staging-submission.repository';
import { ReisFinalStatus } from '../reis/reis-status';

/**
 * The exact SQL text of EVERY statement the integration layer can send to FLEXCUBE, collected by
 * running the real repository / source / updater code against a recording executor that never
 * talks to a database (synthetic arguments, no customer data). The `check:oracle-sql` tool hands
 * each statement to Oracle's parser only; tests check the same list against the bind guard.
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
    await run().catch(() => undefined); // synthetic data may fail mapping: the SQL is recorded
  };
  const since = '2026-01-01T00:00:00';
  const key = { kycRefNo: 'CATALOG', seqNo: 1 };
  const individual: PendingKyc = { ...key, customerType: 'INDIVIDUAL' };
  const corporate: PendingKyc = { ...key, customerType: 'CORPORATE' };
  const row: NeverSentRow = {
    ...key,
    msgId: '00000000-0000-4000-8000-000000000000',
    processStatus: StagingProcessStatus.ERROR,
    response: '{"error":"ORA-01745"}',
    retryCount: 1,
    resDate: null,
    reqDate: null,
    request: null,
    reisFinalStatus: null,
  };

  for (const canary of [[], ['CATALOG']] as string[][]) {
    const source = new FlexcubeKycSource(
      rec,
      opts.stagingTable,
      since,
      opts.keypersonTypeColumn,
      canary,
    );
    const label = canary.length ? ' (canary)' : '';
    await step(`source.findPending, individuals only${label}`, () => source.findPending(1));
    await step(`source.findOwnStuckNew, individuals only${label}`, () => source.findOwnStuckNew(1));
    await step('source.refreshCorporateSupport', () => source.refreshCorporateSupport(0));
    await step(`source.findPending${label}`, () => source.findPending(1));
    await step(`source.findOwnStuckNew${label}`, () => source.findOwnStuckNew(1));
    await step('source.load individual', () => source.load(individual));
    await step('source.load corporate', () => source.load(corporate));
  }

  const repo = new StagingSubmissionRepository(rec, opts.stagingTable, opts.inProgressStatus);
  await step('staging.insertNew', () => repo.insertNew(key, row.msgId));
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
  await step('reconcile.findNeverSentTechnicalErrors --kyc', () =>
    repo.findNeverSentTechnicalErrors(since, ['ORA-01745'], 1, 'CATALOG'),
  );
  await step('reconcile.restoreNeverSent', () => repo.restoreNeverSent(row, 'ORA-01745', since));
  await step('reconcile.rollbackRestore', () => repo.rollbackRestore(row));

  const updater = new StagingFlexcubeStatusUpdater(rec, opts.stagingTable);
  await step('updater.finalStatus', () =>
    updater.updateStatus({
      kycRefNo: key.kycRefNo,
      customerNo: null,
      finalStatus: ReisFinalStatus.CUSTOMER,
      idempotencyKey: 'catalog',
    }),
  );
  return rec.entries;
}
