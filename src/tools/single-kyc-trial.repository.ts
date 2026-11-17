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

export class SingleKycTrialRepository {
  readonly staging: StagingSubmissionRepository;
  readonly claimSql: string;
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
        AND EXISTS (SELECT 1 FROM STTM_KYC_MASTER m WHERE m.KYC_REF_NO = s.KYC_REF_NO
          AND m.MOD_NO = s.SEQ_NO AND m.RECORD_STAT = 'O')`;
    this.claimSqlSha256 = trialHash(this.claimSql);
  }
  async master() {
    const rows = await this.db.query(
      `SELECT KYC_REF_NO, MOD_NO, KYC_CUST_TYPE, RECORD_STAT FROM STTM_KYC_MASTER
      WHERE KYC_REF_NO = :kycRefNo AND MOD_NO = :seqNo AND RECORD_STAT = 'O'`,
      this.key(),
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
  assertNeverSent(row: StagingBackupRow | null): void {
    if (!row) return;
    if (
      row.kycRefNo !== TARGET.kycRefNo ||
      row.seqNo !== TARGET.seqNo ||
      row.processStatus !== 'N' ||
      !new RegExp(OWN_MSGID_PATTERN, 'i').test(row.msgId ?? '') ||
      row.request !== null ||
      row.response !== null ||
      row.reqDate !== null ||
      row.resDate !== null ||
      row.reisFinalStatus !== null ||
      (row.retryCount ?? 0) !== 0
    )
      throw new SingleTrialRefusedError('STAGING_NOT_UNTOUCHED_NEW');
  }
  async claim(msgId: string): Promise<boolean> {
    const binds = { ...this.key(), msgId, targetStatus: this.inProgress, sourceStatus: 'N' };
    assertValidBinds(this.claimSql, binds);
    return (await this.db.execute(this.claimSql, binds)).rowsAffected === 1;
  }
  async storeIntent(msgId: string, request: object): Promise<void> {
    const result = await this.db.execute(
      `UPDATE ${this.table} s SET REQUEST = :requestJson
      WHERE s.KYC_REF_NO = :kycRefNo AND s.SEQ_NO = :seqNo AND s.MSGID = :msgId
        AND s.PROCESS_STATUS = :workStatus AND s.REQUEST IS NULL AND s.RESPONSE IS NULL
        AND EXISTS (SELECT 1 FROM STTM_KYC_MASTER m WHERE m.KYC_REF_NO = s.KYC_REF_NO
          AND m.MOD_NO = s.SEQ_NO AND m.RECORD_STAT = 'O')`,
      { ...this.key(), msgId, requestJson: JSON.stringify(request), workStatus: this.inProgress },
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
