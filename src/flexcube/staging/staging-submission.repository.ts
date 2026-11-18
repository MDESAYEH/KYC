import {
  assertSafeTableName,
  IFlexcubeSqlExecutor,
  isUniqueViolation,
  OWN_MSGID_PATTERN,
} from './flexcube-staging';

/** PROCESS_STATUS values agreed with Finexta. */
export enum StagingProcessStatus {
  NEW = 'N',
  IN_PROGRESS = 'W',
  SUCCESS = 'S',
  ERROR = 'E',
}

/** The in-progress code is configurable (FLEXCUBE_STAGING_STATUS_IN_PROGRESS): one uppercase letter. */
export function assertSafeStatusCode(value: string): string {
  if (!/^[A-Z]$/.test(value)) {
    throw new Error('FLEXCUBE_STAGING_STATUS_IN_PROGRESS must be one uppercase letter');
  }
  return value;
}

/** Only Oracle / driver codes are technical failures: ORA-01745, NJS-503, DPI-1080 ... */
const TECHNICAL_CODE = /^(ORA|NJS|DPI)-\d{3,5}$/;

/** The exact RESPONSE the service stores when a failure was technical: {"error":"<code>"}. */
export function technicalErrorResponse(code: string): string {
  if (!TECHNICAL_CODE.test(code)) throw new Error('Not an Oracle / driver error code');
  return JSON.stringify({ error: code });
}

export interface StagingKey {
  kycRefNo: string;
  seqNo: number;
}

/**
 * A staging row closed as E by a technical failure, with every value a rollback needs (the
 * reconciliation backup keeps all of them, not only the keys). Dates are database-local text
 * YYYY-MM-DDTHH:MM:SS (or null). REQUEST, REQ_DATE and REIS_FINAL_STATUS are always NULL for
 * these rows (part of the eligibility proof), so they are recorded as such.
 */
export interface NeverSentRow extends StagingKey {
  msgId: string;
  processStatus: string;
  response: string;
  retryCount: number;
  resDate: string | null;
  reqDate: null;
  request: null;
  reisFinalStatus: null;
}

/** Marker stored in RESPONSE when REIS may have received a request whose outcome is unknown. */
export const DELIVERY_UNCERTAIN_MARKER = '"delivery":"UNCERTAIN"';

/** KYC_REF_NO as accepted on the command line / in the canary list: FLEXCUBE reference shape. */
export function assertSafeKycRefNo(value: string): string {
  if (!/^[A-Z0-9]{1,35}$/.test(value)) {
    throw new Error('A KYC_REF_NO must be 1-35 upper-case letters or digits');
  }
  return value;
}

const DB_DATE_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS'`;

/** The KYC of a staging row must still be open at the same MOD_NO since the cut-off. */
const openKycSince = (alias: string): string =>
  `EXISTS (SELECT 1 FROM STTM_KYC_MASTER m WHERE m.KYC_REF_NO = ${alias}.KYC_REF_NO ` +
  `AND m.MOD_NO = ${alias}.SEQ_NO AND m.RECORD_STAT = 'O' AND m.KYC_CUST_TYPE IN ('R', 'C') ` +
  `AND m.MAKER_DT_STAMP >= TO_DATE(:since, ${DB_DATE_FORMAT}))`;

/**
 * Submission lifecycle in STTM_KYC_REIS_PAYLOAD_CUSTOM (one row per KYC_REF_NO + SEQ_NO):
 *   insertNew  -> N   (row created by the integration layer when a saved KYC is detected)
 *   claim      -> W   (only from N: exactly one worker sends the submission; REQ_DATE = now)
 *   release    -> N   (only from W, only while nothing was sent: a technical failure BEFORE the
 *                      REIS call gives the claim back so the row stays recoverable)
 *   complete   -> S   (REIS answered: REQUEST / RESPONSE stored; RES_DATE = now)
 *              -> E   (the submission itself failed: RETRY_COUNT + 1, REQUEST / RESPONSE stored
 *                      when available; RES_DATE = now)
 *   fail       -> E   (from N or W; only for failures of the KYC itself, never for technical ones)
 * REQ_DATE / RES_DATE were added by Finexta for monitoring (10/11/2026); database time (SYSDATE).
 * REIS_FINAL_STATUS is written separately by StagingFlexcubeStatusUpdater.
 *
 * Every value is a bind variable; only the (validated) table name is part of the SQL text. Bind
 * names must never be Oracle reserved words (`:from`, `:to` -> ORA-01745 on UAT1): see sql-binds.ts.
 */
export class StagingSubmissionRepository {
  private readonly table: string;
  private readonly inProgress: string;

  /** `inProgress` is the claimed-status code (default W; the CHECK constraint is Finexta's). */
  constructor(
    private readonly db: IFlexcubeSqlExecutor,
    table: string,
    inProgress: string = StagingProcessStatus.IN_PROGRESS,
  ) {
    this.table = assertSafeTableName(table);
    this.inProgress = assertSafeStatusCode(inProgress);
  }

  /** Creates the row in N. Returns false when the row already exists (nothing changed). */
  async insertNew(key: StagingKey, msgId: string): Promise<boolean> {
    try {
      await this.db.execute(
        `INSERT INTO ${this.table} (KYC_REF_NO, SEQ_NO, MSGID, PROCESS_STATUS, RETRY_COUNT) ` +
          `VALUES (:kycRefNo, :seqNo, :msgId, :initialStatus, 0)`,
        {
          kycRefNo: key.kycRefNo,
          seqNo: key.seqNo,
          msgId,
          initialStatus: StagingProcessStatus.NEW,
        },
      );
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /** N -> W. True only for the single caller that moved the row. */
  async claim(key: StagingKey): Promise<boolean> {
    const { rowsAffected } = await this.db.execute(
      `UPDATE ${this.table} SET PROCESS_STATUS = :targetStatus, REQ_DATE = SYSDATE ` +
        `WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo AND PROCESS_STATUS = :sourceStatus`,
      {
        targetStatus: this.inProgress,
        sourceStatus: StagingProcessStatus.NEW,
        kycRefNo: key.kycRefNo,
        seqNo: key.seqNo,
      },
    );
    return rowsAffected === 1;
  }

  /**
   * W -> N: gives the claim back after a TECHNICAL failure that happened before anything was sent
   * (REQUEST is still empty). The row becomes recoverable again. False when the row was no longer
   * in progress or already holds a request: it is then left exactly as it is.
   */
  async release(key: StagingKey): Promise<boolean> {
    const { rowsAffected } = await this.db.execute(
      `UPDATE ${this.table} SET PROCESS_STATUS = :targetStatus, REQ_DATE = NULL ` +
        `WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo ` +
        `AND PROCESS_STATUS = :sourceStatus AND REQUEST IS NULL`,
      {
        targetStatus: StagingProcessStatus.NEW,
        sourceStatus: this.inProgress,
        kycRefNo: key.kycRefNo,
        seqNo: key.seqNo,
      },
    );
    return rowsAffected === 1;
  }

  /**
   * N or W -> E for a submission whose KYC itself failed: RETRY_COUNT + 1, RESPONSE = the technical
   * code, RES_DATE = now. False when no such row was left.
   */
  async fail(key: StagingKey, response: object): Promise<boolean> {
    const { rowsAffected } = await this.db.execute(
      `UPDATE ${this.table} SET PROCESS_STATUS = :targetStatus, RESPONSE = :responseJson, ` +
        `RETRY_COUNT = NVL(RETRY_COUNT, 0) + 1, RES_DATE = SYSDATE ` +
        `WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo ` +
        `AND PROCESS_STATUS IN (:sourceStatusNew, :sourceStatusWork)`,
      {
        targetStatus: StagingProcessStatus.ERROR,
        responseJson: JSON.stringify(response),
        kycRefNo: key.kycRefNo,
        seqNo: key.seqNo,
        sourceStatusNew: StagingProcessStatus.NEW,
        sourceStatusWork: this.inProgress,
      },
    );
    return rowsAffected === 1;
  }

  /**
   * Our own rows (UUID MSGID) claimed for more than `minutes` and still not completed. They are
   * only reported: a possibly half-sent submission is never resent automatically.
   */
  async findStuckInProgress(minutes: number, maxRows: number): Promise<StagingKey[]> {
    const rows = await this.db.query(
      `SELECT KYC_REF_NO, SEQ_NO FROM ${this.table} ` +
        `WHERE PROCESS_STATUS = :inProgressStatus AND REQ_DATE < SYSDATE - (:ageMinutes / 1440) ` +
        `AND REGEXP_LIKE(MSGID, '${OWN_MSGID_PATTERN}', 'i') ` +
        `ORDER BY KYC_REF_NO FETCH FIRST :maxRows ROWS ONLY`,
      { inProgressStatus: this.inProgress, ageMinutes: minutes, maxRows },
    );
    return rows.map((r) => ({ kycRefNo: String(r.KYC_REF_NO), seqNo: Number(r.SEQ_NO) }));
  }

  // ---- reconciliation of rows closed as E by the ORA-01745 incident (never sent) -----------------

  /**
   * Our rows closed as E whose claim never succeeded, so nothing was ever sent: no REQUEST, no
   * REQ_DATE, no REIS_FINAL_STATUS, RETRY_COUNT = 1 and RESPONSE exactly {"error":"<code>"} for one
   * of the given Oracle codes, for a KYC that is still open at the same MOD_NO since the cut-off.
   * `onlyKycRefNo` narrows it to one KYC. Read-only; returns every value a rollback needs.
   */
  async findNeverSentTechnicalErrors(
    since: string,
    errorCodes: string[],
    maxRows: number,
    onlyKycRefNo?: string,
  ): Promise<NeverSentRow[]> {
    const binds: Record<string, string | number> = {
      errorStatus: StagingProcessStatus.ERROR,
      since,
      maxRows,
    };
    const placeholders = errorCodes.map((code, i) => {
      binds[`expectedResponse${i}`] = technicalErrorResponse(code);
      return `:expectedResponse${i}`;
    });
    let only = '';
    if (onlyKycRefNo !== undefined) {
      binds.onlyKycRefNo = assertSafeKycRefNo(onlyKycRefNo);
      only = 'AND s.KYC_REF_NO = :onlyKycRefNo ';
    }
    const rows = await this.db.query(
      `SELECT s.KYC_REF_NO, s.SEQ_NO, s.MSGID, s.PROCESS_STATUS, s.RETRY_COUNT, ` +
        `TO_CHAR(SUBSTR(s.RESPONSE, 1, 200)) AS RESPONSE_TEXT, ` +
        `TO_CHAR(s.RES_DATE, ${DB_DATE_FORMAT}) AS RES_DATE_TEXT ` +
        `FROM ${this.table} s ` +
        `WHERE s.PROCESS_STATUS = :errorStatus AND s.REQUEST IS NULL AND s.REQ_DATE IS NULL ` +
        `AND s.REIS_FINAL_STATUS IS NULL AND s.RETRY_COUNT = 1 ` +
        `AND REGEXP_LIKE(s.MSGID, '${OWN_MSGID_PATTERN}', 'i') ` +
        `AND TO_CHAR(SUBSTR(s.RESPONSE, 1, 200)) IN (${placeholders.join(', ')}) ` +
        only +
        `AND ${openKycSince('s')} ` +
        `ORDER BY s.KYC_REF_NO FETCH FIRST :maxRows ROWS ONLY`,
      binds,
    );
    return rows.map((r) => ({
      kycRefNo: String(r.KYC_REF_NO),
      seqNo: Number(r.SEQ_NO),
      msgId: String(r.MSGID),
      processStatus: String(r.PROCESS_STATUS),
      response: String(r.RESPONSE_TEXT),
      retryCount: Number(r.RETRY_COUNT),
      resDate: r.RES_DATE_TEXT == null ? null : String(r.RES_DATE_TEXT),
      reqDate: null,
      request: null,
      reisFinalStatus: null,
    }));
  }

  /**
   * E -> N for ONE row proven to have been closed only by a technical failure before anything was
   * sent. The UPDATE re-checks EVERY eligibility condition itself (same MSGID, status E, no REQUEST /
   * REQ_DATE / REIS_FINAL_STATUS, RETRY_COUNT = 1, the exact technical RESPONSE, and the KYC still
   * open at the same MOD_NO since the cut-off), so a row or a KYC that changed between the SELECT
   * and the UPDATE is left alone. Called ONLY by the reconciliation tool after the local proof and
   * a backup.
   */
  async restoreNeverSent(row: NeverSentRow, errorCode: string, since: string): Promise<boolean> {
    const { rowsAffected } = await this.db.execute(
      `UPDATE ${this.table} t SET PROCESS_STATUS = :targetStatus, RESPONSE = NULL, ` +
        `RETRY_COUNT = 0, RES_DATE = NULL ` +
        `WHERE t.KYC_REF_NO = :kycRefNo AND t.SEQ_NO = :seqNo AND t.MSGID = :msgId ` +
        `AND REGEXP_LIKE(t.MSGID, '${OWN_MSGID_PATTERN}', 'i') ` +
        `AND t.PROCESS_STATUS = :sourceStatus ` +
        `AND t.REQUEST IS NULL AND t.REQ_DATE IS NULL AND t.REIS_FINAL_STATUS IS NULL ` +
        `AND t.RETRY_COUNT = 1 AND TO_CHAR(SUBSTR(t.RESPONSE, 1, 200)) = :expectedResponse ` +
        `AND ${openKycSince('t')}`,
      {
        targetStatus: StagingProcessStatus.NEW,
        sourceStatus: StagingProcessStatus.ERROR,
        kycRefNo: row.kycRefNo,
        seqNo: row.seqNo,
        msgId: row.msgId,
        expectedResponse: technicalErrorResponse(errorCode),
        since,
      },
    );
    return rowsAffected === 1;
  }

  /**
   * Rollback of one restore: N -> the backed-up E row (RESPONSE, RETRY_COUNT, RES_DATE). Only while
   * the row is exactly as the restore left it (same MSGID, N, nothing stored, never claimed since):
   * a row the sync has already picked up is never overwritten.
   */
  async rollbackRestore(row: NeverSentRow): Promise<boolean> {
    const { rowsAffected } = await this.db.execute(
      `UPDATE ${this.table} SET PROCESS_STATUS = :originalStatus, RESPONSE = :originalResponse, ` +
        `RETRY_COUNT = :originalRetryCount, RES_DATE = TO_DATE(:originalResDate, ${DB_DATE_FORMAT}) ` +
        `WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo AND MSGID = :msgId ` +
        `AND PROCESS_STATUS = :restoredStatus AND REQUEST IS NULL AND REQ_DATE IS NULL ` +
        `AND RESPONSE IS NULL AND RETRY_COUNT = 0 AND RES_DATE IS NULL ` +
        `AND REIS_FINAL_STATUS IS NULL`,
      {
        originalStatus: row.processStatus,
        originalResponse: row.response,
        originalRetryCount: row.retryCount,
        originalResDate: row.resDate,
        restoredStatus: StagingProcessStatus.NEW,
        kycRefNo: row.kycRefNo,
        seqNo: row.seqNo,
        msgId: row.msgId,
      },
    );
    return rowsAffected === 1;
  }

  /**
   * Our rows whose delivery to REIS is not known (send guard): E rows marked
   * {"delivery":"UNCERTAIN"} and rows claimed for more than `minutes` (a pass died after the
   * claim, possibly after the REIS call). While any is unresolved, the sync sends nothing. Read-only.
   */
  async findDeliveryRisk(minutes: number, maxRows: number): Promise<StagingKey[]> {
    const rows = await this.db.query(
      `SELECT KYC_REF_NO, SEQ_NO FROM ${this.table} ` +
        `WHERE REGEXP_LIKE(MSGID, '${OWN_MSGID_PATTERN}', 'i') ` +
        `AND ((PROCESS_STATUS = :errorStatus AND INSTR(RESPONSE, :uncertainMarker) > 0) ` +
        `OR (PROCESS_STATUS = :inProgressStatus AND REQ_DATE < SYSDATE - (:ageMinutes / 1440))) ` +
        `ORDER BY KYC_REF_NO FETCH FIRST :maxRows ROWS ONLY`,
      {
        errorStatus: StagingProcessStatus.ERROR,
        uncertainMarker: DELIVERY_UNCERTAIN_MARKER,
        inProgressStatus: this.inProgress,
        ageMinutes: minutes,
        maxRows,
      },
    );
    return rows.map((r) => ({ kycRefNo: String(r.KYC_REF_NO), seqNo: Number(r.SEQ_NO) }));
  }

  /** W -> S or E, storing the REIS request / response JSON when known. */
  async complete(
    key: StagingKey,
    outcome: {
      status: StagingProcessStatus.SUCCESS | StagingProcessStatus.ERROR;
      request?: object;
      response?: object;
    },
  ): Promise<void> {
    const retry = outcome.status === StagingProcessStatus.ERROR ? 1 : 0;
    const { rowsAffected } = await this.db.execute(
      `UPDATE ${this.table} SET PROCESS_STATUS = :targetStatus, ` +
        `REQUEST = COALESCE(:requestJson, REQUEST), RESPONSE = COALESCE(:responseJson, RESPONSE), ` +
        `RETRY_COUNT = NVL(RETRY_COUNT, 0) + :retryIncrement, RES_DATE = SYSDATE ` +
        `WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo AND PROCESS_STATUS = :sourceStatus`,
      {
        targetStatus: outcome.status,
        requestJson: outcome.request === undefined ? null : JSON.stringify(outcome.request),
        responseJson: outcome.response === undefined ? null : JSON.stringify(outcome.response),
        retryIncrement: retry,
        kycRefNo: key.kycRefNo,
        seqNo: key.seqNo,
        sourceStatus: this.inProgress,
      },
    );
    if (rowsAffected !== 1) {
      throw new Error(`Staging row is not in progress`);
    }
  }
}
