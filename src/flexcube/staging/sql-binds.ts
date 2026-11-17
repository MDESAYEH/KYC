/**
 * Guard for named bind variables of the Oracle statements the integration layer issues.
 *
 * Why: Oracle rejects a bind variable named like a reserved word with ORA-01745 ("invalid
 * host/bind variable name"), e.g. `:from` or `:to`. UAT1 (17/11/2026) failed every claim UPDATE
 * (`SET PROCESS_STATUS = :to ... AND PROCESS_STATUS = :from`) with exactly that code. Mock
 * databases cannot reveal it, so every statement is checked before it reaches Oracle and in every
 * test double. Only names are ever reported, never values.
 */

/** Oracle reserved words (SQL Language Reference, "Oracle SQL Reserved Words"). */
export const ORACLE_RESERVED_WORDS: ReadonlySet<string> = new Set(
  (
    'ACCESS ADD ALL ALTER AND ANY AS ASC AUDIT BETWEEN BY CHAR CHECK CLUSTER COLUMN COLUMN_VALUE ' +
    'COMMENT COMPRESS CONNECT CREATE CURRENT DATE DECIMAL DEFAULT DELETE DESC DISTINCT DROP ELSE ' +
    'EXCLUSIVE EXISTS FILE FLOAT FOR FROM GRANT GROUP HAVING IDENTIFIED IMMEDIATE IN INCREMENT ' +
    'INDEX INITIAL INSERT INTEGER INTERSECT INTO IS LEVEL LIKE LOCK LONG MAXEXTENTS MINUS ' +
    'MLSLABEL MODE MODIFY NESTED_TABLE_ID NOAUDIT NOCOMPRESS NOT NOWAIT NULL NUMBER OF OFFLINE ON ' +
    'ONLINE OPTION OR ORDER PCTFREE PRIOR PUBLIC RAW RENAME RESOURCE REVOKE ROW ROWID ROWNUM ROWS ' +
    'SELECT SESSION SET SHARE SIZE SMALLINT START SUCCESSFUL SYNONYM SYSDATE TABLE THEN TO ' +
    'TRIGGER UID UNION UNIQUE UPDATE USER VALIDATE VALUES VARCHAR VARCHAR2 VIEW WHENEVER WHERE WITH'
  ).split(' '),
);

/** Raised BEFORE Oracle is called; a code defect, never a data problem. Names only. */
export class InvalidSqlBindsError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid SQL bind variables: ${problems.join('; ')}`);
    this.name = 'InvalidSqlBindsError';
  }
}

/** Removes '...' literals (with '' escapes) and comments so only real placeholders remain. */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/** Names of the named placeholders (:name) in the statement, in order, without duplicates. */
export function extractBindNames(sql: string): string[] {
  const names: string[] = [];
  for (const m of stripLiteralsAndComments(sql).matchAll(/(?<![:\w]):([A-Za-z][A-Za-z0-9_$#]*)/g)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/**
 * The statement's placeholders and the supplied bind keys must match exactly, and no placeholder
 * may be an Oracle reserved word.
 */
export function assertValidBinds(sql: string, binds: Record<string, unknown>): void {
  const placeholders = extractBindNames(sql);
  const keys = Object.keys(binds);
  const problems: string[] = [];
  for (const name of placeholders) {
    if (ORACLE_RESERVED_WORDS.has(name.toUpperCase())) {
      problems.push(`:${name} is an Oracle reserved word (ORA-01745)`);
    }
    if (!keys.includes(name)) problems.push(`:${name} has no value`);
  }
  for (const key of keys) {
    if (!placeholders.includes(key)) problems.push(`bind "${key}" is not used by the statement`);
  }
  if (problems.length > 0) throw new InvalidSqlBindsError(problems);
}
