import { assertSafeTableName, SqlBinds } from '../flexcube/staging/flexcube-staging';

/**
 * READ-ONLY dictionary queries to find out what the staging table REALLY accepts in REIS_FINAL_STATUS
 * and who reads it. Nothing here touches business data except one grouped COUNT of the status column
 * (counts only, no identifiers). Prepared for review: none has been run against Oracle.
 *
 * A passing application test does not prove FLEXCUBE accepts CLEAN / PENDING / BLOCKED. The evidence
 * ladder is in docs/uat1-readonly-discovery-runbook.md: (1) constraint + trigger text, (2) the same
 * DDL replayed in an isolated schema, (3) the FLEXCUBE-side consumers and Finexta's written confirmation.
 */
export interface DiscoveryQuery {
  name: string;
  purpose: string;
  sql: string;
  binds: SqlBinds;
}

export function statusContractDiscoveryQueries(options: {
  /** Owner of the staging table (exact dictionary name, upper case), e.g. the schema shown by check:uat1. */
  owner: string;
  /** Staging table, validated as a plain identifier (default STTM_KYC_REIS_PAYLOAD_CUSTOM). */
  table?: string;
  maxRows?: number;
}): DiscoveryQuery[] {
  const maxRows = options.maxRows ?? 200;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 500) {
    throw new Error('maxRows must be an integer from 1 to 500');
  }
  const table = assertSafeTableName(options.table ?? 'STTM_KYC_REIS_PAYLOAD_CUSTOM');
  if (table.includes('.')) throw new Error('Pass the owner separately, not as OWNER.TABLE');
  if (!/^[A-Z][A-Z0-9_$#]{0,127}$/.test(options.owner)) {
    throw new Error('owner must be an exact upper-case Oracle dictionary name');
  }
  const t = { ownerName: options.owner, tableName: table.toUpperCase() };
  return [
    {
      name: 'statusColumn',
      purpose: 'Type, length, nullability and default of REIS_FINAL_STATUS and PROCESS_STATUS.',
      sql: `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, CHAR_LENGTH, NULLABLE, DATA_DEFAULT
              FROM ALL_TAB_COLUMNS
             WHERE OWNER = :ownerName AND TABLE_NAME = :tableName
               AND COLUMN_NAME IN ('REIS_FINAL_STATUS', 'PROCESS_STATUS')
             ORDER BY COLUMN_NAME`,
      binds: { ...t },
    },
    {
      name: 'checkConstraints',
      purpose:
        'Every CHECK constraint of the table: which values may PROCESS_STATUS / REIS_FINAL_STATUS hold, and is it enabled and validated.',
      sql: `SELECT c.CONSTRAINT_NAME, c.STATUS, c.VALIDATED, k.COLUMN_NAME, c.SEARCH_CONDITION
              FROM ALL_CONSTRAINTS c
              LEFT JOIN ALL_CONS_COLUMNS k ON k.OWNER = c.OWNER
               AND k.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND k.TABLE_NAME = c.TABLE_NAME
             WHERE c.OWNER = :ownerName AND c.TABLE_NAME = :tableName AND c.CONSTRAINT_TYPE = 'C'
             ORDER BY c.CONSTRAINT_NAME, k.POSITION
             FETCH FIRST :maxRows ROWS ONLY`,
      binds: { ...t, maxRows },
    },
    {
      name: 'triggers',
      purpose:
        'Triggers on the table (they can reject or rewrite a status even when the CHECK allows it).',
      sql: `SELECT TRIGGER_NAME, TRIGGER_TYPE, TRIGGERING_EVENT, STATUS, COLUMN_NAME, WHEN_CLAUSE
              FROM ALL_TRIGGERS
             WHERE TABLE_OWNER = :ownerName AND TABLE_NAME = :tableName
             ORDER BY TRIGGER_NAME
             FETCH FIRST :maxRows ROWS ONLY`,
      binds: { ...t, maxRows },
    },
    {
      name: 'triggerCodeMentioningTheColumns',
      purpose:
        'Only the trigger source LINES that mention REIS_FINAL_STATUS or PROCESS_STATUS (the validation rules).',
      sql: `SELECT s.NAME, s.LINE, s.TEXT
              FROM ALL_SOURCE s
              JOIN ALL_TRIGGERS g ON g.OWNER = s.OWNER AND g.TRIGGER_NAME = s.NAME
             WHERE s.TYPE = 'TRIGGER' AND g.TABLE_OWNER = :ownerName AND g.TABLE_NAME = :tableName
               AND (UPPER(s.TEXT) LIKE '%REIS_FINAL_STATUS%' OR UPPER(s.TEXT) LIKE '%PROCESS_STATUS%')
             ORDER BY s.NAME, s.LINE
             FETCH FIRST :maxRows ROWS ONLY`,
      binds: { ...t, maxRows },
    },
    {
      name: 'consumers',
      purpose:
        'Database objects (views, procedures, packages, triggers) that reference the staging table: where FLEXCUBE logic may read it.',
      sql: `SELECT d.OWNER, d.NAME, d.TYPE
              FROM ALL_DEPENDENCIES d
             WHERE d.REFERENCED_OWNER = :ownerName AND d.REFERENCED_NAME = :tableName
               AND d.REFERENCED_TYPE = 'TABLE'
             ORDER BY d.OWNER, d.TYPE, d.NAME
             FETCH FIRST :maxRows ROWS ONLY`,
      binds: { ...t, maxRows },
    },
    {
      name: 'consumerCodeMentioningTheStatus',
      purpose:
        'Source lines of those objects that mention REIS_FINAL_STATUS: how the value is READ (CLEAN / PENDING / BLOCKED / APPROVED?).',
      sql: `SELECT s.OWNER, s.NAME, s.TYPE, s.LINE, s.TEXT
              FROM ALL_SOURCE s
              JOIN ALL_DEPENDENCIES d ON d.OWNER = s.OWNER AND d.NAME = s.NAME AND d.TYPE = s.TYPE
             WHERE d.REFERENCED_OWNER = :ownerName AND d.REFERENCED_NAME = :tableName
               AND d.REFERENCED_TYPE = 'TABLE'
               AND UPPER(s.TEXT) LIKE '%REIS_FINAL_STATUS%'
             ORDER BY s.OWNER, s.NAME, s.TYPE, s.LINE
             FETCH FIRST :maxRows ROWS ONLY`,
      binds: { ...t, maxRows },
    },
    {
      name: 'tableDdl',
      purpose:
        'The exact DDL, to replay it in an ISOLATED schema (needs SELECT_CATALOG_ROLE; ORA-31603 means not granted).',
      sql: `SELECT DBMS_METADATA.GET_DDL('TABLE', :tableName, :ownerName) AS DDL FROM DUAL`,
      binds: { tableName: t.tableName, ownerName: t.ownerName },
    },
    {
      name: 'statusDistribution',
      purpose:
        'Counts of values already stored in REIS_FINAL_STATUS (no identifiers). The table name cannot be a bind: it was validated.',
      sql: `SELECT NVL(REIS_FINAL_STATUS, '(null)') AS REIS_FINAL_STATUS, COUNT(*) AS N
              FROM ${t.ownerName}.${t.tableName}
             GROUP BY REIS_FINAL_STATUS
             ORDER BY 1`,
      binds: {},
    },
  ];
}
