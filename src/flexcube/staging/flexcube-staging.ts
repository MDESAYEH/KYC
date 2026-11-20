import { ReisFinalStatus } from '../../reis/reis-status';

/**
 * FLEXCUBE staging table agreed with Finexta (Abhilash, 03/11/2026), created in UAT1:
 *
 *   STTM_KYC_REIS_PAYLOAD_CUSTOM
 *     KYC_REF_NO         FLEXCUBE KYC reference number
 *     SEQ_NO             submission sequence, +1 for every amendment
 *     MSGID              unique API message id
 *     REQUEST            JSON request sent to REIS
 *     RESPONSE           initial JSON response received from REIS
 *     PROCESS_STATUS     N new | W in progress | S success (REIS answered) | E failure
 *     REIS_FINAL_STATUS  CLEAN | BLOCKED (FLEXCUBE authorizes accounts only for CLEAN)
 *     RETRY_COUNT        retry attempts for the same submission
 *     REQ_DATE           when the request was sent (set when the row is claimed)
 *     RES_DATE           when the submission completed (S or E)
 */
/**
 * Words FLEXCUBE reads in REIS_FINAL_STATUS (Finexta 17/11/2026, in use on UAT1). Account authorization
 * is allowed only for CLEAN. PENDING is never written by this code; a final decision may replace it.
 */
export const StagingFinalStatus = {
  CLEAN: 'CLEAN',
  PENDING: 'PENDING',
  BLOCKED: 'BLOCKED',
} as const;

/** REIS CUSTOMER -> CLEAN, BLOCKED -> BLOCKED. Anything else is never mapped. */
export function toStagingFinalStatus(status: ReisFinalStatus): string {
  switch (status) {
    case ReisFinalStatus.CUSTOMER:
      return StagingFinalStatus.CLEAN;
    case ReisFinalStatus.BLOCKED:
      return StagingFinalStatus.BLOCKED;
    default:
      throw new Error(`Unsupported REIS final status "${String(status)}"`);
  }
}

/** Minimal SQL port (Oracle in the application, a recorder in the SQL catalog). */
export type SqlBinds = Record<string, string | number | null>;
export type SqlRow = Record<string, unknown>;

export interface IFlexcubeSqlExecutor {
  /** Runs one statement with named binds and commits it. */
  execute(sql: string, binds: SqlBinds): Promise<{ rowsAffected: number }>;
  /** Runs a SELECT with named binds; rows are objects keyed by upper-case column name. */
  query(sql: string, binds: SqlBinds): Promise<SqlRow[]>;
}

/** Oracle unique-constraint violation (ORA-00001). */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /ORA-00001/.test(error.message);
}
/**
 * MSGID of a row created by this integration layer (a random UUID). Rows with any other MSGID
 * (e.g. Finexta's test row) are never touched. Used in REGEXP_LIKE(MSGID, pattern, 'i').
 */
export const OWN_MSGID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
/** Default column holding the key-person type (I / C); Finexta may name it differently on UAT. */
export const DEFAULT_KEYPERSON_TYPE_COLUMN = 'KYC_KEYPERSON_TYPE';

/** Only a plain Oracle column identifier may be used as the key-person type column. */
export function assertSafeColumnName(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_$#]{0,127}$/.test(name)) {
    throw new Error('FLEXCUBE_KEYPERSON_TYPE_COLUMN is not a valid Oracle column name');
  }
  return name;
}
export const FLEXCUBE_SQL_EXECUTOR = Symbol('IFlexcubeSqlExecutor');

/** Only plain Oracle identifiers (optionally schema-qualified) may be used as the table name. */
export function assertSafeTableName(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_$#]{0,127}(\.[A-Za-z][A-Za-z0-9_$#]{0,127})?$/.test(name)) {
    throw new Error('FLEXCUBE_STAGING_TABLE is not a valid Oracle table name');
  }
  return name;
}
