import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertValidBinds } from '../flexcube/staging/sql-binds';
import { runReadOnlyDiscovery } from './readonly-discovery';
import { accessDiscoveryQueries, keypersonDiscoveryQueries } from './keyperson-access-discovery';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const all = () => [
  ...keypersonDiscoveryQueries({ owner: 'OBPPRD' }),
  ...accessDiscoveryQueries({}),
];

describe('key-person type and access discovery (read-only)', () => {
  it('every statement is a plain SELECT with valid binds', () => {
    for (const q of all()) {
      expect(q.sql.trim()).toMatch(/^SELECT\b/i);
      expect(q.sql).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|GRANT)\b/i,
      );
      expect(() => assertValidBinds(q.sql, q.binds)).not.toThrow();
    }
  });

  it('returns counts and dictionary metadata only: no name / document column is selected', () => {
    for (const q of keypersonDiscoveryQueries({ owner: 'OBPPRD' })) {
      expect(q.sql).not.toMatch(
        /\b(FIRST_NAME|LAST_NAME|PASSPORT|NATIONAL_ID|DATE_OF_BIRTH|TIN)\b/,
      );
    }
  });

  it('the type is read from the CUSTOM table and OWNERSHIP_TYPE appears only in the evidence cross-tab', () => {
    const qs = keypersonDiscoveryQueries({ owner: 'OBPPRD' });
    expect(qs.find((q) => q.name === 'keypersonTypeValues')!.sql).toContain(
      'OBPPRD.STTM_KYC_CORP_KEYPERSONS_CUSTOM',
    );
    const withOwnership = qs.filter((q) => q.sql.includes('OWNERSHIP_TYPE')).map((q) => q.name);
    expect(withOwnership).toEqual(['keypersonTypeVersusOwnershipType']);
  });

  it('refuses an unsafe owner or row limit', () => {
    expect(() => keypersonDiscoveryQueries({ owner: "X'; DROP TABLE Y--" })).toThrow();
    expect(() => keypersonDiscoveryQueries({ owner: 'obpprd' })).toThrow('upper-case');
    expect(() => accessDiscoveryQueries({ maxRows: 501 })).toThrow('maxRows');
  });

  it('docs/uat1-readonly-discovery.sql contains these statements (no drift)', () => {
    const file = norm(
      readFileSync(join(__dirname, '..', '..', 'docs', 'uat1-readonly-discovery.sql'), 'utf8'),
    );
    for (const q of all()) expect(file).toContain(norm(q.sql));
  });

  it('the runner executes both parts with SELECTs only and isolates a failing query by Oracle code', async () => {
    const seen: string[] = [];
    const db = {
      query: (sql: string) => {
        seen.push(sql);
        if (sql.includes('DBA_OBJECTS'))
          return Promise.reject(new Error('ORA-00942: table or view does not exist'));
        return Promise.resolve([]);
      },
      execute: () => Promise.reject(new Error('must not write')),
    };
    const kp = await runReadOnlyDiscovery(db as never, { part: 'keyperson', owner: 'OBPPRD' });
    const ac = await runReadOnlyDiscovery(db as never, { part: 'access' });
    expect(kp.queries).toHaveLength(4);
    expect(ac.queries.find((q) => q.name === 'access:dbaCustomerObjects')?.error).toBe('ORA-00942');
    expect(ac.queries.filter((q) => !q.error)).toHaveLength(2);
    expect(seen.every((s) => /^\s*SELECT/i.test(s))).toBe(true);
  });
});
