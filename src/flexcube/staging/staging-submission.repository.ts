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

/** A staging row exactly as it is (read for the single-KYC trial's plan, evidence and reset). */
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

  /** The row as it is right now (read-only, one row). */
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

  /**
   * W -> S or E, storing the REIS request / response JSON when known.
   * REQUEST / RESPONSE are CLOB: a value is bound DIRECTLY to the column (no COALESCE / NVL / TO_CLOB around
   * the bind). COALESCE(:bind, CLOB) failed on real Oracle with ORA-00932 (isolated test, 19/11/2026), and a
   * bind inside a SQL function is limited to the VARCHAR2 size, while a direct bind to a CLOB column is not.
   * A column without a value is simply left out of the SET list, so it keeps what it had.
   */
  async complete(
    key: StagingKey,
    outcome: {
      status: StagingProcessStatus.SUCCESS | StagingProcessStatus.ERROR;
      request?: object;
      response?: object;
    },
  ): Promise<void> {
    const retry = outcome.status === StagingProcessStatus.ERROR ? 1 : 0;
    const set = ['PROCESS_STATUS = :targetStatus'];
    const binds: Record<string, string | number> = {
      targetStatus: outcome.status,
      retryIncrement: retry,
      kycRefNo: key.kycRefNo,
      seqNo: key.seqNo,
      sourceStatus: this.inProgress,
    };
    if (outcome.request !== undefined) {
      set.push('REQUEST = :requestJson');
      binds.requestJson = JSON.stringify(outcome.request);
    }
    if (outcome.response !== undefined) {
      set.push('RESPONSE = :responseJson');
      binds.responseJson = JSON.stringify(outcome.response);
    }
    const { rowsAffected } = await this.db.execute(
      `UPDATE ${this.table} SET ${set.join(', ')}, ` +
        `RETRY_COUNT = NVL(RETRY_COUNT, 0) + :retryIncrement, RES_DATE = SYSDATE ` +
        `WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo AND PROCESS_STATUS = :sourceStatus`,
      binds,
    );
    if (rowsAffected !== 1) {
      throw new Error(`Staging row is not in progress`);
    }
  }
}
