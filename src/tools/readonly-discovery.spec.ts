import { IFlexcubeSqlExecutor, SqlBinds, SqlRow } from '../flexcube/staging/flexcube-staging';
import { assertValidBinds } from '../flexcube/staging/sql-binds';
import {
  assertReadOnlySelect,
  resolveStagingOwner,
  runReadOnlyDiscovery,
} from './readonly-discovery';

/** Records every statement; any execute() (a write) fails the test. Rows are dictionary metadata only. */
class RecordingOracle implements IFlexcubeSqlExecutor {
  statements: { sql: string; binds: SqlBinds }[] = [];
  failWith: Record<string, string> = {};
  tableIsOwn = true;
  async execute(): Promise<{ rowsAffected: number }> {
    throw new Error('the discovery must never write');
  }
  async query(sql: string, binds: SqlBinds): Promise<SqlRow[]> {
    assertValidBinds(sql, binds);
    this.statements.push({ sql, binds });
    for (const [needle, code] of Object.entries(this.failWith)) {
      if (sql.includes(needle)) throw new Error(`${code}: message with SECRET detail`);
    }
    if (sql.includes('FROM ALL_TABLES')) return this.tableIsOwn ? [{ OWNER_NAME: 'REIS_KYC' }] : [];
    if (sql.includes('ALL_SYNONYMS') && sql.includes('SYNONYM_NAME = :tableName'))
      return [{ TABLE_OWNER: 'FCUBS' }];
    if (sql.includes("CONSTRAINT_TYPE = 'C'")) {
      return [{ CONSTRAINT_NAME: 'CK_X', STATUS: 'ENABLED', SEARCH_CONDITION: "S IN ('N','W')" }];
    }
    if (sql.includes('GROUP BY REIS_FINAL_STATUS')) return [{ REIS_FINAL_STATUS: 'BLOCKED', N: 1 }];
    return [{ SOME: new Date('2026-11-17T00:00:00Z') }];
  }
}

describe('read-only discovery runner', () => {
  let db: RecordingOracle;
  beforeEach(() => void (db = new RecordingOracle()));

  describe('assertReadOnlySelect', () => {
    it('accepts a plain SELECT and refuses everything that could change anything', () => {
      expect(() => assertReadOnlySelect('SELECT 1 FROM DUAL')).not.toThrow();
      for (const bad of [
        'UPDATE T SET A = 1',
        'DELETE FROM T',
        'INSERT INTO T VALUES (1)',
        'MERGE INTO T USING D ON (1=1) WHEN MATCHED THEN UPDATE SET A = 1',
        'CREATE TABLE X (A NUMBER)',
        'DROP TABLE X',
        'ALTER SESSION SET CURRENT_SCHEMA = X',
        'TRUNCATE TABLE X',
        'GRANT SELECT ON X TO Y',
        'COMMIT',
        'BEGIN NULL; END;',
        'CALL PROC()',
        'SELECT * FROM T FOR UPDATE',
        'LOCK TABLE T IN EXCLUSIVE MODE',
        'SELECT 1 FROM DUAL; DROP TABLE X',
        'SELECT A INTO V FROM T',
        '  explain plan for select 1 from dual',
      ]) {
        expect(() => assertReadOnlySelect(bad)).toThrow('Refused');
      }
    });
  });

  it('CIF part: runs ONLY the column search, once per fragment, with owner and table unset', async () => {
    const report = await runReadOnlyDiscovery(db, { part: 'cif' });
    expect(report.queries.map((q) => q.name)).toEqual([
      'cif:columns:CIF',
      'cif:columns:CUSTOMER',
      'cif:columns:KYC',
    ]);
    expect(db.statements.map((s) => s.binds.nameFragment)).toEqual(['CIF', 'CUSTOMER', 'KYC']);
    expect(
      db.statements.every((s) => s.binds.ownerName === null && s.binds.tableName === null),
    ).toBe(true);
  });

  it('CIF part, second pass: keys, foreign keys and synonyms of ONE exact candidate', async () => {
    const report = await runReadOnlyDiscovery(db, {
      part: 'cif',
      candidateOwner: 'FCUBS',
      candidateTable: 'STTM_CUSTOMER',
    });
    expect(report.queries.map((q) => q.name)).toEqual([
      'cif:keys',
      'cif:foreignKeys',
      'cif:synonyms',
    ]);
    expect(
      db.statements.every(
        (s) => s.binds.ownerName === 'FCUBS' && s.binds.tableName === 'STTM_CUSTOMER',
      ),
    ).toBe(true);
  });

  it('status part: resolves the owner (own table, else the synonym target) and runs the eight statements', async () => {
    const report = await runReadOnlyDiscovery(db, { part: 'status' });
    expect(report.resolvedOwner).toBe('REIS_KYC');
    expect(report.queries.map((q) => q.name)).toEqual([
      'status:statusColumn',
      'status:checkConstraints',
      'status:triggers',
      'status:triggerCodeMentioningTheColumns',
      'status:consumers',
      'status:consumerCodeMentioningTheStatus',
      'status:tableDdl',
      'status:statusDistribution',
    ]);
    db.tableIsOwn = false;
    expect(await resolveStagingOwner(db, 'STTM_KYC_REIS_PAYLOAD_CUSTOM')).toBe('FCUBS');
  });

  it('an explicit owner is used as given; an unresolvable owner is reported, nothing guessed', async () => {
    const explicit = await runReadOnlyDiscovery(db, { part: 'status', owner: 'FCUBS' });
    expect(explicit.resolvedOwner).toBe('FCUBS');
    expect(db.statements.some((s) => s.sql.includes('ALL_TABLES'))).toBe(false);
    const lost = new RecordingOracle();
    lost.query = async () => [];
    const report = await runReadOnlyDiscovery(lost, { part: 'status' });
    expect(report.queries).toEqual([
      expect.objectContaining({
        name: 'status:resolveOwner',
        error: 'OWNER_NOT_RESOLVED_PASS_--owner',
      }),
    ]);
  });

  it('EVERY statement issued is a read-only SELECT, with valid binds; nothing is ever written or committed', async () => {
    await runReadOnlyDiscovery(db, { part: 'all', owner: 'REIS_KYC' });
    expect(db.statements.length).toBeGreaterThan(8);
    for (const s of db.statements) expect(() => assertReadOnlySelect(s.sql)).not.toThrow();
  });

  it('one failing query (e.g. ORA-31603 on the DDL) is recorded by its code only; the others still run', async () => {
    db.failWith = { 'DBMS_METADATA.GET_DDL': 'ORA-31603' };
    const report = await runReadOnlyDiscovery(db, { part: 'status', owner: 'REIS_KYC' });
    const ddl = report.queries.find((q) => q.name === 'status:tableDdl')!;
    expect(ddl.error).toBe('ORA-31603');
    expect(report.queries.filter((q) => !q.error)).toHaveLength(7);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('rows are JSON-safe, and the report carries only non-secret binds', async () => {
    const report = await runReadOnlyDiscovery(
      db,
      { part: 'cif', fragments: ['CIF'] },
      () => new Date('2026-11-17T12:00:00Z'),
    );
    expect(report.generatedAt).toBe('2026-11-17T12:00:00.000Z');
    expect(report.queries[0].rows[0]).toEqual({ SOME: '2026-11-17T00:00:00.000Z' });
    expect(Object.keys(report.queries[0].binds).sort()).toEqual([
      'maxRows',
      'nameFragment',
      'ownerName',
      'tableName',
    ]);
  });

  it('a refused (non-SELECT) statement never reaches Oracle', async () => {
    expect(() => assertReadOnlySelect('UPDATE T SET A = 1')).toThrow();
    expect(db.statements).toEqual([]);
  });
});
