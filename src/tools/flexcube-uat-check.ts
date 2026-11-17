import { CanonicalToReisTransformer } from '../reis/canonical-to-reis.transformer';
import { oraCode, oracleErrorCode } from '../flexcube/oracle-error';
import { RecoveryDiagnostics, recoveryDiagnostics } from './staging-diagnostics';
import { FlexcubeKycSource, normalizeSyncStartDate } from '../flexcube/source/flexcube-kyc-source';
import { FlexcubeToCanonicalMapper } from '../flexcube/flexcube-to-canonical.mapper';
import {
  assertSafeColumnName,
  assertSafeTableName,
  DEFAULT_KEYPERSON_TYPE_COLUMN,
  IFlexcubeSqlExecutor,
  OWN_MSGID_PATTERN,
} from '../flexcube/staging/flexcube-staging';

/**
 * READ-ONLY diagnostic of the FLEXCUBE UAT database for the integration layer:
 * connection, table access, expected columns, staging-table privileges, pending KYCs, and a
 * dry run of the first pending KYCs through validation + mapping (REIS is NOT called, nothing
 * is written). The report holds only technical facts: no names, numbers or other customer data.
 */
export const EXPECTED_COLUMNS: Record<string, string[]> = {
  STTM_KYC_MASTER: [
    'KYC_REF_NO',
    'KYC_CUST_TYPE',
    'MOD_NO',
    'AUTH_STAT',
    'RECORD_STAT',
    'MAKER_DT_STAMP',
  ],
  STTM_KYC_RETAIL: [
    'KYC_REF_NO',
    'BIRTH_DATE',
    'BIRTH_PLACE',
    'PASSPORT_NO',
    'PASSPORT_EXPIRY_DATE',
    'PEP',
    'NATIONALITY',
    'LOCAL_ADDR_COUNTRY',
    'ACC_PURPOSE',
    'RESIDENT',
    'TOTAL_INCOME',
  ],
  STTM_KYC_RETAIL_CUSTOM: [
    'KYC_REF_NO',
    'FIRST_NAME',
    'LAST_NAME',
    'ACCOUNT_MANAGER_LOGIN',
    'ACCOUNT_MANAGER_EMAIL',
    'RELATION_PEP',
    'DISTRIBUTION_CHANNEL',
    'FUNDS_SOURCE',
  ],
  STTM_KYC_OTHER_TYPES: ['KYC_REFERENCE_NO', 'OCCUPATION'],
  STTM_KYC_RETAIL_PRODUCT_CUSTOM: ['KYC_REF_NO', 'PRODUCT_CODE'],
  STTM_KYC_CORPORATE: [
    'KYC_REF_NO',
    'TRADE_LICENCE_NO',
    'PARENT_CMPNY_COUNTRY',
    'ACC_PURPOSE',
    'FUNDS_SOURCE',
    'ANNUAL_TURNOVER',
  ],
  STTM_KYC_CORPORATE_CUSTOM: [
    'KYC_REF_NO',
    'CRP_BUSINESS_NAME',
    'ACCOUNT_MANAGER_LOGIN',
    'ACCOUNT_MANAGER_EMAIL',
    'PEP',
    'LEGAL_ENTITY',
    'ACTIVITY',
    'DISTRIBUTION_CHANNEL',
  ],
  STTM_KYC_CORP_PRODUCT_CUSTOM: ['KYC_REF_NO', 'PRODUCT_CODE'],
  STTM_KYC_CORP_COUNTRY_CUSTOM: ['KYC_REF_NO', 'OPERATION_COUNTRY'],
  STTM_KYC_CORP_KEYPERSONS: [
    'KYC_REF_NO',
    'KYC_ID',
    'NAME',
    'RELATIONSHIP',
    'DATE_OF_BIRTH',
    'NATIONALITY',
    'ADDRESS_COUNTRY',
    'PLACE_OF_BIRTH',
    'TIN',
  ],
  STTM_KYC_CORP_KEYPERSONS_CUSTOM: [
    'KYC_REF_NO',
    'KYC_ID',
    'NAME',
    // the party type (I / C) lives here, not in STTM_KYC_CORP_KEYPERSONS (UAT1, 17/11/2026)
    'KYC_KEYPERSON_TYPE',
    'FIRST_NAME',
    'LAST_NAME',
    'PASSPORT_NUMBER',
    'PASSPORT_ISSUE_DATE',
    'PASSPORT_EXPIRY_DATE',
    'PLACE_OF_ISSUE',
    'NATIONAL_ID',
  ],
};

/** EXPECTED_COLUMNS with the configured key-person type column (FLEXCUBE_KEYPERSON_TYPE_COLUMN). */
export function expectedColumns(
  keypersonTypeColumn: string = DEFAULT_KEYPERSON_TYPE_COLUMN,
): Record<string, string[]> {
  return {
    ...EXPECTED_COLUMNS,
    STTM_KYC_CORP_KEYPERSONS_CUSTOM: EXPECTED_COLUMNS.STTM_KYC_CORP_KEYPERSONS_CUSTOM.map((c) =>
      c === DEFAULT_KEYPERSON_TYPE_COLUMN ? keypersonTypeColumn : c,
    ),
  };
}

export const STAGING_COLUMNS = [
  'KYC_REF_NO',
  'SEQ_NO',
  'MSGID',
  'REQUEST',
  'RESPONSE',
  'PROCESS_STATUS',
  'REIS_FINAL_STATUS',
  'RETRY_COUNT',
  'REQ_DATE',
  'RES_DATE',
];

export interface TableCheck {
  table: string;
  readable: boolean;
  rows?: number;
  error?: string;
  missingColumns: string[];
  /** Every column visible to the user for this table (names only, to fix the mapping). */
  availableColumns: string[];
}

export interface UatCheckReport {
  connected: boolean;
  connectionError?: string;
  user?: string;
  currentSchema?: string;
  tables: TableCheck[];
  /** Objects visible to the user whose name looks like the KYC / staging tables (any owner). */
  similarObjects: string[];
  staging?: {
    privileges: string[];
    canInsert: boolean;
    canUpdate: boolean;
    hasDelete: boolean;
    ownedByUser: boolean;
    processStatuses: Record<string, number>;
    /** Rows per PROCESS_STATUS split into ours (UUID MSGID) and others (e.g. Finexta test rows). */
    processStatusesByOwner: { ours: Record<string, number>; others: Record<string, number> };
    /** CHECK constraints (ALL_CONSTRAINTS, type C): which PROCESS_STATUS values are accepted. */
    checkConstraints: { name: string; condition: string }[];
    triggers: { name: string; type: string; event: string; status: string }[];
  };
  /** The cut-off in use (FLEXCUBE_SYNC_START_DATE, normalized) and the latest maker date per branch. */
  cutoff?: string;
  branches?: { branch: string; kycs: number; latestMakerDate: string | null }[];
  /** Our own staging rows against the current KYC versions (read-only, counts only). */
  recovery?: RecoveryDiagnostics;
  /** Key-person type column (I / C): never guessed, only reported. */
  keypersonType?: {
    configuredColumn: string;
    present: boolean;
    /** Columns of STTM_KYC_CORP_KEYPERSONS_CUSTOM whose name contains TYPE (candidates to ask Finexta about). */
    similarColumns: string[];
  };
  pending?: {
    total: number;
    individual: number;
    corporate: number;
    /** Corporate KYCs are only selected while the type column is proven to exist. */
    corporateSupported?: boolean;
    corporateSupportReason?: string;
    error?: string;
  };
  dryRun: { kycRefNo: string; seqNo: number; type: string; result: string; detail?: string }[];
}

export { oraCode };

/** Validation failure -> "ErrorName: FIELD" without the value. */
function failureDetail(error: unknown): string {
  if (!(error instanceof Error)) return 'UNKNOWN_ERROR';
  const e = error as Error & { field?: string; mappingType?: string; flexcubeValue?: string };
  if (e.mappingType) return `${e.name}: ${e.mappingType} (value not in the agreed list)`;
  if (e.field) return `${e.name}: ${e.field}`;
  // Database errors: the Oracle code (e.g. ORA-00904), never the message.
  const code = oracleErrorCode(error);
  return code ? `${e.name}: ${code}` : e.name;
}

export async function runUatCheck(
  db: IFlexcubeSqlExecutor,
  stagingTable: string,
  pipeline: { mapper: FlexcubeToCanonicalMapper; transformer: CanonicalToReisTransformer },
  dryRunLimit = 5,
  /** Raw FLEXCUBE_SYNC_START_DATE (cut-off of the pending query). */
  syncStartDate?: string,
  /** Column holding the key-person type (FLEXCUBE_KEYPERSON_TYPE_COLUMN). */
  keypersonTypeColumn: string = DEFAULT_KEYPERSON_TYPE_COLUMN,
): Promise<UatCheckReport> {
  const staging = assertSafeTableName(stagingTable);
  const expected = expectedColumns(assertSafeColumnName(keypersonTypeColumn));
  const stagingName = staging.split('.').pop()!.toUpperCase();
  const report: UatCheckReport = { connected: false, tables: [], similarObjects: [], dryRun: [] };

  try {
    const [who] = await db.query(
      "SELECT USER AS U, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS S FROM DUAL",
      {},
    );
    report.connected = true;
    report.user = String(who.U);
    report.currentSchema = String(who.S);
  } catch (error) {
    report.connectionError = oraCode(error);
    return report;
  }

  // Columns visible to the user (any owner: the tables may be reached through synonyms).
  const names = [...Object.keys(expected), stagingName];
  const binds = Object.fromEntries(names.map((n, i) => [`t${i}`, n]));
  const colRows = await db
    .query(
      `SELECT TABLE_NAME, COLUMN_NAME FROM ALL_TAB_COLUMNS WHERE TABLE_NAME IN (${names
        .map((_, i) => `:t${i}`)
        .join(', ')})`,
      binds,
    )
    .catch(() => []);
  const columns = new Map<string, Set<string>>();
  for (const r of colRows) {
    const t = String(r.TABLE_NAME);
    if (!columns.has(t)) columns.set(t, new Set());
    columns.get(t)!.add(String(r.COLUMN_NAME));
  }

  const check = async (table: string, sqlName: string, expected: string[]) => {
    const result: TableCheck = {
      table: sqlName,
      readable: false,
      missingColumns: [],
      availableColumns: [...(columns.get(table) ?? [])].sort(),
    };
    try {
      const [c] = await db.query(`SELECT COUNT(*) AS N FROM ${sqlName}`, {});
      result.readable = true;
      result.rows = Number(c.N);
    } catch (error) {
      result.error = oraCode(error);
    }
    const seen = columns.get(table);
    result.missingColumns = seen ? expected.filter((c) => !seen.has(c)) : expected;
    report.tables.push(result);
  };
  for (const [table, cols] of Object.entries(expected)) {
    await check(table, table, cols);
  }
  await check(stagingName, staging, STAGING_COLUMNS);

  // Where are the tables we cannot read? (e.g. STZM vs STTM, another owner, missing synonym)
  const similar = await db
    .query(
      `SELECT OWNER || '.' || TABLE_NAME AS N FROM ALL_TABLES
        WHERE TABLE_NAME LIKE '%KYC_MASTER%' OR TABLE_NAME LIKE '%REIS%'
          OR TABLE_NAME LIKE '%KEYPERSONS%'
       UNION SELECT OWNER || '.' || SYNONYM_NAME || ' -> ' || TABLE_OWNER || '.' || TABLE_NAME FROM ALL_SYNONYMS
        WHERE SYNONYM_NAME LIKE '%KYC_MASTER%' OR SYNONYM_NAME LIKE '%REIS%'
          OR SYNONYM_NAME LIKE '%KEYPERSONS%'`,
      {},
    )
    .catch(() => []);
  report.similarObjects = similar.map((r) => String(r.N)).sort();

  // Staging privileges (direct grants, PUBLIC and roles). DELETE must NOT be granted.
  const privRows = await db
    .query(
      `SELECT PRIVILEGE FROM ALL_TAB_PRIVS WHERE TABLE_NAME = :tableName
         AND GRANTEE IN (USER, 'PUBLIC')
       UNION SELECT PRIVILEGE FROM ROLE_TAB_PRIVS WHERE TABLE_NAME = :tableName`,
      { tableName: stagingName },
    )
    .catch(() => []);
  const owned = await db
    .query('SELECT COUNT(*) AS N FROM USER_TABLES WHERE TABLE_NAME = :tableName', {
      tableName: stagingName,
    })
    .then((r) => Number(r[0]?.N) > 0)
    .catch(() => false);
  const privileges = [...new Set(privRows.map((r) => String(r.PRIVILEGE)))].sort();
  const ownerKind = `CASE WHEN REGEXP_LIKE(MSGID, '${OWN_MSGID_PATTERN}', 'i') THEN 'OURS' ELSE 'OTHERS' END`;
  const statuses = await db
    .query(
      `SELECT NVL(PROCESS_STATUS, '-') AS S, ${ownerKind} AS OWNER_KIND, COUNT(*) AS N ` +
        `FROM ${staging} GROUP BY NVL(PROCESS_STATUS, '-'), ${ownerKind}`,
      {},
    )
    .catch(() => []);
  const byOwner = { ours: {} as Record<string, number>, others: {} as Record<string, number> };
  const totals: Record<string, number> = {};
  for (const r of statuses) {
    const side = r.OWNER_KIND === 'OURS' ? byOwner.ours : byOwner.others;
    side[String(r.S)] = (side[String(r.S)] ?? 0) + Number(r.N);
    totals[String(r.S)] = (totals[String(r.S)] ?? 0) + Number(r.N);
  }
  // Why does a claim (N -> W) fail? Constraints and triggers of the staging table (read-only).
  const constraints = await db
    .query(
      `SELECT CONSTRAINT_NAME, SEARCH_CONDITION FROM ALL_CONSTRAINTS ` +
        `WHERE TABLE_NAME = :tableName AND CONSTRAINT_TYPE = 'C' ORDER BY CONSTRAINT_NAME`,
      { tableName: stagingName },
    )
    .catch(() => []);
  const triggers = await db
    .query(
      `SELECT TRIGGER_NAME, TRIGGER_TYPE, TRIGGERING_EVENT, STATUS FROM ALL_TRIGGERS ` +
        `WHERE TABLE_NAME = :tableName ORDER BY TRIGGER_NAME`,
      { tableName: stagingName },
    )
    .catch(() => []);
  // Maker date per branch (first 3 characters of KYC_REF_NO): helps choosing the UAT cut-off.
  const branches = await db
    .query(
      `SELECT SUBSTR(KYC_REF_NO, 1, 3) AS BRANCH, COUNT(*) AS N, ` +
        `TO_CHAR(MAX(MAKER_DT_STAMP), 'YYYY-MM-DD"T"HH24:MI:SS') AS LATEST ` +
        `FROM STTM_KYC_MASTER GROUP BY SUBSTR(KYC_REF_NO, 1, 3) ORDER BY 1`,
      {},
    )
    .catch(() => []);
  report.branches = branches.map((r) => ({
    branch: String(r.BRANCH),
    kycs: Number(r.N),
    latestMakerDate: r.LATEST === null || r.LATEST === undefined ? null : String(r.LATEST),
  }));
  report.cutoff = normalizeSyncStartDate(syncStartDate);
  if (report.cutoff !== undefined) {
    report.recovery = await recoveryDiagnostics(db, staging, report.cutoff).catch(() => undefined);
  }
  const kp = report.tables.find((t) => t.table === 'STTM_KYC_CORP_KEYPERSONS_CUSTOM');
  report.keypersonType = {
    configuredColumn: keypersonTypeColumn,
    present: kp !== undefined && !kp.missingColumns.includes(keypersonTypeColumn),
    similarColumns: (kp?.availableColumns ?? []).filter((c) => c.includes('TYPE')),
  };
  report.staging = {
    privileges,
    canInsert: owned || privileges.includes('INSERT'),
    canUpdate: owned || privileges.includes('UPDATE'),
    hasDelete: owned || privileges.includes('DELETE'),
    ownedByUser: owned,
    processStatuses: totals,
    processStatusesByOwner: byOwner,
    checkConstraints: constraints.map((r) => ({
      name: String(r.CONSTRAINT_NAME),
      condition: String(r.SEARCH_CONDITION ?? '').trim(),
    })),
    triggers: triggers.map((r) => ({
      name: String(r.TRIGGER_NAME),
      type: String(r.TRIGGER_TYPE),
      event: String(r.TRIGGERING_EVENT),
      status: String(r.STATUS),
    })),
  };

  // Pending KYCs and a dry run (validation + mapping only, no REIS call, no write).
  try {
    if (normalizeSyncStartDate(syncStartDate) === undefined) {
      throw Object.assign(new Error('cut-off missing or invalid'), {
        name: 'FLEXCUBE_SYNC_START_DATE_MISSING_OR_INVALID',
      });
    }
    const source = new FlexcubeKycSource(db, staging, syncStartDate as string, keypersonTypeColumn);
    const corporateSupported = await source.refreshCorporateSupport();
    const pending = await source.findPending(200);
    report.pending = {
      total: pending.length,
      individual: pending.filter((p) => p.customerType === 'INDIVIDUAL').length,
      corporate: pending.filter((p) => p.customerType === 'CORPORATE').length,
      corporateSupported,
      corporateSupportReason: source.corporateSupportReason,
    };
    for (const p of pending.slice(0, dryRunLimit)) {
      const line = { kycRefNo: p.kycRefNo, seqNo: p.seqNo, type: p.customerType, result: 'OK' };
      try {
        const request = await source.load(p);
        await pipeline.transformer.transform(pipeline.mapper.map(request));
        report.dryRun.push(line);
      } catch (error) {
        report.dryRun.push({ ...line, result: 'REJECTED', detail: failureDetail(error) });
      }
    }
  } catch (error) {
    report.pending = { total: 0, individual: 0, corporate: 0, error: oraCode(error) };
  }
  return report;
}
