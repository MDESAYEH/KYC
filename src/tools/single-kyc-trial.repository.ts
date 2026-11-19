import {
  IFlexcubeSqlExecutor,
  assertSafeTableName,
  OWN_MSGID_PATTERN,
} from '../flexcube/staging/flexcube-staging';
import {
  StagingSubmissionRepository,
  StagingBackupRow,
  assertSafeStatusCode,
} from '../flexcube/staging/staging-submission.repository';
import {
  SINGLE_KYC_TRIAL as TARGET,
  SingleTrialRefusedError,
  trialHash,
} from './single-kyc-trial.contract';
import { assertValidBinds } from '../flexcube/staging/sql-binds';

/** Trigger table of Finexta (STTM_CUSTOMER_CUSTOM.READY_TO_SCAN): FCUBS writes U, the API writes P or E. */
export const TRIGGER_TABLE = 'STTM_CUSTOMER_CUSTOM';
export const TRIGGER = Object.freeze({ ready: 'U', picked: 'P', error: 'E' });

/** A technical error written before anything reached REIS, e.g. {"error":"ORA-01745"}. */
const NEVER_SENT_RESPONSE = /^\{"error":"(ORA|NJS|DPI)-\d{3,5}"\}$/;

/**
 * The staging row is still tied to the version being sent: the CIF revision equals SEQ_NO
 * (Finexta 19/11/2026: SEQ_NO = STTM_CUSTOMER.MOD_NO) and the KYC is still open.
 */
const versionHolds = (cifBind: string) =>
  `EXISTS (SELECT 1 FROM STTM_CUSTOMER c WHERE c.CUSTOMER_NO = ${cifBind} AND c.MOD_NO = s.SEQ_NO)
        AND EXISTS (SELECT 1 FROM STTM_KYC_MASTER m WHERE m.KYC_REF_NO = s.KYC_REF_NO AND m.RECORD_STAT = 'O')`;

/** The trigger row of this CIF / KYC is at the given status. */
const triggerAt = (statusBind: string) =>
  `EXISTS (SELECT 1 FROM ${TRIGGER_TABLE} t WHERE t.CUSTOMER_NO = :cif AND t.KYC_REF_NO = s.KYC_REF_NO
          AND t.READY_TO_SCAN = ${statusBind})`;

export class SingleKycTrialRepository {
  readonly staging: StagingSubmissionRepository;
  readonly claimSql: string;
  readonly restoreSql: string;
  readonly markPickedSql: string;
  readonly claimSqlSha256: string;
  private readonly table: string;
  constructor(
    private readonly db: IFlexcubeSqlExecutor,
    table: string,
    private readonly inProgress = 'W',
  ) {
    this.table = assertSafeTableName(table);
    assertSafeStatusCode(inProgress);
    if (['N', 'E', 'S'].includes(inProgress))
      throw new SingleTrialRefusedError('IN_PROGRESS_STATUS_UNSAFE');
    this.staging = new StagingSubmissionRepository(db, this.table, inProgress);
    this.claimSql = `UPDATE ${this.table} s SET PROCESS_STATUS = :targetStatus, REQ_DATE = SYSDATE
      WHERE s.KYC_REF_NO = :kycRefNo AND s.SEQ_NO = :seqNo AND s.MSGID = :msgId
        AND s.PROCESS_STATUS = :sourceStatus AND s.REQUEST IS NULL AND s.RESPONSE IS NULL
        AND s.REQ_DATE IS NULL AND s.RES_DATE IS NULL AND s.REIS_FINAL_STATUS IS NULL
        AND NVL(s.RETRY_COUNT, 0) = 0
        AND ${versionHolds(':cif')}
        AND ${triggerAt(':readyStatus')}`;
    this.restoreSql = `UPDATE ${this.table} s SET PROCESS_STATUS = :targetStatus, RESPONSE = NULL,
        RETRY_COUNT = 0, RES_DATE = NULL
      WHERE s.KYC_REF_NO = :kycRefNo AND s.SEQ_NO = :seqNo AND s.MSGID = :msgId
        AND s.PROCESS_STATUS = :errorStatus AND s.REQUEST IS NULL AND s.REQ_DATE IS NULL
        AND s.REIS_FINAL_STATUS IS NULL AND s.RETRY_COUNT = 1
        AND TO_CHAR(SUBSTR(s.RESPONSE, 1, 200)) = :expectedResponse
        AND ${versionHolds(':cif')}
        AND ${triggerAt(':readyStatus')}`;
    this.markPickedSql = `UPDATE ${TRIGGER_TABLE} t SET READY_TO_SCAN = :pickedStatus
      WHERE t.CUSTOMER_NO = :cif AND t.KYC_REF_NO = :kycRefNo AND t.READY_TO_SCAN = :readyStatus
        AND EXISTS (SELECT 1 FROM STTM_CUSTOMER c WHERE c.CUSTOMER_NO = t.CUSTOMER_NO AND c.MOD_NO = :seqNo)`;
    // One hash for every statement that writes before REIS is called (the approval pins all three).
    this.claimSqlSha256 = trialHash([this.restoreSql, this.claimSql, this.markPickedSql]);
  }
  async master() {
    const rows = await this.db.query(
      `SELECT KYC_REF_NO, MOD_NO, KYC_CUST_TYPE, RECORD_STAT FROM STTM_KYC_MASTER
      WHERE KYC_REF_NO = :kycRefNo AND RECORD_STAT = 'O'`,
      { kycRefNo: TARGET.kycRefNo },
    );
    if (rows.length !== 1 || !['R', 'C'].includes(String(rows[0].KYC_CUST_TYPE)))
      throw new SingleTrialRefusedError('TARGET_VERSION_NOT_OPEN_OR_AMBIGUOUS');
    return rows[0];
  }
  key() {
    return { kycRefNo: TARGET.kycRefNo, seqNo: TARGET.seqNo };
  }
  read(): Promise<StagingBackupRow | null> {
    return this.staging.readRowForBackup(this.key());
  }
  /**
   * Allowed: no row, our untouched N row, or our E row whose only content is a technical error written
   * before REIS was called (e.g. the ORA-01745 claim failure of 17/11/2026): that row is reused, because
   * SEQ_NO = CIF MOD_NO names this exact version. Anything else is refused.
   */
  assertNeverSent(row: StagingBackupRow | null): void {
    if (!row) return;
    const own =
      row.kycRefNo === TARGET.kycRefNo &&
      row.seqNo === TARGET.seqNo &&
      new RegExp(OWN_MSGID_PATTERN, 'i').test(row.msgId ?? '') &&
      row.request === null &&
      row.reqDate === null &&
      row.reisFinalStatus === null;
    const untouchedNew =
      row.processStatus === 'N' &&
      row.response === null &&
      row.resDate === null &&
      (row.retryCount ?? 0) === 0;
    if (own && (untouchedNew || this.isNeverSentError(row))) return;
    throw new SingleTrialRefusedError('STAGING_NOT_UNTOUCHED_NEW');
  }
  isNeverSentError(row: StagingBackupRow): boolean {
    return (
      row.processStatus === 'E' &&
      row.retryCount === 1 &&
      NEVER_SENT_RESPONSE.test(row.response ?? '')
    );
  }
  /** E (never sent) -> N, same MSGID; only while the CIF version and the U trigger still hold. */
  async restoreNeverSent(row: StagingBackupRow): Promise<boolean> {
    if (!this.isNeverSentError(row) || !row.msgId) return false;
    const binds = {
      ...this.key(),
      msgId: row.msgId,
      cif: TARGET.expectedCif,
      targetStatus: 'N',
      errorStatus: 'E',
      expectedResponse: row.response,
      readyStatus: TRIGGER.ready,
    };
    assertValidBinds(this.restoreSql, binds);
    return (await this.db.execute(this.restoreSql, binds)).rowsAffected === 1;
  }
  /** U -> P, only after our row is claimed and only while the CIF is still at SEQ_NO. */
  async markPicked(): Promise<boolean> {
    const binds = {
      ...this.key(),
      cif: TARGET.expectedCif,
      pickedStatus: TRIGGER.picked,
      readyStatus: TRIGGER.ready,
    };
    assertValidBinds(this.markPickedSql, binds);
    return (await this.db.execute(this.markPickedSql, binds)).rowsAffected === 1;
  }
  /** P -> E after a failed / uncertain send. A row FCUBS has set back to U is left alone. */
  async markTriggerError(): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE ${TRIGGER_TABLE} t SET READY_TO_SCAN = :errorStatus
      WHERE t.CUSTOMER_NO = :cif AND t.KYC_REF_NO = :kycRefNo AND t.READY_TO_SCAN = :pickedStatus
        AND EXISTS (SELECT 1 FROM STTM_CUSTOMER c WHERE c.CUSTOMER_NO = t.CUSTOMER_NO AND c.MOD_NO = :seqNo)`,
      {
        ...this.key(),
        cif: TARGET.expectedCif,
        errorStatus: TRIGGER.error,
        pickedStatus: TRIGGER.picked,
      },
    );
    return result.rowsAffected === 1;
  }
  /** Gives our claim back (W -> N) when nothing was stored yet. */
  async release(msgId: string): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE ${this.table} s SET PROCESS_STATUS = :targetStatus, REQ_DATE = NULL
      WHERE s.KYC_REF_NO = :kycRefNo AND s.SEQ_NO = :seqNo AND s.MSGID = :msgId
        AND s.PROCESS_STATUS = :workStatus AND s.REQUEST IS NULL`,
      { ...this.key(), msgId, targetStatus: 'N', workStatus: this.inProgress },
    );
    return result.rowsAffected === 1;
  }
  async claim(msgId: string): Promise<boolean> {
    const binds = {
      ...this.key(),
      msgId,
      cif: TARGET.expectedCif,
      targetStatus: this.inProgress,
      sourceStatus: 'N',
      readyStatus: TRIGGER.ready,
    };
    assertValidBinds(this.claimSql, binds);
    return (await this.db.execute(this.claimSql, binds)).rowsAffected === 1;
  }
  async storeIntent(msgId: string, request: object): Promise<void> {
    const result = await this.db.execute(
      `UPDATE ${this.table} s SET REQUEST = :requestJson
      WHERE s.KYC_REF_NO = :kycRefNo AND s.SEQ_NO = :seqNo AND s.MSGID = :msgId
        AND s.PROCESS_STATUS = :workStatus AND s.REQUEST IS NULL AND s.RESPONSE IS NULL
        AND ${versionHolds(':cif')}
        AND ${triggerAt(':pickedStatus')}`,
      {
        ...this.key(),
        msgId,
        cif: TARGET.expectedCif,
        requestJson: JSON.stringify(request),
        workStatus: this.inProgress,
        pickedStatus: TRIGGER.picked,
      },
    );
    if (result.rowsAffected !== 1) throw new SingleTrialRefusedError('INTENT_OR_VERSION_CHANGED');
  }
  async writeWireStatus(status: 'CLEAN' | 'PENDING' | 'BLOCKED', msgId: string): Promise<void> {
    const result = await this.db.execute(
      `UPDATE ${this.table} SET REIS_FINAL_STATUS = :wireStatus
      WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo AND MSGID = :msgId
        AND PROCESS_STATUS = :successStatus AND REQUEST IS NOT NULL AND RESPONSE IS NOT NULL
        AND (REIS_FINAL_STATUS IS NULL OR REIS_FINAL_STATUS = :wireStatus)`,
      { ...this.key(), msgId, wireStatus: status, successStatus: 'S' },
    );
    if (result.rowsAffected !== 1)
      throw new SingleTrialRefusedError('EXACT_STATUS_UPDATE_NOT_ACKNOWLEDGED');
  }
  async complete(msgId: string, response: object, success: boolean): Promise<void> {
    const result = await this.db.execute(
      `UPDATE ${this.table} SET PROCESS_STATUS = :resultStatus,
        RESPONSE = :responseJson, RES_DATE = SYSDATE, RETRY_COUNT = NVL(RETRY_COUNT, 0) + :retryIncrement
      WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo AND MSGID = :msgId
        AND PROCESS_STATUS = :workStatus AND REQUEST IS NOT NULL`,
      {
        ...this.key(),
        msgId,
        resultStatus: success ? 'S' : 'E',
        responseJson: JSON.stringify(response),
        retryIncrement: success ? 0 : 1,
        workStatus: this.inProgress,
      },
    );
    if (result.rowsAffected !== 1)
      throw new SingleTrialRefusedError('RESPONSE_RECORDING_NOT_ACKNOWLEDGED');
  }
}
