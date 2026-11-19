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

/** A staging row exactly as it was, for the reconciliation backup and its rollback. */
export interface StagingBackupRow {
  kycRefNo: string;
  seqNo: number;
  msgId: string | null;
  processStatus: string | null;
  request: string | null;
  response: string | null;
  retryCount: number | null;
  /** YYYY-MM-DDTHH:MM:SS (database time) or null */
  reqDate: string | null;
  resDate: string | null;
  reisFinalStatus: string | null;
}

export interface StagingKey {
  kycRefNo: string;
  seqNo: number;
}

/** Marker stored in RESPONSE when REIS may have received a request whose outcome is unknown. */
export const DELIVERY_UNCERTAIN_MARKER = '"delivery":"UNCERTAIN"';

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
   * The ONE eligibility predicate of the reconciliation, used by the SELECT and, unchanged, by the
   * UPDATE, so a row that lost any condition between the two is left alone: ours (UUID MSGID), E,
   * RETRY_COUNT 1, no REQUEST, no REQ_DATE, no REIS_FINAL_STATUS, RESPONSE exactly the technical
   * marker of an allowed Oracle code, and its KYC still open at the same MOD_NO, of a supported type,
   * created since the cut-off. The staging table is aliased s.
   */
  private neverSentPredicate(responsePlaceholders: string): string {
    return (
      `s.PROCESS_STATUS = :errorStatus AND s.REQUEST IS NULL AND s.REQ_DATE IS NULL ` +
      `AND s.REIS_FINAL_STATUS IS NULL AND s.RETRY_COUNT = 1 ` +
      `AND REGEXP_LIKE(s.MSGID, '${OWN_MSGID_PATTERN}', 'i') ` +
      `AND TO_CHAR(SUBSTR(s.RESPONSE, 1, 200)) IN (${responsePlaceholders}) ` +
      `AND EXISTS (SELECT 1 FROM STTM_KYC_MASTER m WHERE m.KYC_REF_NO = s.KYC_REF_NO ` +
      `AND m.MOD_NO = s.SEQ_NO AND m.RECORD_STAT = 'O' AND m.KYC_CUST_TYPE IN ('R', 'C') ` +
      `AND m.MAKER_DT_STAMP >= TO_DATE(:since, 'YYYY-MM-DD"T"HH24:MI:SS'))`
    );
  }

  /** Read-only: the rows that satisfy the eligibility predicate (see neverSentPredicate). */
  async findNeverSentTechnicalErrors(
    since: string,
    errorCodes: string[],
    maxRows: number,
  ): Promise<StagingKey[]> {
    const binds: Record<string, string | number> = {
      errorStatus: StagingProcessStatus.ERROR,
      since,
      maxRows,
    };
    const placeholders = errorCodes.map((code, i) => {
      binds[`expectedResponse${i}`] = technicalErrorResponse(code);
      return `:expectedResponse${i}`;
    });
    const rows = await this.db.query(
      `SELECT s.KYC_REF_NO, s.SEQ_NO FROM ${this.table} s ` +
        `WHERE ${this.neverSentPredicate(placeholders.join(', '))} ` +
        `ORDER BY s.KYC_REF_NO FETCH FIRST :maxRows ROWS ONLY`,
      binds,
    );
    return rows.map((r) => ({ kycRefNo: String(r.KYC_REF_NO), seqNo: Number(r.SEQ_NO) }));
  }

  /**
   * E -> N for ONE row. The WHERE clause repeats the WHOLE eligibility predicate (ownership of the
   * MSGID, status, counters, empty request, KYC open at the same MOD_NO of a supported type since the
   * cut-off, exact RESPONSE marker) and the exact MSGID the backup recorded, so a row that changed
   * (or was replaced) after it was selected is not touched.
   * RESPONSE, RETRY_COUNT and RES_DATE are reset. Called ONLY by the reconciliation tool, after the
   * evidence checks and a verified backup.
   */
  async restoreNeverSent(
    key: StagingKey,
    errorCode: string,
    since: string,
    msgId: string,
    originalResDate: string | null,
  ): Promise<boolean> {
    const { rowsAffected } = await this.db.execute(
      `UPDATE ${this.table} s SET PROCESS_STATUS = :targetStatus, RESPONSE = NULL, ` +
        `RETRY_COUNT = 0, RES_DATE = NULL ` +
        `WHERE s.KYC_REF_NO = :kycRefNo AND s.SEQ_NO = :seqNo AND s.MSGID = :msgId ` +
        `AND (s.RES_DATE = TO_DATE(:originalResDate, 'YYYY-MM-DD"T"HH24:MI:SS') ` +
        `OR (s.RES_DATE IS NULL AND :originalResDate IS NULL)) ` +
        `AND ${this.neverSentPredicate(':expectedResponse0')}`,
      {
        targetStatus: StagingProcessStatus.NEW,
        errorStatus: StagingProcessStatus.ERROR,
        kycRefNo: key.kycRefNo,
        seqNo: key.seqNo,
        msgId,
        originalResDate,
        expectedResponse0: technicalErrorResponse(errorCode),
        since,
      },
    );
    return rowsAffected === 1;
  }

  /** The columns the rollback needs, as they are right now (read-only, one row). */
  async readRowForBackup(key: StagingKey): Promise<StagingBackupRow | null> {
    const rows = await this.db.query(
      `SELECT KYC_REF_NO, SEQ_NO, MSGID, PROCESS_STATUS, REQUEST, RESPONSE, RETRY_COUNT, ` +
        `TO_CHAR(REQ_DATE, 'YYYY-MM-DD"T"HH24:MI:SS') AS REQ_DATE_ISO, ` +
        `TO_CHAR(RES_DATE, 'YYYY-MM-DD"T"HH24:MI:SS') AS RES_DATE_ISO, REIS_FINAL_STATUS ` +
        `FROM ${this.table} WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo`,
      { kycRefNo: key.kycRefNo, seqNo: key.seqNo },
    );
    if (rows.length !== 1) return null;
    const r = rows[0];
    const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
    return {
      kycRefNo: String(r.KYC_REF_NO),
      seqNo: Number(r.SEQ_NO),
      msgId: text(r.MSGID),
      processStatus: text(r.PROCESS_STATUS),
      request: text(r.REQUEST),
      response: text(r.RESPONSE),
      retryCount:
        r.RETRY_COUNT === null || r.RETRY_COUNT === undefined ? null : Number(r.RETRY_COUNT),
      reqDate: text(r.REQ_DATE_ISO),
      resDate: text(r.RES_DATE_ISO),
      reisFinalStatus: text(r.REIS_FINAL_STATUS),
    };
  }

  /**
   * State a reconciled row is in right after the restore (and still is if nothing happened since):
   * N, ours, no request / response / dates / final status, RETRY_COUNT 0. The predicate shared by the
   * rollback check and the rollback UPDATE.
   */
  private restoredStatePredicate(): string {
    return (
      `KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo AND MSGID = :msgId ` +
      `AND PROCESS_STATUS = :currentStatus AND REQUEST IS NULL AND RESPONSE IS NULL ` +
      `AND REQ_DATE IS NULL AND RES_DATE IS NULL AND REIS_FINAL_STATUS IS NULL AND RETRY_COUNT = 0`
    );
  }

  private restoredStateBinds(row: StagingBackupRow) {
    return {
      kycRefNo: row.kycRefNo,
      seqNo: row.seqNo,
      msgId: row.msgId ?? '',
      currentStatus: StagingProcessStatus.NEW,
    };
  }

  /** Is the row still exactly in the state the reconciliation left it in? (read-only) */
  async isUntouchedSinceRestore(row: StagingBackupRow): Promise<boolean> {
    const rows = await this.db.query(
      `SELECT COUNT(*) AS N FROM ${this.table} WHERE ${this.restoredStatePredicate()}`,
      this.restoredStateBinds(row),
    );
    return Number(rows[0]?.N) === 1;
  }

  /**
   * Rollback of ONE reconciled row to the values saved in the backup (E, original RESPONSE, RETRY_COUNT
   * and RES_DATE). Only while the row is still exactly in the post-restore state: if the service has
   * claimed or sent it since, it is left alone (a person must decide).
   */
  async rollbackRestoredRow(row: StagingBackupRow): Promise<boolean> {
    const { rowsAffected } = await this.db.execute(
      `UPDATE ${this.table} SET PROCESS_STATUS = :originalStatus, RESPONSE = :originalResponse, ` +
        `RETRY_COUNT = :originalRetryCount, ` +
        `RES_DATE = TO_DATE(:originalResDate, 'YYYY-MM-DD"T"HH24:MI:SS') ` +
        `WHERE ${this.restoredStatePredicate()}`,
      {
        ...this.restoredStateBinds(row),
        originalStatus: row.processStatus,
        originalResponse: row.response,
        originalRetryCount: row.retryCount,
        originalResDate: row.resDate,
      },
    );
    return rowsAffected === 1;
  }

  /**
   * Our rows whose delivery to REIS is not known (send guard of the polling service): E rows marked
   * {"delivery":"UNCERTAIN"} and rows claimed for more than `minutes` (a pass died after the claim,
   * possibly after the REIS call). While any is unresolved, the sync sends nothing. Read-only.
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
