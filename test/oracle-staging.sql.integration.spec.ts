import { randomBytes } from 'node:crypto';
import { oracleErrorCode } from '../src/flexcube/oracle-error';
import { OracleSqlExecutor } from '../src/flexcube/staging/oracle-sql-executor';
import {
  StagingProcessStatus,
  StagingSubmissionRepository,
} from '../src/flexcube/staging/staging-submission.repository';

/**
 * REAL Oracle check of the staging SQL (the mocks cannot reveal Oracle SQL errors such as ORA-01745).
 *
 * SKIPPED unless the person running it points it at an ISOLATED Oracle schema they own and sets, in
 * the shell (never read from .env):
 *
 *   KYC_ORACLE_TEST_USER, KYC_ORACLE_TEST_PASSWORD, KYC_ORACLE_TEST_CONNECT (host:port/SERVICE)
 *   KYC_ORACLE_TEST_CONFIRM=CREATE_AND_DROP_A_TEST_TABLE
 *
 * It creates ONE new table named KYC_TEST_STG_<random> in that user's own schema (with the CHECK
 * constraint PROCESS_STATUS IN ('N','W','S','E')), runs every staging statement against it and drops
 * it again. It never touches STTM_KYC_REIS_PAYLOAD_CUSTOM or any FLEXCUBE table and must never be
 * pointed at UAT1 / PRODUCTION. The columns below are an ASSUMED shape of the staging table
 * (REQUEST / RESPONSE as CLOB): compare with the real DDL before trusting a result.
 */
const enabled =
  process.env.KYC_ORACLE_TEST_CONFIRM === 'CREATE_AND_DROP_A_TEST_TABLE' &&
  !!process.env.KYC_ORACLE_TEST_USER &&
  !!process.env.KYC_ORACLE_TEST_PASSWORD &&
  !!process.env.KYC_ORACLE_TEST_CONNECT;

(enabled ? describe : describe.skip)('staging SQL on a real, isolated Oracle schema', () => {
  const table = `KYC_TEST_STG_${randomBytes(4).toString('hex').toUpperCase()}`;
  let db: OracleSqlExecutor;
  let repo: StagingSubmissionRepository;
  const key = (n: number) => ({ kycRefNo: `T-${n}`, seqNo: 1 });
  const status = async (n: number) =>
    (
      await db.query(
        'SELECT PROCESS_STATUS AS S, REQ_DATE IS NULL AS NO_REQ FROM ' +
          table +
          ' WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo',
        key(n),
      )
    )[0];

  beforeAll(async () => {
    db = new OracleSqlExecutor({
      user: process.env.KYC_ORACLE_TEST_USER as string,
      password: process.env.KYC_ORACLE_TEST_PASSWORD as string,
      connectString: process.env.KYC_ORACLE_TEST_CONNECT as string,
    });
    await db.execute(
      `CREATE TABLE ${table} (KYC_REF_NO VARCHAR2(50) NOT NULL, SEQ_NO NUMBER NOT NULL, ` +
        `MSGID VARCHAR2(64), REQUEST CLOB, RESPONSE CLOB, ` +
        `PROCESS_STATUS VARCHAR2(1) CHECK (PROCESS_STATUS IN ('N','W','S','E')), ` +
        `REIS_FINAL_STATUS VARCHAR2(20), RETRY_COUNT NUMBER, REQ_DATE DATE, RES_DATE DATE, ` +
        `CONSTRAINT ${table}_PK PRIMARY KEY (KYC_REF_NO, SEQ_NO))`,
      {},
    );
    repo = new StagingSubmissionRepository(db, table);
  });
  afterAll(async () => {
    await db.execute(`DROP TABLE ${table} PURGE`, {}).catch(() => undefined);
    await db.onModuleDestroy();
  });

  it('proves the root cause: Oracle rejects a bind named like a reserved word with ORA-01745', async () => {
    const oracledb = (await import('oracledb')).default;
    const conn = await oracledb.getConnection({
      user: process.env.KYC_ORACLE_TEST_USER,
      password: process.env.KYC_ORACLE_TEST_PASSWORD,
      connectString: process.env.KYC_ORACLE_TEST_CONNECT,
    });
    try {
      const err = await conn
        .execute('SELECT :from AS V FROM DUAL', { from: 1 })
        .catch((e: unknown) => e);
      expect(oracleErrorCode(err)).toBe('ORA-01745');
    } finally {
      await conn.close();
    }
  });

  it('insertNew -> claim -> complete (S) with the corrected bind names', async () => {
    expect(await repo.insertNew(key(1), 'f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true);
    expect(await repo.insertNew(key(1), 'x')).toBe(false); // unique violation is "already there"
    expect(await repo.claim(key(1))).toBe(true);
    expect(await repo.claim(key(1))).toBe(false); // only from N
    await repo.complete(key(1), {
      status: StagingProcessStatus.SUCCESS,
      request: { a: 1 },
      response: { b: 2 },
    });
    expect((await status(1)).S).toBe('S');
  });

  it('complete as E, fail, release and the stuck / never-sent queries', async () => {
    await repo.insertNew(key(2), 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
    await repo.claim(key(2));
    expect(await repo.release(key(2))).toBe(true); // W -> N, REQ_DATE cleared
    expect(await status(2)).toMatchObject({ S: 'N' });

    await repo.claim(key(2));
    await db.execute(
      `UPDATE ${table} SET REQ_DATE = SYSDATE - 1 WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo`,
      key(2),
    );
    expect(await repo.findStuckInProgress(15, 10)).toEqual([key(2)]);
    expect(await repo.fail(key(2), { error: 'X' })).toBe(true); // W -> E
    expect((await status(2)).S).toBe('E');
  });

  it('a CHECK constraint on the claim status gives ORA-02290 (the technical code the service logs)', async () => {
    const strict = new StagingSubmissionRepository(db, table, 'X'); // X violates the CHECK
    await repo.insertNew(key(3), 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
    const err = await strict.claim(key(3)).catch((e: unknown) => e);
    expect(oracleErrorCode(err)).toBe('ORA-02290');
    expect((await status(3)).S).toBe('N'); // the row is untouched
  });
});
