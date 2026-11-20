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

export interface StagingKey {
  kycRefNo: string;
  seqNo: number;
}

/**
 * Submission lifecycle in STTM_KYC_REIS_PAYLOAD_CUSTOM (one row per KYC_REF_NO + SEQ_NO):
 *
 *   insertNew      -> N  row created for a new CIF revision (MSGID = our UUID, RETRY_COUNT 0)
 *   claim          N -> W  exactly one worker sends it; REQ_DATE = now
 *   release        W -> N  technical failure before REIS was called (nothing counted)
 *   scheduleRetry  W -> N  the attempt failed and may be repeated: RETRY_COUNT + 1, RES_DATE = now
 *   recoverStale   W -> N  a worker died while the row was claimed: RETRY_COUNT + 1, RES_DATE = now
 *   complete       W -> S  REIS answered (or W -> E after the last attempt); RES_DATE = now
 *   fail           N/W -> E  the KYC itself cannot be sent (data error, attempts exhausted)
 *   reclaimFailed  E -> W  recheck of a validation failure or a REIS data refusal: RETRY_COUNT reset to 0
 *   unclaimFailed  W -> E  the recheck stopped before REIS (technical error, trigger moved)
 *
 * REIS_FINAL_STATUS is written separately (StagingFlexcubeStatusUpdater). Only our own rows (UUID MSGID) are
 * recovered. Every value is a bind; only the validated table name is in the SQL text. Bind names are never
 * Oracle reserved words (ORA-01745), and CLOB values are bound directly to the column, never inside a SQL
 * function (ORA-00932 with COALESCE on UAT1).
 */
export class StagingSubmissionRepository {
  private readonly table: string;
  private readonly inProgress: string;

  constructor(
    private readonly db: IFlexcubeSqlExecutor,
    table: string,
    inProgress: string = StagingProcessStatus.IN_PROGRESS,
  ) {
    this.table = assertSafeTableName(table);
    this.inProgress = assertSafeStatusCode(inProgress);
  }

  /** Creates the row in N. False when it already exists (nothing changed). */
  async insertNew(key: StagingKey, msgId: string): Promise<boolean> {
    try {
      await this.db.execute(
        `INSERT INTO ${this.table} (KYC_REF_NO, SEQ_NO, MSGID, PROCESS_STATUS, RETRY_COUNT) ` +
          `VALUES (:kycRefNo, :seqNo, :msgId, :initialStatus, 0)`,
        { ...key, msgId, initialStatus: StagingProcessStatus.NEW },
      );
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /** N -> W. True only for the single caller that moved the row. */
  async claim(key: StagingKey): Promise<boolean> {
    return this.move(key, StagingProcessStatus.NEW, this.inProgress, 'REQ_DATE = SYSDATE');
  }

  /** W -> N after a technical failure before the REIS call; the attempt is not counted. */
  async release(key: StagingKey): Promise<boolean> {
    return this.move(key, this.inProgress, StagingProcessStatus.NEW, 'REQ_DATE = NULL');
  }

  /**
   * E -> W for a recheck: only a row that failed validation or whose data REIS refused (RESPONSE carries one of
   * the markers). RETRY_COUNT restarts at 0.
   */
  async reclaimFailed(
    key: StagingKey,
    markers: readonly [string, string, string],
  ): Promise<boolean> {
    const { rowsAffected } = await this.db.execute(
      `UPDATE ${this.table} SET PROCESS_STATUS = :targetStatus, REQ_DATE = SYSDATE, RETRY_COUNT = 0 ` +
        `WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo AND PROCESS_STATUS = :sourceStatus ` +
        `AND (INSTR(RESPONSE, :validationMarker) > 0 OR INSTR(RESPONSE, :rejectedMarker) > 0 ` +
        `OR INSTR(RESPONSE, :refusedAgainMarker) > 0)`,
      {
        ...key,
        targetStatus: this.inProgress,
        sourceStatus: StagingProcessStatus.ERROR,
        validationMarker: markers[0],
        rejectedMarker: markers[1],
        refusedAgainMarker: markers[2],
      },
    );
    return rowsAffected === 1;
  }

  /** W -> E: a recheck stopped before REIS; the row keeps its previous RESPONSE. */
  async unclaimFailed(key: StagingKey): Promise<boolean> {
    return this.move(key, this.inProgress, StagingProcessStatus.ERROR, 'RES_DATE = SYSDATE');
  }

  /** W -> N for another attempt later: stores what is known, RETRY_COUNT + 1, RES_DATE = now. */
  async scheduleRetry(key: StagingKey, attempt: { request?: object; response: object }) {
    await this.finish(key, StagingProcessStatus.NEW, attempt, true);
  }

  /** W -> S (REIS answered) or W -> E (last attempt failed, counted). */
  async complete(
    key: StagingKey,
    outcome: {
      status: StagingProcessStatus.SUCCESS | StagingProcessStatus.ERROR;
      request?: object;
      response?: object;
    },
  ): Promise<void> {
    await this.finish(key, outcome.status, outcome, outcome.status === StagingProcessStatus.ERROR);
  }

  /** N or W -> E: the KYC cannot be sent (RESPONSE = the reason code). */
  async fail(key: StagingKey, response: object): Promise<boolean> {
    const { rowsAffected } = await this.db.execute(
      `UPDATE ${this.table} SET PROCESS_STATUS = :targetStatus, RESPONSE = :responseJson, ` +
        `RES_DATE = SYSDATE WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo ` +
        `AND PROCESS_STATUS IN (:sourceStatusNew, :sourceStatusWork)`,
      {
        ...key,
        targetStatus: StagingProcessStatus.ERROR,
        responseJson: JSON.stringify(response),
        sourceStatusNew: StagingProcessStatus.NEW,
        sourceStatusWork: this.inProgress,
      },
    );
    return rowsAffected === 1;
  }

  /**
   * Our rows claimed for more than `minutes` (the worker died, possibly during the REIS call) go back to N
   * as a counted attempt, so the retry pass picks them up. Returns how many rows were recovered.
   */
  async recoverStale(minutes: number): Promise<number> {
    const { rowsAffected } = await this.db.execute(
      `UPDATE ${this.table} SET PROCESS_STATUS = :targetStatus, ` +
        `RETRY_COUNT = NVL(RETRY_COUNT, 0) + 1, RES_DATE = SYSDATE ` +
        `WHERE PROCESS_STATUS = :sourceStatus AND REQ_DATE < SYSDATE - (:ageMinutes / 1440) ` +
        `AND REGEXP_LIKE(MSGID, '${OWN_MSGID_PATTERN}', 'i')`,
      {
        targetStatus: StagingProcessStatus.NEW,
        sourceStatus: this.inProgress,
        ageMinutes: minutes,
      },
    );
    return rowsAffected;
  }

  private async move(key: StagingKey, from: string, to: string, extra: string): Promise<boolean> {
    const { rowsAffected } = await this.db.execute(
      `UPDATE ${this.table} SET PROCESS_STATUS = :targetStatus, ${extra} ` +
        `WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo AND PROCESS_STATUS = :sourceStatus`,
      { ...key, targetStatus: to, sourceStatus: from },
    );
    return rowsAffected === 1;
  }

  /** W -> target, storing REQUEST / RESPONSE when given (a column without a value keeps what it had). */
  private async finish(
    key: StagingKey,
    target: string,
    data: { request?: object; response?: object },
    countAttempt: boolean,
  ): Promise<void> {
    const set = ['PROCESS_STATUS = :targetStatus'];
    const binds: Record<string, string | number> = {
      ...key,
      targetStatus: target,
      sourceStatus: this.inProgress,
      retryIncrement: countAttempt ? 1 : 0,
    };
    if (data.request !== undefined) {
      set.push('REQUEST = :requestJson');
      binds.requestJson = JSON.stringify(data.request);
    }
    if (data.response !== undefined) {
      set.push('RESPONSE = :responseJson');
      binds.responseJson = JSON.stringify(data.response);
    }
    const { rowsAffected } = await this.db.execute(
      `UPDATE ${this.table} SET ${set.join(', ')}, ` +
        `RETRY_COUNT = NVL(RETRY_COUNT, 0) + :retryIncrement, RES_DATE = SYSDATE ` +
        `WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo AND PROCESS_STATUS = :sourceStatus`,
      binds,
    );
    if (rowsAffected !== 1) throw new Error('Staging row is not in progress');
  }
}
