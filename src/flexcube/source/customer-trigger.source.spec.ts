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
  MOD_NO: 2,
  KYC_CUST_TYPE: 'R',
  STAGING_ROWS: 0,
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
        seqNo: 2,
        customerType: 'INDIVIDUAL',
        stagingRows: 0,
      },
    ]);
    const c = db.calls[0];
    expect(c.kind).toBe('query');
    expect(c.sql).toMatch(/^\s*SELECT/);
    expect(c.sql).toContain('t.READY_TO_SCAN = :readyStatus');
    expect(c.sql).toContain('m.MAKER_DT_STAMP >= TO_DATE(:since');
    expect(c.sql).toContain("m.KYC_CUST_TYPE IN ('R')");
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

  it('refuses to write unless writeEnabled is passed explicitly', async () => {
    const db = new Db();
    await expect(
      new CustomerTriggerSource(db, 'STAGE', SINCE).markPicked('C1', 'K1'),
    ).rejects.toBeInstanceOf(TriggerWriteDisabledError);
    expect(db.calls).toHaveLength(0);
  });

  it('markPicked is one conditional UPDATE (only a row still at U), true only when exactly one row changed', async () => {
    const db = new Db();
    const src = new CustomerTriggerSource(db, 'STAGE', SINCE, true);
    expect(await src.markPicked('00005804', 'K1')).toBe(true);
    const c = db.calls[0];
    expect(c.kind).toBe('execute');
    expect(c.sql).toContain('SET READY_TO_SCAN = :pickedStatus');
    expect(c.sql).toContain('AND READY_TO_SCAN = :readyStatus');
    expect(c.binds).toEqual({
      pickedStatus: 'P',
      customerNo: '00005804',
      kycRefNo: 'K1',
      readyStatus: 'U',
    });
    db.affected = 0;
    expect(await src.markPicked('00005804', 'K1')).toBe(false);
  });

  it('rejects an invalid cut-off or an unsafe staging table name', () => {
    expect(() => new CustomerTriggerSource(new Db(), 'STAGE', 'nope')).toThrow();
    expect(() => new CustomerTriggerSource(new Db(), 'X; DROP TABLE Y', SINCE)).toThrow();
  });
});
