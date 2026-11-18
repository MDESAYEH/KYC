import { randomBytes } from 'node:crypto';
import { OracleSqlExecutor } from '../src/flexcube/staging/oracle-sql-executor';
import {
  StagingFlexcubeStatusUpdater,
  StagingRevisionRequiredError,
  StagingRowNotUpdatedError,
} from '../src/flexcube/staging/staging-flexcube-status-updater';
import { ReisFinalStatus } from '../src/reis/reis-status';
import { assertDisposableDatabase, isolatedOracleConfig } from './support/isolated-oracle';

/**
 * B5 on REAL, ISOLATED Oracle: the final-status UPDATE (the statement a REIS callback ends in) touches exactly the
 * intended revision, replaces PENDING only when the vocabulary allows it, never overwrites a final decision, and is
 * idempotent. SKIPPED unless explicitly enabled (see docs/isolated-oracle-tests.md); refused for anything that is not
 * a disposable database (test/support/isolated-oracle.ts). Creates ONE randomly named table, never an STTM_* table.
 *
 *   KYC_STATUS_ORACLE_TEST_USER / _PASSWORD / _CONNECT   disposable schema
 *   KYC_STATUS_ORACLE_TEST_CONFIRM=CREATE_AND_DROP_ISOLATED_STATUS_TABLE
 *
 * The DDL below is an ASSUMED fixture (REIS_FINAL_STATUS VARCHAR2(25), no CHECK on it), as seen on UAT1 (17/11/2026):
 * it is not bank DDL, so a pass proves our SQL, not the bank contract (that stays B4).
 */
const cfg = isolatedOracleConfig('KYC_STATUS_ORACLE_TEST', 'CREATE_AND_DROP_ISOLATED_STATUS_TABLE');

(cfg ? describe : describe.skip)('final-status UPDATE on real ISOLATED Oracle (B5)', () => {
  const table = `KST_STAGE_${randomBytes(4).toString('hex').toUpperCase()}`;
  let db: OracleSqlExecutor;
  let created = false;
  const KYC = 'SYNTH-KYC-1';

  const status = async (seq: number) =>
    (
      await db.query(
        `SELECT REIS_FINAL_STATUS AS S FROM ${table} WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo`,
        { kycRefNo: KYC, seqNo: seq },
      )
    )[0]?.S ?? null;
  const update = (words: 'approved-blocked' | 'clean-pending-blocked') =>
    new StagingFlexcubeStatusUpdater(db, table, words);
  const call = (
    status: ReisFinalStatus,
    seqNo: number,
    kycRefNo = KYC,
  ): {
    kycRefNo: string;
    customerNo: null;
    finalStatus: ReisFinalStatus;
    seqNo: number;
    idempotencyKey: string;
  } => ({
    kycRefNo,
    customerNo: null,
    finalStatus: status,
    seqNo,
    idempotencyKey: `${kycRefNo}:${status}`,
  });
  const seed = async (rows: [string, number, string | null][]) => {
    await db.execute(`DELETE FROM ${table}`, {});
    for (const [k, s, f] of rows)
      await db.execute(
        `INSERT INTO ${table} (KYC_REF_NO, SEQ_NO, PROCESS_STATUS, REIS_FINAL_STATUS) VALUES (:kycRefNo, :seqNo, 'S', :finalStatus)`,
        { kycRefNo: k, seqNo: s, finalStatus: f },
      );
  };

  beforeAll(async () => {
    db = new OracleSqlExecutor(cfg!);
    await assertDisposableDatabase(db); // refuses a tunnel to a bank database BEFORE anything is created
    await db.execute(
      `CREATE TABLE ${table} (KYC_REF_NO VARCHAR2(100), SEQ_NO NUMBER, PROCESS_STATUS VARCHAR2(1), REIS_FINAL_STATUS VARCHAR2(25), PRIMARY KEY (KYC_REF_NO, SEQ_NO))`,
      {},
    );
    created = true;
  });
  afterAll(async () => {
    if (created) await db.execute(`DROP TABLE ${table} PURGE`, {});
    await db?.onModuleDestroy();
  });

  it('exact seqNo: updates revision 2 only, never revision 1 or 3 (Oracle-safe binds)', async () => {
    await seed([
      [KYC, 1, 'CLEAN'],
      [KYC, 2, 'PENDING'],
      [KYC, 3, null],
    ]);
    await update('clean-pending-blocked').updateStatus(call(ReisFinalStatus.BLOCKED, 2));
    expect([await status(1), await status(2), await status(3)]).toEqual(['CLEAN', 'BLOCKED', null]);
  });

  it('CLEAN / BLOCKED replace the interim PENDING in the clean-pending-blocked vocabulary', async () => {
    await seed([[KYC, 2, 'PENDING']]);
    await update('clean-pending-blocked').updateStatus(call(ReisFinalStatus.CUSTOMER, 2));
    expect(await status(2)).toBe('CLEAN');
  });

  it('HAZARD proven on Oracle: the default vocabulary cannot replace PENDING (0 rows -> error, PENDING kept)', async () => {
    await seed([[KYC, 2, 'PENDING']]);
    await expect(
      update('approved-blocked').updateStatus(call(ReisFinalStatus.CUSTOMER, 2)),
    ).rejects.toBeInstanceOf(StagingRowNotUpdatedError);
    expect(await status(2)).toBe('PENDING');
  });

  it('never overwrites a different final decision; the same decision again is idempotent', async () => {
    await seed([[KYC, 2, 'BLOCKED']]);
    const u = update('clean-pending-blocked');
    await expect(u.updateStatus(call(ReisFinalStatus.CUSTOMER, 2))).rejects.toBeInstanceOf(
      StagingRowNotUpdatedError,
    );
    await u.updateStatus(call(ReisFinalStatus.BLOCKED, 2));
    expect(await status(2)).toBe('BLOCKED');
  });

  it('a revision that does not exist, or another KYC, changes nothing', async () => {
    await seed([
      [KYC, 2, 'PENDING'],
      ['SYNTH-KYC-OTHER', 2, 'PENDING'],
    ]);
    await expect(
      update('clean-pending-blocked').updateStatus(call(ReisFinalStatus.CUSTOMER, 9)),
    ).rejects.toBeInstanceOf(StagingRowNotUpdatedError);
    expect(await status(2)).toBe('PENDING');
    expect(
      (
        await db.query(`SELECT REIS_FINAL_STATUS AS S FROM ${table} WHERE KYC_REF_NO = :kycRefNo`, {
          kycRefNo: 'SYNTH-KYC-OTHER',
        })
      )[0].S,
    ).toBe('PENDING');
  });

  it('without an exact seqNo the update is refused before Oracle: there is no latest-revision fallback', async () => {
    await seed([
      [KYC, 1, 'CLEAN'],
      [KYC, 2, 'PENDING'],
    ]);
    await expect(
      update('clean-pending-blocked').updateStatus(
        call(ReisFinalStatus.BLOCKED, undefined as never),
      ),
    ).rejects.toBeInstanceOf(StagingRevisionRequiredError);
    expect([await status(1), await status(2)]).toEqual(['CLEAN', 'PENDING']);
  });
});
