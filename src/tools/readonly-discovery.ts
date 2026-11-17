import { IFlexcubeSqlExecutor, SqlBinds } from '../flexcube/staging/flexcube-staging';
import { oraCode } from '../flexcube/oracle-error';
import { assertValidBinds } from '../flexcube/staging/sql-binds';
import { cifSourceDiscoveryQueries } from './cif-source-discovery';
import { statusContractDiscoveryQueries } from './status-contract-discovery';

/**
 * Runs the prepared READ-ONLY discovery queries (docs/uat1-readonly-discovery.sql) with the executor and
 * the configuration the application already has: no extra software, no setting changed, no service touched.
 *
 * Safety, enforced here and tested: only statements that start with SELECT and contain no DML/DDL/lock
 * keyword are executed (anything else throws BEFORE reaching Oracle); binds are validated by the Oracle
 * bind guard; one failing query is recorded by its Oracle code only and does not stop the others; nothing
 * is committed (query() issues SELECTs only). The report can hold trigger / consumer SOURCE lines and
 * dictionary metadata, never customer data, and is written by the CLI to a new protected file.
 */
export interface DiscoveryOptions {
  part: 'cif' | 'status' | 'all';
  /** Exact upper-case owner of the staging table; resolved from the current session when absent. */
  owner?: string;
  table?: string;
  /** Candidate-name fragments for the CIF column search (default CIF, CUSTOMER, KYC). */
  fragments?: string[];
  /** Run the key / foreign-key / synonym queries for ONE exact CIF candidate (owner + table). */
  candidateOwner?: string;
  candidateTable?: string;
  maxRows?: number;
}

export interface DiscoveryQueryResult {
  name: string;
  /** Non-secret binds only: owner, table, fragment, limits. */
  binds: SqlBinds;
  rowCount: number;
  rows: Record<string, unknown>[];
  /** Oracle / driver code only (e.g. ORA-31603), never the message. */
  error?: string;
}

export interface DiscoveryReport {
  generatedAt: string;
  part: DiscoveryOptions['part'];
  resolvedOwner: string | null;
  queries: DiscoveryQueryResult[];
}

const FORBIDDEN =
  /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|COMMIT|ROLLBACK|LOCK|EXECUTE|EXEC|CALL|INTO)\b|FOR\s+UPDATE|;/i;

/** A statement that could change anything is refused before it reaches Oracle. */
export function assertReadOnlySelect(sql: string): void {
  const clean = sql.trim().replace(/;$/, '');
  if (!/^SELECT\b/i.test(clean) || FORBIDDEN.test(clean)) {
    throw new Error('Refused: only a plain read-only SELECT may run');
  }
}

const jsonSafe = (rows: Record<string, unknown>[]) =>
  rows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
    ),
  );

async function run(
  db: IFlexcubeSqlExecutor,
  name: string,
  sql: string,
  binds: SqlBinds,
): Promise<DiscoveryQueryResult> {
  assertReadOnlySelect(sql);
  assertValidBinds(sql, binds);
  try {
    const rows = jsonSafe(await db.query(sql, binds));
    return { name, binds, rowCount: rows.length, rows };
  } catch (error) {
    return { name, binds, rowCount: 0, rows: [], error: oraCode(error) };
  }
}

/** The table's owner as the session sees it: own table, otherwise the target of a synonym. */
export async function resolveStagingOwner(
  db: IFlexcubeSqlExecutor,
  table: string,
): Promise<string | null> {
  const own = await db.query(
    'SELECT USER AS OWNER_NAME FROM ALL_TABLES WHERE OWNER = USER AND TABLE_NAME = :tableName',
    { tableName: table },
  );
  if (own.length > 0) return String(own[0].OWNER_NAME);
  const syn = await db.query(
    `SELECT TABLE_OWNER FROM ALL_SYNONYMS
      WHERE SYNONYM_NAME = :tableName AND OWNER IN (USER, 'PUBLIC') AND DB_LINK IS NULL`,
    { tableName: table },
  );
  return syn.length > 0 ? String(syn[0].TABLE_OWNER) : null;
}

export async function runReadOnlyDiscovery(
  db: IFlexcubeSqlExecutor,
  options: DiscoveryOptions,
  now: () => Date = () => new Date(),
): Promise<DiscoveryReport> {
  const maxRows = options.maxRows ?? 200;
  const queries: DiscoveryQueryResult[] = [];
  let resolvedOwner: string | null = null;

  if (options.part === 'cif' || options.part === 'all') {
    if (options.candidateOwner && options.candidateTable) {
      // second pass: keys / foreign keys / synonyms of ONE exact candidate
      for (const q of cifSourceDiscoveryQueries({
        owner: options.candidateOwner,
        table: options.candidateTable,
        nameFragment: 'CIF',
        maxRows,
      }).filter((x) => x.name !== 'columns')) {
        queries.push(await run(db, `cif:${q.name}`, q.sql, q.binds));
      }
    } else {
      for (const fragment of options.fragments ?? ['CIF', 'CUSTOMER', 'KYC']) {
        const q = cifSourceDiscoveryQueries({
          owner: null,
          table: null,
          nameFragment: fragment,
          maxRows,
        }).find((x) => x.name === 'columns')!;
        queries.push(await run(db, `cif:columns:${fragment}`, q.sql, q.binds));
      }
    }
  }

  if (options.part === 'status' || options.part === 'all') {
    const table = (options.table ?? 'STTM_KYC_REIS_PAYLOAD_CUSTOM').toUpperCase();
    resolvedOwner = options.owner ?? (await resolveStagingOwner(db, table));
    if (resolvedOwner === null) {
      queries.push({
        name: 'status:resolveOwner',
        binds: { tableName: table },
        rowCount: 0,
        rows: [],
        error: 'OWNER_NOT_RESOLVED_PASS_--owner',
      });
    } else {
      for (const q of statusContractDiscoveryQueries({ owner: resolvedOwner, table, maxRows })) {
        queries.push(await run(db, `status:${q.name}`, q.sql, q.binds));
      }
    }
  }
  return { generatedAt: now().toISOString(), part: options.part, resolvedOwner, queries };
}
