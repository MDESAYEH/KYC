import { assertValidBinds } from '../flexcube/staging/sql-binds';
import { cifSourceDiscoveryQueries } from './cif-source-discovery';

describe('CIF discovery query preparation (no Oracle execution)', () => {
  it.each(['CIF', 'CUSTOMER', 'KYC', "' OR 1=1 --"])('binds the search term %s', (term) => {
    for (const query of cifSourceDiscoveryQueries({
      owner: null,
      table: null,
      nameFragment: term,
    })) {
      expect(() => assertValidBinds(query.sql, query.binds)).not.toThrow();
      expect(query.sql.trim()).toMatch(/^SELECT\b/);
      expect(query.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
      expect(query.sql).not.toMatch(/STTM_|STVW_|STTB_/);
      expect(query.binds.maxRows).toBe(100);
    }
    const columns = cifSourceDiscoveryQueries({
      owner: 'KNOWN_OWNER',
      table: 'KNOWN_TABLE',
      nameFragment: term,
    })[0];
    expect(columns.binds).toMatchObject({
      ownerName: 'KNOWN_OWNER',
      tableName: 'KNOWN_TABLE',
      nameFragment: term,
    });
    expect(columns.sql).not.toContain('KNOWN_OWNER');
    expect(columns.sql).not.toContain('KNOWN_TABLE');
  });

  it('matches composite foreign keys by owner, constraint and position', () => {
    const query = cifSourceDiscoveryQueries({ owner: null, table: null, nameFragment: 'CIF' })[2];
    expect(query.sql).toContain('pc.POSITION = fc.POSITION');
    expect(query.sql).toContain('pk.OWNER = fk.R_OWNER');
  });

  it.each([0, -1, 501, 1.5, NaN])('rejects an unbounded/invalid limit %s', (maxRows) => {
    expect(() =>
      cifSourceDiscoveryQueries({ owner: null, table: null, nameFragment: 'CIF', maxRows }),
    ).toThrow();
  });
});
