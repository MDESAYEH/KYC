import { ReisFinalStatus } from '../../reis/reis-status';
import { MockFlexcubeStatusUpdater } from '../mock-flexcube-status-updater';
import {
  assertSafeTableName,
  IFlexcubeSqlExecutor,
  StagingFinalStatus,
  toStagingFinalStatus,
} from './flexcube-staging';
import {
  createFlexcubeSqlExecutor,
  createFlexcubeStatusUpdater,
  FlexcubeDbConfigError,
} from './flexcube-status-updater.factory';
import { OracleSqlExecutor } from './oracle-sql-executor';
import {
  StagingFlexcubeStatusUpdater,
  StagingRowNotUpdatedError,
} from './staging-flexcube-status-updater';

/** In-memory stand-in for STTM_KYC_REIS_PAYLOAD_CUSTOM that honours the UPDATE's conditions. */
class FakeStaging implements IFlexcubeSqlExecutor {
  rows: { KYC_REF_NO: string; SEQ_NO: number; REIS_FINAL_STATUS: string | null }[] = [];
  calls: { sql: string; binds: Record<string, string | number | null> }[] = [];

  async query(): Promise<Record<string, unknown>[]> {
    return [];
  }

  async execute(sql: string, binds: Record<string, string | number | null>) {
    this.calls.push({ sql, binds });
    const mine = this.rows.filter((r) => r.KYC_REF_NO === binds.kycRefNo);
    const maxSeq = Math.max(...mine.map((r) => r.SEQ_NO));
    let rowsAffected = 0;
    for (const r of mine) {
      if (
        r.SEQ_NO === maxSeq &&
        (r.REIS_FINAL_STATUS === null || r.REIS_FINAL_STATUS === binds.status)
      ) {
        r.REIS_FINAL_STATUS = String(binds.status);
        rowsAffected++;
      }
    }
    return { rowsAffected };
  }
}

const update = (kycRefNo: string, finalStatus: ReisFinalStatus) => ({
  kycRefNo,
  customerNo: null,
  finalStatus,
  idempotencyKey: `${kycRefNo}:${finalStatus}`,
});

describe('staging final status mapping (Finexta: APPROVED / BLOCKED)', () => {
  it('maps REIS CUSTOMER to APPROVED and BLOCKED to BLOCKED', () => {
    expect(toStagingFinalStatus(ReisFinalStatus.CUSTOMER)).toBe(StagingFinalStatus.APPROVED);
    expect(toStagingFinalStatus(ReisFinalStatus.BLOCKED)).toBe(StagingFinalStatus.BLOCKED);
    expect(() => toStagingFinalStatus('CLEAN' as ReisFinalStatus)).toThrow();
  });
});

describe('StagingFlexcubeStatusUpdater', () => {
  let db: FakeStaging;
  let updater: StagingFlexcubeStatusUpdater;

  beforeEach(() => {
    db = new FakeStaging();
    updater = new StagingFlexcubeStatusUpdater(db, 'STTM_KYC_REIS_PAYLOAD_CUSTOM');
  });

  it('writes APPROVED on the latest submission (highest SEQ_NO) only', async () => {
    db.rows = [
      { KYC_REF_NO: 'K1', SEQ_NO: 1, REIS_FINAL_STATUS: 'BLOCKED' },
      { KYC_REF_NO: 'K1', SEQ_NO: 2, REIS_FINAL_STATUS: null },
      { KYC_REF_NO: 'K2', SEQ_NO: 1, REIS_FINAL_STATUS: null },
    ];
    await updater.updateStatus(update('K1', ReisFinalStatus.CUSTOMER));
    expect(db.rows).toEqual([
      { KYC_REF_NO: 'K1', SEQ_NO: 1, REIS_FINAL_STATUS: 'BLOCKED' },
      { KYC_REF_NO: 'K1', SEQ_NO: 2, REIS_FINAL_STATUS: 'APPROVED' },
      { KYC_REF_NO: 'K2', SEQ_NO: 1, REIS_FINAL_STATUS: null },
    ]);
  });

  it('uses bind variables only (no value is concatenated into the SQL)', async () => {
    db.rows = [{ KYC_REF_NO: "K'1", SEQ_NO: 1, REIS_FINAL_STATUS: null }];
    await updater.updateStatus(update("K'1", ReisFinalStatus.BLOCKED));
    expect(db.calls[0].sql).not.toContain("K'1");
    expect(db.calls[0].sql).toContain('STTM_KYC_REIS_PAYLOAD_CUSTOM');
    expect(db.calls[0].binds).toEqual({ status: 'BLOCKED', kycRefNo: "K'1" });
  });

  it('is idempotent for the same status', async () => {
    db.rows = [{ KYC_REF_NO: 'K1', SEQ_NO: 1, REIS_FINAL_STATUS: null }];
    await updater.updateStatus(update('K1', ReisFinalStatus.BLOCKED));
    await expect(updater.updateStatus(update('K1', ReisFinalStatus.BLOCKED))).resolves.toBe(
      undefined,
    );
  });

  it('never overwrites a different final status and fails instead', async () => {
    db.rows = [{ KYC_REF_NO: 'K1', SEQ_NO: 1, REIS_FINAL_STATUS: 'BLOCKED' }];
    await expect(updater.updateStatus(update('K1', ReisFinalStatus.CUSTOMER))).rejects.toThrow(
      StagingRowNotUpdatedError,
    );
    expect(db.rows[0].REIS_FINAL_STATUS).toBe('BLOCKED');
  });

  it('fails when the KYC has no staging row', async () => {
    await expect(updater.updateStatus(update('NOPE', ReisFinalStatus.CUSTOMER))).rejects.toThrow(
      StagingRowNotUpdatedError,
    );
  });

  it.each(['', 'X; DROP TABLE Y', 'A B', '1ABC', 'S.T.U'])(
    'refuses the unsafe table name %p',
    (name) => {
      expect(() => assertSafeTableName(name)).toThrow();
      expect(() => new StagingFlexcubeStatusUpdater(db, name)).toThrow();
    },
  );

  it('accepts a schema-qualified table name', () => {
    expect(assertSafeTableName('FCUBS.STTM_KYC_REIS_PAYLOAD_CUSTOM')).toBe(
      'FCUBS.STTM_KYC_REIS_PAYLOAD_CUSTOM',
    );
  });
});

describe('FLEXCUBE updater selection', () => {
  const cfg = (over = {}) => ({
    dbUser: undefined,
    dbPassword: undefined,
    dbConnectString: undefined,
    dbSchema: undefined,
    stagingTable: 'STTM_KYC_REIS_PAYLOAD_CUSTOM',
    pollEnabled: false,
    pollIntervalMs: 120000,
    pollBatchSize: 20,
    syncStartDate: undefined,
    ...over,
  });
  const log = () => ({ warn: jest.fn() });

  it('no FLEXCUBE database: mock outside production (with a warning), startup fails in production', () => {
    expect(createFlexcubeSqlExecutor(cfg())).toBeNull();
    const l = log();
    expect(createFlexcubeStatusUpdater(null, cfg(), 'development', l)).toBeInstanceOf(
      MockFlexcubeStatusUpdater,
    );
    expect(l.warn).toHaveBeenCalled();
    expect(() => createFlexcubeStatusUpdater(null, cfg(), 'production', log())).toThrow(
      FlexcubeDbConfigError,
    );
  });

  it('a partial FLEXCUBE database configuration stops startup', () => {
    expect(() => createFlexcubeSqlExecutor(cfg({ dbUser: 'u' }))).toThrow(FlexcubeDbConfigError);
  });

  it('a full configuration gives the Oracle executor and the staging updater', () => {
    const c = cfg({ dbUser: 'u', dbPassword: 'p', dbConnectString: 'host:1521/SVC' });
    const executor = createFlexcubeSqlExecutor(c);
    expect(executor).toBeInstanceOf(OracleSqlExecutor);
    expect(createFlexcubeStatusUpdater(executor, c, 'production', log())).toBeInstanceOf(
      StagingFlexcubeStatusUpdater,
    );
  });
});
