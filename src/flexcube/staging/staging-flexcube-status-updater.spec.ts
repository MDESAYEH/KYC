import { assertValidBinds } from './sql-binds';
import { ReisFinalStatus } from '../../reis/reis-status';
import { MockFlexcubeStatusUpdater } from '../mock-flexcube-status-updater';
import {
  decisionValues,
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
  StagingRevisionRequiredError,
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
    assertValidBinds(sql, binds);
    this.calls.push({ sql, binds });
    const mine = this.rows.filter((r) => r.KYC_REF_NO === binds.kycRefNo);
    // exact submission when :seqNo is bound, otherwise the latest SEQ_NO (historical behavior)
    const target = binds.seqNo !== undefined ? binds.seqNo : Math.max(...mine.map((r) => r.SEQ_NO));
    let rowsAffected = 0;
    for (const r of mine) {
      const replaceable =
        binds.pendingStatus !== undefined && r.REIS_FINAL_STATUS === binds.pendingStatus;
      if (
        r.SEQ_NO === target &&
        (r.REIS_FINAL_STATUS === null || r.REIS_FINAL_STATUS === binds.finalStatus || replaceable)
      ) {
        r.REIS_FINAL_STATUS = String(binds.finalStatus);
        rowsAffected++;
      }
    }
    return { rowsAffected };
  }
}

const update = (kycRefNo: string, finalStatus: ReisFinalStatus, seqNo = 1) => ({
  kycRefNo,
  customerNo: null,
  finalStatus,
  seqNo,
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

  it('writes APPROVED on the EXACT submission named by seqNo only (here 2, never 1 or K2)', async () => {
    db.rows = [
      { KYC_REF_NO: 'K1', SEQ_NO: 1, REIS_FINAL_STATUS: 'BLOCKED' },
      { KYC_REF_NO: 'K1', SEQ_NO: 2, REIS_FINAL_STATUS: null },
      { KYC_REF_NO: 'K2', SEQ_NO: 1, REIS_FINAL_STATUS: null },
    ];
    await updater.updateStatus(update('K1', ReisFinalStatus.CUSTOMER, 2));
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
    expect(db.calls[0].binds).toEqual({ finalStatus: 'BLOCKED', kycRefNo: "K'1", seqNo: 1 });
  });

  it('REFUSES an update without an exact seqNo: no "latest revision" fallback, nothing reaches Oracle', async () => {
    db.rows = [
      { KYC_REF_NO: 'K1', SEQ_NO: 2, REIS_FINAL_STATUS: null },
      { KYC_REF_NO: 'K1', SEQ_NO: 3, REIS_FINAL_STATUS: null },
    ];
    for (const seqNo of [undefined, null, NaN, 1.5, '3'])
      await expect(
        updater.updateStatus({ ...update('K1', ReisFinalStatus.CUSTOMER), seqNo } as never),
      ).rejects.toBeInstanceOf(StagingRevisionRequiredError);
    expect(db.calls).toHaveLength(0);
    expect(db.rows.every((r) => r.REIS_FINAL_STATUS === null)).toBe(true);
  });

  it('a delayed decision of revision 2 never reaches revision 3, even when 3 is the latest and still open', async () => {
    db.rows = [
      { KYC_REF_NO: 'K1', SEQ_NO: 2, REIS_FINAL_STATUS: 'APPROVED' },
      { KYC_REF_NO: 'K1', SEQ_NO: 3, REIS_FINAL_STATUS: null },
    ];
    // duplicate of the revision-2 decision: idempotent on 2, 3 untouched
    await updater.updateStatus(update('K1', ReisFinalStatus.CUSTOMER, 2));
    // a contrary late decision of revision 2: refused, 2 keeps its decision, 3 untouched
    await expect(
      updater.updateStatus(update('K1', ReisFinalStatus.BLOCKED, 2)),
    ).rejects.toBeInstanceOf(StagingRowNotUpdatedError);
    expect(db.rows.map((r) => r.REIS_FINAL_STATUS)).toEqual(['APPROVED', null]);
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
    stagingStatusInProgress: 'W',
    keypersonTypeColumn: 'KYC_KEYPERSON_TYPE',
    finalStatusVocabulary: 'approved-blocked',
    syncUncertainAck: [] as string[],
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

describe('final status vocabulary and exact-revision updates', () => {
  let db: FakeStaging;
  const row = (seqNo: number, status: string | null = null) => ({
    KYC_REF_NO: 'K1',
    SEQ_NO: seqNo,
    REIS_FINAL_STATUS: status,
  });
  beforeEach(() => void (db = new FakeStaging()));

  it('the default vocabulary is unchanged (APPROVED / BLOCKED) and there is no interim word', () => {
    expect(decisionValues('approved-blocked')).toEqual({
      approved: 'APPROVED',
      blocked: 'BLOCKED',
      pending: null,
    });
    expect(toStagingFinalStatus(ReisFinalStatus.CUSTOMER)).toBe('APPROVED');
  });

  it('the opt-in vocabulary writes CLEAN / PENDING / BLOCKED', () => {
    expect(decisionValues('clean-pending-blocked')).toEqual({
      approved: 'CLEAN',
      blocked: 'BLOCKED',
      pending: 'PENDING',
    });
    expect(toStagingFinalStatus(ReisFinalStatus.CUSTOMER, 'clean-pending-blocked')).toBe('CLEAN');
    expect(toStagingFinalStatus(ReisFinalStatus.BLOCKED, 'clean-pending-blocked')).toBe('BLOCKED');
  });

  it('refuses an unknown vocabulary and an unknown REIS status (no default, no guess)', () => {
    expect(() => decisionValues('whatever' as never)).toThrow('FLEXCUBE_FINAL_STATUS_VOCABULARY');
    expect(() => new StagingFlexcubeStatusUpdater(db, 'T', 'x' as never)).toThrow();
    expect(() =>
      toStagingFinalStatus('TIMEOUT' as ReisFinalStatus, 'clean-pending-blocked'),
    ).toThrow();
    expect(() => toStagingFinalStatus('PENDING' as ReisFinalStatus)).toThrow();
  });

  it('updates the EXACT submission when seqNo is given, never the latest one', async () => {
    db.rows = [row(1), row(2)];
    const updater = new StagingFlexcubeStatusUpdater(db, 'T');
    await updater.updateStatus({ ...update('K1', ReisFinalStatus.CUSTOMER), seqNo: 1 });
    expect(db.rows).toEqual([row(1, 'APPROVED'), row(2)]);
    expect(db.calls[0].binds).toEqual({ finalStatus: 'APPROVED', kycRefNo: 'K1', seqNo: 1 });
    // a revision that does not exist is an error, not "the latest one"
    await expect(
      updater.updateStatus({ ...update('K1', ReisFinalStatus.CUSTOMER), seqNo: 9 }),
    ).rejects.toThrow(StagingRowNotUpdatedError);
  });

  it('a late callback of an older revision cannot touch the newer revision', async () => {
    db.rows = [row(1, 'PENDING'), row(2, 'PENDING')];
    const updater = new StagingFlexcubeStatusUpdater(db, 'T', 'clean-pending-blocked');
    await updater.updateStatus({ ...update('K1', ReisFinalStatus.BLOCKED), seqNo: 1 });
    expect(db.rows).toEqual([row(1, 'BLOCKED'), row(2, 'PENDING')]);
  });

  it('PENDING is replaced by the final decision (new vocabulary), CLEAN / BLOCKED never by another decision', async () => {
    const updater = new StagingFlexcubeStatusUpdater(db, 'T', 'clean-pending-blocked');
    db.rows = [row(2, 'PENDING')];
    await updater.updateStatus({ ...update('K1', ReisFinalStatus.CUSTOMER), seqNo: 2 });
    expect(db.rows[0].REIS_FINAL_STATUS).toBe('CLEAN');
    await updater.updateStatus({ ...update('K1', ReisFinalStatus.CUSTOMER), seqNo: 2 }); // idempotent
    await expect(
      updater.updateStatus({ ...update('K1', ReisFinalStatus.BLOCKED), seqNo: 2 }),
    ).rejects.toThrow(StagingRowNotUpdatedError);
    expect(db.rows[0].REIS_FINAL_STATUS).toBe('CLEAN');
  });

  it('the default vocabulary never replaces a stored PENDING (no interim word is part of it)', async () => {
    db.rows = [row(2, 'PENDING')];
    const updater = new StagingFlexcubeStatusUpdater(db, 'T');
    await expect(
      updater.updateStatus({ ...update('K1', ReisFinalStatus.CUSTOMER), seqNo: 2 }),
    ).rejects.toThrow(StagingRowNotUpdatedError);
    expect(db.rows[0].REIS_FINAL_STATUS).toBe('PENDING');
  });

  it('every statement passes the Oracle bind guard in both vocabularies and both targeting modes', async () => {
    for (const vocabulary of ['approved-blocked', 'clean-pending-blocked'] as const) {
      db.rows = [row(1), row(2)];
      const updater = new StagingFlexcubeStatusUpdater(db, 'T', vocabulary);
      await updater.updateStatus({ ...update('K1', ReisFinalStatus.CUSTOMER), seqNo: 1 });
      await updater.updateStatus(update('K1', ReisFinalStatus.BLOCKED, 2));
      expect(db.rows[1].REIS_FINAL_STATUS).toBe('BLOCKED');
    }
  });
});
