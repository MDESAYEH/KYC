import { IFlexcubeSqlExecutor, SqlBinds, SqlRow } from '../staging/flexcube-staging';
import { assertValidBinds } from '../staging/sql-binds';
import { CustomerTriggerSource, TriggerWriteDisabledError } from './customer-trigger.source';

class Db implements IFlexcubeSqlExecutor {
  calls: { kind: 'query' | 'execute'; sql: string; binds: SqlBinds }[] = [];
  rows: SqlRow[] = [];
  affected = 1;
  async query(sql: string, binds: SqlBinds) {
    assertValidBinds(sql, binds);
    this.calls.push({ kind: 'query', sql, binds });
    return this.rows;
  }
  async execute(sql: string, binds: SqlBinds) {
    assertValidBinds(sql, binds);
    this.calls.push({ kind: 'execute', sql, binds });
    return { rowsAffected: this.affected };
  }
}

const SINCE = '2026-11-01';
const row = (over: SqlRow = {}): SqlRow => ({
  CUSTOMER_NO: '00005804',
  KYC_REF_NO: 'K1',
  CIF_MOD_NO: 1,
  KYC_MOD_NO: 2,
  KYC_CUST_TYPE: 'R',
  STAGING_ROWS: 0,
  HIGHER_ROWS: 0,
  ...over,
});

describe('CustomerTriggerSource (STTM_CUSTOMER_CUSTOM, READY_TO_SCAN U -> P)', () => {
  it('findReady is a SELECT only: reads U rows, applies the cut-off through the KYC master, keeps the CIF as a string', async () => {
    const db = new Db();
    db.rows = [row()];
    const r = await new CustomerTriggerSource(db, 'STAGE', SINCE).findReady(10);
    expect(r).toEqual([
      {
        customerNo: '00005804',
        kycRefNo: 'K1',
        seqNo: 1, // the CIF revision (STTM_CUSTOMER.MOD_NO), not the KYC MOD_NO
        kycModNo: 2,
        customerType: 'INDIVIDUAL',
        stagingRows: 0,
        higherRows: 0,
      },
    ]);
    const c = db.calls[0];
    expect(c.kind).toBe('query');
    expect(c.sql).toMatch(/^\s*SELECT/);
    expect(c.sql).toContain('t.READY_TO_SCAN = :readyStatus');
    expect(c.sql).toContain('m.MAKER_DT_STAMP >= TO_DATE(:since');
    expect(c.sql).toContain("m.KYC_CUST_TYPE IN ('R')");
    expect(c.sql).toContain('JOIN STTM_CUSTOMER c ON c.CUSTOMER_NO = t.CUSTOMER_NO');
    expect(c.sql).toContain('s.SEQ_NO = c.MOD_NO');
    expect(c.sql).toContain('s.SEQ_NO > c.MOD_NO) AS HIGHER_ROWS');
    expect(c.binds).toMatchObject({ readyStatus: 'U', maxRows: 10 });
    expect(db.calls.every((x) => x.kind === 'query')).toBe(true);
  });

  it('takes corporates only when asked (proven type column), and reports a re-triggered revision', async () => {
    const db = new Db();
    db.rows = [row({ KYC_CUST_TYPE: 'C', STAGING_ROWS: 1 })];
    const r = await new CustomerTriggerSource(db, 'STAGE', SINCE).findReady(5, true);
    expect(db.calls[0].sql).toContain("IN ('R', 'C')");
    expect(r[0]).toMatchObject({ customerType: 'CORPORATE', stagingRows: 1 });
  });

  const ready = {
    customerNo: '00005804',
    kycRefNo: 'K1',
    seqNo: 1,
    kycModNo: 2,
    customerType: 'INDIVIDUAL' as const,
    stagingRows: 0,
    higherRows: 0,
  };

  it('refuses to write unless writeEnabled is passed explicitly', async () => {
    const db = new Db();
    const src = new CustomerTriggerSource(db, 'STAGE', SINCE);
    await expect(src.markPicked(ready)).rejects.toBeInstanceOf(TriggerWriteDisabledError);
    await expect(src.markError(ready)).rejects.toBeInstanceOf(TriggerWriteDisabledError);
    expect(db.calls).toHaveLength(0);
  });

  it('markError: U or P -> E, only while the CIF is still at the same revision', async () => {
    const db = new Db();
    expect(await new CustomerTriggerSource(db, 'STAGE', SINCE, true).markError(ready)).toBe(true);
    expect(db.calls[0].sql).toContain('SET READY_TO_SCAN = :errorStatus');
    expect(db.calls[0].sql).toContain('c.MOD_NO = :seqNo');
    expect(db.calls[0].binds).toMatchObject({
      errorStatus: 'E',
      readyStatus: 'U',
      pickedStatus: 'P',
      seqNo: 1,
    });
  });

  it('markPicked is one conditional UPDATE (only a row still at U), true only when exactly one row changed', async () => {
    const db = new Db();
    const src = new CustomerTriggerSource(db, 'STAGE', SINCE, true);
    expect(await src.markPicked(ready)).toBe(true);
    const c = db.calls[0];
    expect(c.kind).toBe('execute');
    expect(c.sql).toContain('SET READY_TO_SCAN = :pickedStatus');
    expect(c.sql).toContain('AND t.READY_TO_SCAN = :readyStatus');
    expect(c.sql).toContain('c.MOD_NO = :seqNo');
    expect(c.binds).toEqual({
      pickedStatus: 'P',
      customerNo: '00005804',
      kycRefNo: 'K1',
      readyStatus: 'U',
      seqNo: 1,
    });
    db.affected = 0;
    expect(await src.markPicked(ready)).toBe(false);
  });

  it('rejects an invalid cut-off or an unsafe staging table name', () => {
    expect(() => new CustomerTriggerSource(new Db(), 'STAGE', 'nope')).toThrow();
    expect(() => new CustomerTriggerSource(new Db(), 'X; DROP TABLE Y', SINCE)).toThrow();
  });
});
