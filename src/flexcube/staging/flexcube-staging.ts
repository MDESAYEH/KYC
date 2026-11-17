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
 *     REIS_FINAL_STATUS  APPROVED | BLOCKED (FLEXCUBE authorizes the KYC from this column)
 *     RETRY_COUNT        retry attempts for the same submission
 *     REQ_DATE           when the request was sent (set when the row is claimed)
 *     RES_DATE           when the submission completed (S or E)
 */
export const DEFAULT_STAGING_TABLE = 'STTM_KYC_REIS_PAYLOAD_CUSTOM';

/** Values FLEXCUBE reads in REIS_FINAL_STATUS. */
export enum StagingFinalStatus {
  APPROVED = 'APPROVED',
  BLOCKED = 'BLOCKED',
}

/** REIS CUSTOMER -> APPROVED (no customer number is sent), BLOCKED -> BLOCKED. */
export function toStagingFinalStatus(status: ReisFinalStatus): StagingFinalStatus {
  switch (status) {
    case ReisFinalStatus.CUSTOMER:
      return StagingFinalStatus.APPROVED;
    case ReisFinalStatus.BLOCKED:
      return StagingFinalStatus.BLOCKED;
    default:
      throw new Error(`Unsupported REIS final status "${String(status)}"`);
  }
}

/** Minimal SQL port so the staging logic is testable without an Oracle database. */
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
export const FLEXCUBE_SQL_EXECUTOR = Symbol('IFlexcubeSqlExecutor');

/** Only plain Oracle identifiers (optionally schema-qualified) may be used as the table name. */
export function assertSafeTableName(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_$#]{0,127}(\.[A-Za-z][A-Za-z0-9_$#]{0,127})?$/.test(name)) {
    throw new Error('FLEXCUBE_STAGING_TABLE is not a valid Oracle table name');
  }
  return name;
}
