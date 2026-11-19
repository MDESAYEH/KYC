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
/** Values FLEXCUBE reads in REIS_FINAL_STATUS. */
export enum StagingFinalStatus {
  APPROVED = 'APPROVED',
  BLOCKED = 'BLOCKED',
}

/**
 * The words FLEXCUBE reads in REIS_FINAL_STATUS. Two vocabularies exist in the project history:
 *  - approved-blocked (Finexta 10/11/2026, the DEFAULT until the new one is confirmed in writing together
 *    with the table constraints and the FLEXCUBE logic that consumes the column): APPROVED / BLOCKED;
 *  - clean-pending-blocked (stated by Finexta on 17/11/2026, NOT yet confirmed against the real
 *    constraints): CLEAN / PENDING / BLOCKED. PENDING is written when REIS answers PENDING, so FLEXCUBE can
 *    tell "waiting for REIS" from "not processed" (NULL); a later final decision replaces PENDING.
 */
export type FinalStatusVocabulary = 'approved-blocked' | 'clean-pending-blocked';

export interface DecisionValues {
  approved: string;
  blocked: string;
  /** null: the vocabulary has no interim word (PENDING is never written). */
  pending: string | null;
}

export function decisionValues(vocabulary: FinalStatusVocabulary): DecisionValues {
  switch (vocabulary) {
    case 'approved-blocked':
      return { approved: 'APPROVED', blocked: 'BLOCKED', pending: null };
    case 'clean-pending-blocked':
      return { approved: 'CLEAN', blocked: 'BLOCKED', pending: 'PENDING' };
    default:
      throw new Error(
        'FLEXCUBE_FINAL_STATUS_VOCABULARY must be approved-blocked or clean-pending-blocked',
      );
  }
}

/**
 * REIS CUSTOMER -> approved word (APPROVED, or CLEAN in the new vocabulary), BLOCKED -> BLOCKED.
 * An unknown status is never mapped (no default: Timeout is not PENDING, a failure is not APPROVED).
 */
export function toStagingFinalStatus(
  status: ReisFinalStatus,
  vocabulary: FinalStatusVocabulary = 'approved-blocked',
): string {
  const words = decisionValues(vocabulary);
  switch (status) {
    case ReisFinalStatus.CUSTOMER:
      return words.approved;
    case ReisFinalStatus.BLOCKED:
      return words.blocked;
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
