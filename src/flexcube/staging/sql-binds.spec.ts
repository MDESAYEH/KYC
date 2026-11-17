import {
  assertValidBinds,
  extractBindNames,
  InvalidSqlBindsError,
  ORACLE_RESERVED_WORDS,
} from './sql-binds';

describe('SQL bind variable guard (ORA-01745)', () => {
  it('rejects the exact UAT1 claim statement: :to and :from are Oracle reserved words', () => {
    const sql =
      'UPDATE T SET PROCESS_STATUS = :to, REQ_DATE = SYSDATE ' +
      'WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo AND PROCESS_STATUS = :from';
    expect(() => assertValidBinds(sql, { to: 'W', from: 'N', kycRefNo: 'K', seqNo: 1 })).toThrow(
      InvalidSqlBindsError,
    );
    try {
      assertValidBinds(sql, { to: 'W', from: 'N', kycRefNo: 'K', seqNo: 1 });
    } catch (e) {
      expect((e as InvalidSqlBindsError).problems).toEqual([
        ':to is an Oracle reserved word (ORA-01745)',
        ':from is an Oracle reserved word (ORA-01745)',
      ]);
    }
  });

  it('accepts safe names', () => {
    expect(() =>
      assertValidBinds('UPDATE T SET S = :targetStatus WHERE S = :sourceStatus', {
        targetStatus: 'W',
        sourceStatus: 'N',
      }),
    ).not.toThrow();
  });

  it('reports a placeholder without a value and a bind that the statement does not use', () => {
    const e = (() => {
      try {
        assertValidBinds('SELECT 1 FROM DUAL WHERE A = :a AND B = :b', { a: 1, c: 2 });
      } catch (err) {
        return err as InvalidSqlBindsError;
      }
      throw new Error('expected an error');
    })();
    expect(e.problems).toEqual([':b has no value', 'bind "c" is not used by the statement']);
  });

  it('the same placeholder used twice needs one value', () => {
    expect(() => assertValidBinds('X = :k AND Y = :k', { k: 1 })).not.toThrow();
    expect(extractBindNames('X = :k AND Y = :k')).toEqual(['k']);
  });

  it('ignores colons inside string literals, comments and :: sequences', () => {
    const sql = `SELECT 1 FROM DUAL WHERE D >= TO_DATE(:since, 'YYYY-MM-DD"T"HH24:MI:SS') -- :ignored
      AND X = 'it''s :not_a_bind' /* :nor_this */ AND REGEXP_LIKE(M, '^[0-9a-f]{8}-[0-9a-f]{4}$', 'i')`;
    expect(extractBindNames(sql)).toEqual(['since']);
  });

  it('never puts values in the message', () => {
    try {
      assertValidBinds('A = :from', { from: 'SECRET-VALUE' });
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRET-VALUE');
    }
  });

  it('knows the words that broke or could break statements here', () => {
    for (const w of ['FROM', 'TO', 'IN', 'SET', 'WHERE', 'DATE', 'LEVEL', 'USER']) {
      expect(ORACLE_RESERVED_WORDS.has(w)).toBe(true);
    }
    // not reserved: these names are fine as bind variables
    for (const w of ['STATUS', 'REQUEST', 'RESPONSE', 'SINCE', 'MINUTES']) {
      expect(ORACLE_RESERVED_WORDS.has(w)).toBe(false);
    }
  });
});
