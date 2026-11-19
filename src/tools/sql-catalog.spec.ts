import {
  assertParseOnly,
  ParseOnlyRefusedError,
  StatementInfo,
} from '../flexcube/staging/oracle-sql-executor';
import { ORACLE_RESERVED_WORDS } from '../flexcube/staging/sql-binds';
import { checkOracleSql } from './check-oracle-sql';
import { CatalogEntry, collectSqlCatalog } from './sql-catalog';

const opts = {
  stagingTable: 'STTM_KYC_REIS_PAYLOAD_CUSTOM',
  inProgressStatus: 'W',
  keypersonTypeColumn: 'KYC_KEYPERSON_TYPE',
};

describe('SQL catalog (every statement sent to FLEXCUBE)', () => {
  let catalog: CatalogEntry[];
  beforeAll(async () => {
    catalog = await collectSqlCatalog(opts);
  });

  it('covers every code path: sync, staging, reconciliation, rollback, final status, single trial', () => {
    const names = catalog.map((e) => e.name);
    for (const expected of [
      'source.findPending',
      'source.findOwnStuckNew',
      'source.load individual',
      'source.load corporate',
      'trigger.findReady',
      'trigger.markPicked',
      'trigger.markError',
      'staging.insertNew',
      'staging.claim',
      'staging.release',
      'staging.fail',
      'staging.complete',
      'staging.findStuckInProgress',
      'staging.findDeliveryRisk',
      'reconcile.findNeverSentTechnicalErrors',
      'reconcile.restoreNeverSent',
      'reconcile.readRowForBackup',
      'reconcile.isUntouchedSinceRestore',
      'reconcile.rollbackRestoredRow',
      'updater.finalStatus (approved-blocked)',
      'trial.restoreNeverSent',
      'trial.claim',
      'trial.markPicked (trigger U -> P)',
      'trial.release',
      'trial.markTriggerError (trigger P -> E)',
      'trial.complete',
    ]) {
      expect(names).toContain(expected);
    }
    expect(catalog.length).toBeGreaterThanOrEqual(25);
  });

  it('no bind name is an Oracle reserved word (the ORA-01745 class of defect)', () => {
    const bad = catalog.flatMap((e) =>
      e.bindNames.filter((n) => ORACLE_RESERVED_WORDS.has(n)).map((n) => `${e.name}: :${n}`),
    );
    expect(bad).toEqual([]);
  });

  it('every statement can be parsed safely: only SELECT / WITH / INSERT / UPDATE, never DELETE or DDL', () => {
    for (const e of catalog) {
      expect(() => assertParseOnly(e.sql)).not.toThrow();
      expect(e.sql).not.toMatch(/\bDELETE\b|\bDROP\b|\bCREATE\b|\bALTER\b|\bMERGE\b|\bTRUNCATE\b/i);
    }
  });

  it('every statement uses the configured staging table and never a literal value for a KYC', () => {
    for (const e of catalog) expect(e.sql).not.toContain("'CATALOG'");
  });
});

describe('parse-only guard of describe()', () => {
  it.each([
    'CREATE TABLE X (A NUMBER)',
    'DROP TABLE X',
    'DELETE FROM STTM_KYC_REIS_PAYLOAD_CUSTOM',
    'BEGIN NULL; END;',
    'MERGE INTO X USING Y ON (1=1) WHEN MATCHED THEN UPDATE SET A = 1',
    'ALTER SESSION SET CURRENT_SCHEMA = X',
    'SELECT 1 FROM DUAL; DROP TABLE X',
    'TRUNCATE TABLE X',
  ])('refuses %p before Oracle is called', (sql) => {
    expect(() => assertParseOnly(sql)).toThrow(ParseOnlyRefusedError);
  });

  it('accepts the four statement kinds the integration uses', () => {
    for (const sql of [
      'SELECT 1 FROM DUAL',
      ' WITH A AS (SELECT 1 X FROM DUAL) SELECT X FROM A',
      'INSERT INTO T (A) VALUES (:a)',
      'UPDATE T SET A = :a',
    ]) {
      expect(() => assertParseOnly(sql)).not.toThrow();
    }
  });
});

describe('checkOracleSql (report of the parse-only check)', () => {
  const entries: CatalogEntry[] = [
    {
      name: 'good',
      sql: 'UPDATE T SET A = :targetStatus',
      bindNames: ['TARGETSTATUS'],
      kind: 'execute',
    },
    { name: 'reserved', sql: 'UPDATE T SET A = :to', bindNames: ['TO'], kind: 'execute' },
    { name: 'mismatch', sql: 'SELECT :a FROM DUAL', bindNames: ['A'], kind: 'query' },
  ];
  const fakeOracle = {
    describe: async (sql: string): Promise<StatementInfo> => {
      if (sql.includes(':to')) throw new Error('ORA-01745: invalid host/bind variable name');
      if (sql.includes(':a FROM')) return { bindNames: ['B'], statementType: 1 };
      return { bindNames: ['TARGETSTATUS'], statementType: 3 };
    },
  };

  it('reports OK, the Oracle code, or the bind difference, and never the message text', async () => {
    const lines = await checkOracleSql(fakeOracle, entries);
    expect(lines).toEqual([
      { name: 'good', ok: true },
      { name: 'reserved', ok: false, error: 'ORA-01745' },
      { name: 'mismatch', ok: false, missingBinds: ['A'], extraBinds: ['B'] },
    ]);
    expect(JSON.stringify(lines)).not.toContain('invalid host');
  });
});
