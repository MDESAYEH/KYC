import { randomBytes } from 'node:crypto';
import { assertDisposableDatabase, isolatedOracleConfig } from './support/isolated-oracle';
import { OracleSqlExecutor } from '../src/flexcube/staging/oracle-sql-executor';
import { IFlexcubeSqlExecutor, SqlBinds } from '../src/flexcube/staging/flexcube-staging';
import { SingleKycTrialRepository } from '../src/tools/single-kyc-trial.repository';
import { SINGLE_KYC_TRIAL as TARGET } from '../src/tools/single-kyc-trial.contract';

/** Never reads .env. Run ONLY with an explicitly approved disposable schema, never bank UAT/PROD.
 * Creates two randomly named tables, not STTM_* tables. DDL is an assumed fixture, not bank DDL.
 */
const cfg = isolatedOracleConfig('KYC_SINGLE_ORACLE_TEST', 'CREATE_AND_DROP_ISOLATED_TRIAL_TABLES');
(cfg ? describe : describe.skip)('single-trial statements on real ISOLATED Oracle', () => {
  const suffix = randomBytes(4).toString('hex').toUpperCase();
  const master = `KTR_MASTER_${suffix}`,
    stage = `KTR_STAGE_${suffix}`,
    customer = `KTR_CUST_${suffix}`,
    trigger = `KTR_TRIG_${suffix}`;
  const msg = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  let db: OracleSqlExecutor;
  let repo: SingleKycTrialRepository;
  let createdMaster = false,
    createdStage = false,
    createdCustomer = false,
    createdTrigger = false;
  beforeAll(async () => {
    db = new OracleSqlExecutor(cfg!);
    await assertDisposableDatabase(db);
    await db.execute(
      `CREATE TABLE ${master} (KYC_REF_NO VARCHAR2(100) PRIMARY KEY, MOD_NO NUMBER, KYC_CUST_TYPE CHAR(1), RECORD_STAT CHAR(1))`,
      {},
    );
    createdMaster = true;
    await db.execute(
      `CREATE TABLE ${stage} (KYC_REF_NO VARCHAR2(100), SEQ_NO NUMBER, MSGID VARCHAR2(36), PROCESS_STATUS CHAR(1) CHECK (PROCESS_STATUS IN ('N','W','S','E')), REQUEST CLOB, RESPONSE CLOB, RETRY_COUNT NUMBER, REQ_DATE DATE, RES_DATE DATE, REIS_FINAL_STATUS VARCHAR2(20) CHECK (REIS_FINAL_STATUS IN ('CLEAN','PENDING','BLOCKED')), PRIMARY KEY (KYC_REF_NO,SEQ_NO))`,
      {},
    );
    createdStage = true;
    await db.execute(
      `CREATE TABLE ${customer} (CUSTOMER_NO VARCHAR2(36) PRIMARY KEY, MOD_NO NUMBER)`,
      {},
    );
    createdCustomer = true;
    await db.execute(
      `CREATE TABLE ${trigger} (CUSTOMER_NO VARCHAR2(36) NOT NULL, KYC_REF_NO VARCHAR2(64) NOT NULL, READY_TO_SCAN CHAR(1))`,
      {},
    );
    createdTrigger = true;
    // Substitute ONLY the hard-coded FLEXCUBE identifiers (trigger first: it contains STTM_CUSTOMER).
    const replace = (sql: string) =>
      sql
        .replaceAll('STTM_KYC_MASTER', master)
        .replaceAll('STTM_CUSTOMER_CUSTOM', trigger)
        .replaceAll('STTM_CUSTOMER', customer);
    const isolated: IFlexcubeSqlExecutor = {
      query: (sql, binds) => db.query(replace(sql), binds),
      execute: (sql, binds) => db.execute(replace(sql), binds),
    };
    repo = new SingleKycTrialRepository(isolated, stage);
  });
  beforeEach(async () => {
    await db.execute(`DELETE FROM ${stage}`, {});
    await db.execute(`DELETE FROM ${master}`, {});
    await db.execute(`DELETE FROM ${customer}`, {});
    await db.execute(`DELETE FROM ${trigger}`, {});
    // KYC MOD_NO 2, CIF MOD_NO 1 (= SEQ_NO), trigger at U: the UAT1 values of 19/11/2026.
    await db.execute(`INSERT INTO ${master} VALUES (:kycRefNo, 2, 'R', 'O')`, {
      kycRefNo: TARGET.kycRefNo,
    });
    await db.execute(`INSERT INTO ${customer} VALUES (:cif, :seqNo)`, {
      cif: TARGET.expectedCif,
      seqNo: TARGET.seqNo,
    });
    await db.execute(`INSERT INTO ${trigger} VALUES (:cif, :kycRefNo, 'U')`, {
      cif: TARGET.expectedCif,
      kycRefNo: TARGET.kycRefNo,
    });
    await repo.staging.insertNew(repo.key(), msg);
  });
  afterAll(async () => {
    if (createdStage) await db.execute(`DROP TABLE ${stage} PURGE`, {});
    if (createdMaster) await db.execute(`DROP TABLE ${master} PURGE`, {});
    if (createdCustomer) await db.execute(`DROP TABLE ${customer} PURGE`, {});
    if (createdTrigger) await db.execute(`DROP TABLE ${trigger} PURGE`, {});
    await db?.onModuleDestroy();
  });
  it('claims the exact current revision once with Oracle-safe bind names', async () => {
    expect(await repo.claim(msg)).toBe(true);
    expect(await repo.claim(msg)).toBe(false);
    expect(await repo.read()).toMatchObject({
      kycRefNo: TARGET.kycRefNo,
      seqNo: TARGET.seqNo,
      processStatus: 'W',
    });
  });
  it('stores request, raw response and PENDING without changing another SEQ_NO', async () => {
    const other: SqlBinds = { kycRefNo: TARGET.kycRefNo, seqNo: 3, msgId: msg };
    await db.execute(
      `INSERT INTO ${stage} (KYC_REF_NO,SEQ_NO,MSGID,PROCESS_STATUS,RETRY_COUNT) VALUES (:kycRefNo,:seqNo,:msgId,'E',1)`,
      other,
    );
    expect(await repo.claim(msg)).toBe(true);
    expect(await repo.markPicked()).toBe(true);
    await repo.storeIntent(msg, { systemId: 'SYNTHETIC-ISOLATED' });
    await repo.complete(msg, { wire: { status: 200, body: '{"status":"PENDING"}' } }, true);
    await repo.writeWireStatus('PENDING', msg);
    expect(await repo.read()).toMatchObject({ processStatus: 'S', reisFinalStatus: 'PENDING' });
    expect(
      (
        await db.query(`SELECT PROCESS_STATUS,REIS_FINAL_STATUS FROM ${stage} WHERE SEQ_NO=3`, {})
      )[0],
    ).toMatchObject({ PROCESS_STATUS: 'E', REIS_FINAL_STATUS: null });
  });
  it('a modified CIF (MOD_NO changed) prevents the claim without setting E or inventing a decision', async () => {
    await db.execute(`UPDATE ${customer} SET MOD_NO = 2`, {});
    expect(await repo.claim(msg)).toBe(false);
    expect(await repo.read()).toMatchObject({
      processStatus: 'N',
      reqDate: null,
      reisFinalStatus: null,
    });
  });
  it('reuses our never-sent ORA-01745 row: E -> N -> W, then the trigger U -> P', async () => {
    await db.execute(
      `UPDATE ${stage} SET PROCESS_STATUS = 'E', RESPONSE = '{"error":"ORA-01745"}', RETRY_COUNT = 1, RES_DATE = SYSDATE`,
      {},
    );
    const row = await repo.read();
    expect(row).toMatchObject({ processStatus: 'E', retryCount: 1 });
    expect(await repo.restoreNeverSent(row!)).toBe(true);
    expect(await repo.restoreNeverSent(row!)).toBe(false);
    expect(await repo.claim(msg)).toBe(true);
    expect(await repo.markPicked()).toBe(true);
    expect(await repo.markPicked()).toBe(false);
    const t = await db.query(`SELECT READY_TO_SCAN FROM ${trigger}`, {});
    expect(t[0]).toMatchObject({ READY_TO_SCAN: 'P' });
  });
});
