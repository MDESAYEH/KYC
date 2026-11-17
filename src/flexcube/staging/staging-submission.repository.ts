import { assertSafeTableName, IFlexcubeSqlExecutor, isUniqueViolation } from './flexcube-staging';

/** PROCESS_STATUS values agreed with Finexta. */
export enum StagingProcessStatus {
  NEW = 'N',
  IN_PROGRESS = 'W',
  SUCCESS = 'S',
  ERROR = 'E',
}

export interface StagingKey {
  kycRefNo: string;
  seqNo: number;
}

/**
 * Submission lifecycle in STTM_KYC_REIS_PAYLOAD_CUSTOM (one row per KYC_REF_NO + SEQ_NO):
 *   insertNew  -> N   (row created by the integration layer when a saved KYC is detected)
 *   claim      -> W   (only from N: exactly one worker sends the submission; REQ_DATE = now)
 *   complete   -> S   (REIS answered: REQUEST / RESPONSE stored; RES_DATE = now)
 *              -> E   (any failure: RETRY_COUNT + 1, REQUEST / RESPONSE stored when available;
 *                      RES_DATE = now)
 * REQ_DATE / RES_DATE were added by Finexta for monitoring (10/11/2026); database time (SYSDATE).
 * REIS_FINAL_STATUS is written separately by StagingFlexcubeStatusUpdater.
 * Every value is a bind variable; only the (validated) table name is part of the SQL text.
 */
export class StagingSubmissionRepository {
  private readonly table: string;

  constructor(
    private readonly db: IFlexcubeSqlExecutor,
    table: string,
  ) {
    this.table = assertSafeTableName(table);
  }

  /** Creates the row in N. Returns false when the row already exists (nothing changed). */
  async insertNew(key: StagingKey, msgId: string): Promise<boolean> {
    try {
      await this.db.execute(
        `INSERT INTO ${this.table} (KYC_REF_NO, SEQ_NO, MSGID, PROCESS_STATUS, RETRY_COUNT) ` +
          `VALUES (:kycRefNo, :seqNo, :msgId, :status, 0)`,
        { kycRefNo: key.kycRefNo, seqNo: key.seqNo, msgId, status: StagingProcessStatus.NEW },
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
      `UPDATE ${this.table} SET PROCESS_STATUS = :to, REQ_DATE = SYSDATE ` +
        `WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo AND PROCESS_STATUS = :from`,
      {
        to: StagingProcessStatus.IN_PROGRESS,
        from: StagingProcessStatus.NEW,
        kycRefNo: key.kycRefNo,
        seqNo: key.seqNo,
      },
    );
    return rowsAffected === 1;
  }

  /**
   * N or W -> E for a submission that failed at any step (including the claim itself): RETRY_COUNT
   * + 1, RESPONSE = the technical code, RES_DATE = now. False when no such row was left.
   */
  async fail(key: StagingKey, response: object): Promise<boolean> {
    const { rowsAffected } = await this.db.execute(
      `UPDATE ${this.table} SET PROCESS_STATUS = :status, RESPONSE = :response, ` +
        `RETRY_COUNT = NVL(RETRY_COUNT, 0) + 1, RES_DATE = SYSDATE ` +
        `WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo ` +
        `AND PROCESS_STATUS IN (:fromNew, :fromWork)`,
      {
        status: StagingProcessStatus.ERROR,
        response: JSON.stringify(response),
        kycRefNo: key.kycRefNo,
        seqNo: key.seqNo,
        fromNew: StagingProcessStatus.NEW,
        fromWork: StagingProcessStatus.IN_PROGRESS,
      },
    );
    return rowsAffected === 1;
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
      `UPDATE ${this.table} SET PROCESS_STATUS = :status, ` +
        `REQUEST = COALESCE(:request, REQUEST), RESPONSE = COALESCE(:response, RESPONSE), ` +
        `RETRY_COUNT = NVL(RETRY_COUNT, 0) + :retry, RES_DATE = SYSDATE ` +
        `WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo AND PROCESS_STATUS = :from`,
      {
        status: outcome.status,
        request: outcome.request === undefined ? null : JSON.stringify(outcome.request),
        response: outcome.response === undefined ? null : JSON.stringify(outcome.response),
        retry,
        kycRefNo: key.kycRefNo,
        seqNo: key.seqNo,
        from: StagingProcessStatus.IN_PROGRESS,
      },
    );
    if (rowsAffected !== 1) {
      throw new Error(`Staging row ${key.kycRefNo}/${key.seqNo} is not in progress`);
    }
  }
}
