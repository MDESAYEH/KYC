import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertValidBinds, ORACLE_RESERVED_WORDS } from '../flexcube/staging/sql-binds';
import { cifSourceDiscoveryQueries } from './cif-source-discovery';
import { statusContractDiscoveryQueries } from './status-contract-discovery';

/** The reserved words named in the review request (V$RESERVED_WORDS, RESERVED = 'Y', at least these). */
const REQUIRED_RESERVED =
  'ACCESS ADD ALL ALTER AND ANY AS ASC AUDIT BETWEEN BY CHAR CHECK CLUSTER COLUMN COMMENT COMPRESS CONNECT CREATE CURRENT DATE DECIMAL DEFAULT DELETE DESC DISTINCT DROP ELSE EXCLUSIVE EXISTS FILE FLOAT FOR FROM GRANT GROUP HAVING IDENTIFIED IMMEDIATE IN INCREMENT INDEX INITIAL INSERT INTEGER INTERSECT INTO IS LEVEL LIKE LOCK LONG MAXEXTENTS MINUS MODE MODIFY NOAUDIT NOCOMPRESS NOT NOWAIT NULL NUMBER OF OFFLINE ON ONLINE OPTION OR ORDER PCTFREE PRIOR PUBLIC RAW RENAME RESOURCE REVOKE ROW ROWID ROWNUM ROWS SELECT SESSION SET SHARE SIZE SMALLINT START SUCCESSFUL SYNONYM SYSDATE TABLE THEN TO TRIGGER UID UNION UNIQUE UPDATE USER VALIDATE VALUES VARCHAR VARCHAR2 VIEW WHENEVER WHERE WITH'.split(
    ' ',
  );

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const status = () => statusContractDiscoveryQueries({ owner: 'REIS_KYC' });
const cif = () => cifSourceDiscoveryQueries({ owner: null, table: null, nameFragment: 'CIF' });

describe('read-only discovery queries for UAT1', () => {
  it('the reserved-word list of the bind guard contains every word named in the review request', () => {
    const missing = REQUIRED_RESERVED.filter((w) => !ORACLE_RESERVED_WORDS.has(w));
    expect(missing).toEqual([]);
  });

  it.each([
    ['status contract', status],
    ['CIF source', cif],
  ])(
    '%s: every statement is a SELECT, has valid non-reserved binds that match, and cannot write',
    (_n, build) => {
      for (const q of build()) {
        expect(q.sql.trim()).toMatch(/^SELECT\b/i);
        expect(q.sql).not.toMatch(
          /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|GRANT|EXECUTE)\b\s/i,
        );
        expect(() => assertValidBinds(q.sql, q.binds)).not.toThrow();
      }
    },
  );

  it('collects every bind name used across all discovery SQL and checks them case-insensitively against the list', () => {
    const names = new Set<string>();
    for (const q of [...status(), ...cif()])
      Object.keys(q.binds).forEach((k) => names.add(k.toUpperCase()));
    expect(names.size).toBeGreaterThan(3);
    for (const name of names) expect(REQUIRED_RESERVED).not.toContain(name);
  });

  it('the status queries cover the column, CHECK constraints, triggers, their code, consumers and the DDL', () => {
    expect(status().map((q) => q.name)).toEqual([
      'statusColumn',
      'checkConstraints',
      'triggers',
      'triggerCodeMentioningTheColumns',
      'consumers',
      'consumerCodeMentioningTheStatus',
      'tableDdl',
      'statusDistribution',
    ]);
  });

  it('only exact upper-case owner names and validated table names are accepted; the table is never concatenated unvalidated', () => {
    expect(() => statusContractDiscoveryQueries({ owner: 'reis_kyc' })).toThrow('upper-case');
    expect(() => statusContractDiscoveryQueries({ owner: "X'; DROP TABLE Y--" })).toThrow();
    expect(() => statusContractDiscoveryQueries({ owner: 'A', table: 'T; DROP' })).toThrow();
    expect(() => statusContractDiscoveryQueries({ owner: 'A', table: 'S.T' })).toThrow(
      'separately',
    );
    expect(() => statusContractDiscoveryQueries({ owner: 'A', maxRows: 501 })).toThrow('maxRows');
  });

  it('the distribution query returns counts only', () => {
    const q = status().find((x) => x.name === 'statusDistribution')!;
    expect(q.sql).toContain('COUNT(*)');
    expect(q.sql).not.toMatch(/KYC_REF_NO|MSGID|REQUEST|RESPONSE/);
  });

  it('docs/uat1-readonly-discovery.sql contains exactly these statements (no drift between code and the file)', () => {
    const file = norm(
      readFileSync(join(__dirname, '..', '..', 'docs', 'uat1-readonly-discovery.sql'), 'utf8'),
    );
    for (const q of [...status(), ...cif()]) expect(file).toContain(norm(q.sql));
  });
});
