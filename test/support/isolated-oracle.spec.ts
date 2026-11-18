import { assertDisposableDatabase, connectHost, isolatedOracleConfig } from './isolated-oracle';

const P = 'KYC_X';
const base = {
  KYC_X_USER: 'TESTER',
  KYC_X_PASSWORD: 'pw',
  KYC_X_CONNECT: 'localhost:1521/FREEPDB1',
  KYC_X_CONFIRM: 'GO',
};

describe('isolated Oracle test guard', () => {
  it('is simply off (null) unless the exact confirmation and all values are set', () => {
    expect(isolatedOracleConfig(P, 'GO', {})).toBeNull();
    expect(isolatedOracleConfig(P, 'GO', { ...base, KYC_X_CONFIRM: 'yes' })).toBeNull();
    expect(isolatedOracleConfig(P, 'GO', { ...base, KYC_X_PASSWORD: '' })).toBeNull();
  });

  it('accepts a local disposable database', () => {
    expect(isolatedOracleConfig(P, 'GO', base)).toEqual({
      user: 'TESTER',
      password: 'pw',
      connectString: 'localhost:1521/FREEPDB1',
    });
  });

  it('parses EZConnect hosts', () => {
    expect(connectHost('//Host.Example:1521/S')).toBe('host.example');
    expect(connectHost('[::1]:1521/S')).toBe('::1');
    expect(connectHost('db1/SVC')).toBe('db1');
  });

  it('refuses a host that is not on the allow list, even with the confirmation', () => {
    expect(() =>
      isolatedOracleConfig(P, 'GO', { ...base, KYC_X_CONNECT: 'uat1-db.bank.example:1521/X' }),
    ).toThrow('allow list');
  });

  it('refuses bank / system users and the application own connection', () => {
    for (const u of ['REIS_KYC', 'obpprd', 'SYSTEM'])
      expect(() => isolatedOracleConfig(P, 'GO', { ...base, KYC_X_USER: u })).toThrow('bank');
    expect(() =>
      isolatedOracleConfig(P, 'GO', {
        ...base,
        FLEXCUBE_DB_CONNECT_STRING: 'LOCALHOST:1521/freepdb1',
      }),
    ).toThrow('application FLEXCUBE connection');
    expect(() => isolatedOracleConfig(P, 'GO', { ...base, FLEXCUBE_DB_USER: 'tester' })).toThrow(
      'application FLEXCUBE user',
    );
  });

  it('has NO environment override: an inherited variable can never admit a non-loopback host', () => {
    const env = {
      ...base,
      KYC_X_CONNECT: 'uat1-oracle:1521/X',
      KYC_ORACLE_ISOLATED_HOST_ALLOW: 'uat1-oracle',
    };
    expect(() => isolatedOracleConfig(P, 'GO', env)).toThrow('allow list');
  });

  describe('assertDisposableDatabase (stops an SSH tunnel to a bank database that looks like localhost)', () => {
    const db = (objects: number, ctx: Record<string, unknown>) => ({
      query: async (sql: string) => (sql.includes('COUNT(*)') ? [{ N: objects }] : [ctx]),
    });
    it('accepts an empty disposable database', async () => {
      await expect(
        assertDisposableDatabase(db(0, { DB: 'FREE', SVC: 'FREEPDB1', CUR: 'KYC_TEST' })),
      ).resolves.toBeUndefined();
    });
    it('refuses a database with FLEXCUBE objects even on localhost (tunnel)', async () => {
      await expect(
        assertDisposableDatabase(db(40, { DB: 'FREE', SVC: 'FREEPDB1', CUR: 'KYC_TEST' })),
      ).rejects.toThrow('FLEXCUBE objects');
    });
    it('refuses bank-looking database / service names and bank users', async () => {
      for (const ctx of [
        { DB: 'FCUBSUAT', SVC: 'X', CUR: 'T' },
        { DB: 'FREE', SVC: 'obp_prod', CUR: 'T' },
        { DB: 'FREE', SVC: 'FREEPDB1', CUR: 'OBPPRD' },
      ])
        await expect(assertDisposableDatabase(db(0, ctx))).rejects.toThrow('bank');
    });
    it('is fail-closed: when the checks cannot run, the database is not accepted', async () => {
      await expect(
        assertDisposableDatabase({
          query: async () => {
            throw new Error('ORA-00942');
          },
        }),
      ).rejects.toThrow('could not run');
      await expect(assertDisposableDatabase({ query: async () => [{ N: 'x' }] })).rejects.toThrow();
    });
  });
});
