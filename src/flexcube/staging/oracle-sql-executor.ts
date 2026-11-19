import { OnModuleDestroy } from '@nestjs/common';
import type { Pool } from 'oracledb';
import { IFlexcubeSqlExecutor, SqlBinds, SqlRow } from './flexcube-staging';
import { assertValidBinds } from './sql-binds';

export interface FlexcubeDbConfig {
  readonly user: string;
  readonly password: string;
  /** Easy Connect string, e.g. host:1521/SERVICE. */
  readonly connectString: string;
  /**
   * Optional schema owning the FLEXCUBE tables (e.g. FCUBS) when the integration user has no
   * synonyms: set as CURRENT_SCHEMA on every pooled session. Validated as a plain identifier.
   */
  readonly schema?: string;
}

/** A plain Oracle identifier only (letters, digits, _ $ #), never anything else. */
export function assertSafeSchema(schema: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_$#]{0,127}$/.test(schema)) {
    throw new Error('FLEXCUBE_DB_SCHEMA is not a valid Oracle schema name');
  }
  return schema;
}

/**
 * Statements that may be handed to Oracle's parser without any risk. getStatementInfo() only
 * parses SELECT / WITH / INSERT / UPDATE (no row is read or changed), but Oracle EXECUTES DDL
 * during that call, and PL/SQL, MERGE or DELETE have no place in this integration: refused here.
 */
const PARSE_ONLY_ALLOWED = /^\s*(SELECT|WITH|INSERT|UPDATE)\b/i;

export class ParseOnlyRefusedError extends Error {
  constructor() {
    super(
      'Only SELECT, WITH, INSERT or UPDATE statements can be parsed (no DDL / PL/SQL / DELETE)',
    );
    this.name = 'ParseOnlyRefusedError';
  }
}

export interface StatementInfo {
  /** Bind names exactly as Oracle's parser sees them (upper-case). */
  bindNames: string[];
  /** oracledb.STMT_TYPE_* code. */
  statementType: number;
}

/** Guard for describe(): exported for unit tests. */
export function assertParseOnly(sql: string): void {
  if (!PARSE_ONLY_ALLOWED.test(sql) || /;\s*\S/.test(sql)) throw new ParseOnlyRefusedError();
}

/**
 * node-oracledb (Thin mode: no Oracle Client install needed) with a small lazy pool.
 * Every statement is committed on its own (autoCommit). Credentials are never logged.
 */
export class OracleSqlExecutor implements IFlexcubeSqlExecutor, OnModuleDestroy {
  private pool: Promise<Pool> | null = null;

  constructor(private readonly config: FlexcubeDbConfig) {
    if (config.schema !== undefined) assertSafeSchema(config.schema);
  }

  private getPool(): Promise<Pool> {
    if (!this.pool) {
      this.pool = import('oracledb').then((oracledb) =>
        oracledb.default.createPool({
          user: this.config.user,
          password: this.config.password,
          connectString: this.config.connectString,
          poolMin: 0,
          poolMax: 4,
          ...(this.config.schema
            ? {
                sessionCallback: (
                  conn: import('oracledb').Connection,
                  _tag: string,
                  done: (err?: Error) => void,
                ) => {
                  conn
                    .execute(`ALTER SESSION SET CURRENT_SCHEMA = ${this.config.schema}`)
                    .then(() => done(), done);
                },
              }
            : {}),
        }),
      );
      // A failed pool creation is not cached: the next call tries again.
      this.pool.catch(() => (this.pool = null));
    }
    return this.pool;
  }

  async execute(sql: string, binds: SqlBinds): Promise<{ rowsAffected: number }> {
    assertValidBinds(sql, binds); // before Oracle: reserved-word names give ORA-01745
    const conn = await (await this.getPool()).getConnection();
    try {
      const res = await conn.execute(sql, binds, { autoCommit: true });
      return { rowsAffected: res.rowsAffected ?? 0 };
    } finally {
      await conn.close();
    }
  }

  async query(sql: string, binds: SqlBinds): Promise<SqlRow[]> {
    assertValidBinds(sql, binds);
    const oracledb = (await import('oracledb')).default;
    const conn = await (await this.getPool()).getConnection();
    try {
      const res = await conn.execute<SqlRow>(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        // CLOB / NCLOB columns come back as plain strings.
        fetchTypeHandler: (meta) =>
          meta.dbType === oracledb.DB_TYPE_CLOB || meta.dbType === oracledb.DB_TYPE_NCLOB
            ? { type: oracledb.STRING }
            : undefined,
      });
      return res.rows ?? [];
    } finally {
      await conn.close();
    }
  }

  /** All statements share one connection. A lost commit acknowledgement is in-doubt, never retried here. */
  async transaction<T>(work: (db: IFlexcubeSqlExecutor) => Promise<T>): Promise<T> {
    const oracle = (await import('oracledb')).default;
    const conn = await (await this.getPool()).getConnection();
    const session: IFlexcubeSqlExecutor = {
      query: async (sql, binds) => {
        assertValidBinds(sql, binds);
        const result = await conn.execute<SqlRow>(sql, binds, {
          autoCommit: false,
          outFormat: oracle.OUT_FORMAT_OBJECT,
          fetchTypeHandler: (meta) =>
            meta.dbType === oracle.DB_TYPE_CLOB || meta.dbType === oracle.DB_TYPE_NCLOB
              ? { type: oracle.STRING }
              : undefined,
        });
        return result.rows ?? [];
      },
      execute: async (sql, binds) => {
        assertValidBinds(sql, binds);
        if (!/^\s*(INSERT|UPDATE)\b/i.test(sql)) throw Error('RESUME_TRANSACTION_DML_ONLY');
        const result = await conn.execute(sql, binds, { autoCommit: false });
        return { rowsAffected: result.rowsAffected ?? 0 };
      },
    };
    try {
      const result = await work(session);
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      await conn.close();
    }
  }

  /**
   * PARSE ONLY: asks Oracle to parse the statement (connection.getStatementInfo) and returns the
   * bind names its parser found, WITHOUT executing it: no row is read, inserted or updated, and
   * nothing is committed. A reserved-word bind (ORA-01745), an unknown column (ORA-00904) or a
   * missing privilege / object (ORA-00942) is raised as the Oracle error. Used by the read-only
   * `check:oracle-sql` tool on UAT1.
   */
  async describe(sql: string): Promise<StatementInfo> {
    assertParseOnly(sql);
    const conn = await (await this.getPool()).getConnection();
    try {
      const info = await conn.getStatementInfo(sql);
      return {
        bindNames: (info.bindNames ?? []).map((n) => n.toUpperCase()),
        statementType: info.statementType ?? -1,
      };
    } finally {
      await conn.close();
    }
  }

  /** Idempotent: a second call (or a pool that never opened) is a no-op. */
  async onModuleDestroy(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (!pool) return;
    try {
      await (await pool).close(5);
    } catch {
      // already closed, or the pool never opened (e.g. unreachable host)
    }
  }
}
