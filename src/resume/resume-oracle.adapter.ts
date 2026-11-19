import {
  assertSafeTableName,
  IFlexcubeSqlExecutor,
  SqlBinds,
  SqlRow,
} from '../flexcube/staging/flexcube-staging';
import { SINGLE_KYC_TRIAL as TARGET, trialHash } from '../tools/single-kyc-trial.contract';
import { ReisRawResponse } from '../reis/transport/reis-http.transport';
import { parseJsonBody, parseOnboardingResponse } from '../reis/reis-response.parser';

export interface TransactionalOracle extends IFlexcubeSqlExecutor {
  transaction<T>(work: (db: IFlexcubeSqlExecutor) => Promise<T>): Promise<T>;
}
export interface ResumeOracleNames {
  customer: string;
  master: string;
  trigger: string;
  stage: string;
  receipt: string;
}
export interface OracleResumeState {
  modNo: number;
  readyToScan: string;
  open: boolean;
  higherRevisionExists: boolean;
  stage: SqlRow;
}
const KEY = { cif: TARGET.expectedCif, kycRefNo: TARGET.kycRefNo, seqNo: TARGET.seqNo };
const must = (ok: unknown, code: string): void => {
  if (!ok) throw Error(code);
};

/** DDL artifact only; never executed by this adapter or a CLI. */
export function resumeReceiptDdl(table: string): string {
  return `CREATE TABLE ${assertSafeTableName(table)} (
    CIF VARCHAR2(64) NOT NULL, KYC_REF_NO VARCHAR2(64) NOT NULL, SEQ_NO NUMBER NOT NULL,
    ATTEMPT_ID VARCHAR2(64) NOT NULL UNIQUE, PLAN_SHA256 VARCHAR2(64) NOT NULL,
    PHASE VARCHAR2(20) NOT NULL, ORIGINAL_SNAPSHOT CLOB NOT NULL,
    CLAIMED_SNAPSHOT CLOB, DISPATCH_SNAPSHOT CLOB, COMPLETED_SNAPSHOT CLOB, RESULT_SHA256 VARCHAR2(64),
    PRIMARY KEY(CIF,KYC_REF_NO,SEQ_NO))`;
}
export function resumeReceiptProtectionDdl(table: string): string {
  const name = assertSafeTableName(table);
  return `CREATE OR REPLACE TRIGGER ${assertSafeTableName(name + '_GUARD')}
    BEFORE UPDATE OR DELETE ON ${name} FOR EACH ROW
    BEGIN
      IF DELETING OR UPDATING('CIF') OR UPDATING('KYC_REF_NO') OR UPDATING('SEQ_NO')
        OR UPDATING('ATTEMPT_ID') OR UPDATING('PLAN_SHA256') OR UPDATING('ORIGINAL_SNAPSHOT') THEN
        RAISE_APPLICATION_ERROR(-20001,'Permanent resume receipt and original evidence are immutable');
      END IF;
      IF :OLD.CLAIMED_SNAPSHOT IS NOT NULL AND UPDATING('CLAIMED_SNAPSHOT') THEN
        RAISE_APPLICATION_ERROR(-20002,'Claimed evidence is immutable');
      END IF;
      IF :OLD.DISPATCH_SNAPSHOT IS NOT NULL AND UPDATING('DISPATCH_SNAPSHOT') THEN
        RAISE_APPLICATION_ERROR(-20003,'Dispatch evidence is immutable');
      END IF;
      IF :OLD.PHASE='COMPLETED' THEN
        RAISE_APPLICATION_ERROR(-20004,'Completed receipt is immutable');
      END IF;
      IF UPDATING('PHASE') AND NOT (:OLD.PHASE='CLAIMED' AND :NEW.PHASE='DISPATCHED'
        OR :OLD.PHASE='DISPATCHED' AND :NEW.PHASE='COMPLETED') THEN
        RAISE_APPLICATION_ERROR(-20005,'Resume phase regression refused');
      END IF;
    END;`;
}
export function decisionFromWire(wire: ReisRawResponse, rejectApproved: boolean) {
  must(wire.status >= 200 && wire.status < 300, 'RESUME_REAL_2XX_REQUIRED');
  const parsed = parseOnboardingResponse(parseJsonBody(wire.body, 'searchOnboardCustomer'));
  if (parsed.status === 'REJECT')
    must(rejectApproved === true, 'RESUME_REJECT_MAPPING_NOT_APPROVED');
  return { parsed, finalStatus: parsed.status === 'REJECT' ? 'BLOCKED' : parsed.status };
}

/** No config loading or HTTP. Only exact revision locks and durable Oracle receipts. */
export class ResumeOracleAdapter {
  private readonly names: ResumeOracleNames;
  constructor(
    private readonly db: TransactionalOracle,
    names: ResumeOracleNames = {
      customer: 'STTM_CUSTOMER',
      master: 'STTM_KYC_MASTER',
      trigger: 'STTM_CUSTOMER_CUSTOM',
      stage: 'STTM_KYC_REIS_PAYLOAD_CUSTOM',
      receipt: 'KYC_RESUME_RECEIPT_CUSTOM',
    },
  ) {
    this.names = Object.fromEntries(
      Object.entries(names).map(([k, v]) => [k, assertSafeTableName(v)]),
    ) as unknown as ResumeOracleNames;
  }
  private async one(db: IFlexcubeSqlExecutor, sql: string, binds: SqlBinds): Promise<SqlRow> {
    const rows = await db.query(sql, binds);
    must(rows.length === 1, 'RESUME_ROW_MISSING_OR_AMBIGUOUS');
    return rows[0];
  }
  async read(db: IFlexcubeSqlExecutor = this.db, lock = false): Promise<OracleResumeState> {
    const n = this.names,
      suffix = lock ? ' FOR UPDATE NOWAIT' : '';
    const c = await this.one(
      db,
      `SELECT MOD_NO FROM ${n.customer} WHERE CUSTOMER_NO=:cif${suffix}`,
      { cif: KEY.cif },
    );
    const m = await this.one(
      db,
      `SELECT RECORD_STAT FROM ${n.master} WHERE KYC_REF_NO=:kycRefNo${suffix}`,
      { kycRefNo: KEY.kycRefNo },
    );
    const stage = await this.one(
      db,
      `SELECT KYC_REF_NO,SEQ_NO,MSGID,PROCESS_STATUS,REQUEST,RESPONSE,REIS_FINAL_STATUS,RETRY_COUNT,
      TO_CHAR(REQ_DATE,'YYYY-MM-DD HH24:MI:SS') AS REQ_DATE, TO_CHAR(RES_DATE,'YYYY-MM-DD HH24:MI:SS') AS RES_DATE
      FROM ${n.stage} WHERE KYC_REF_NO=:kycRefNo AND SEQ_NO=:seqNo${suffix}`,
      { kycRefNo: KEY.kycRefNo, seqNo: KEY.seqNo },
    );
    const t = await this.one(
      db,
      `SELECT READY_TO_SCAN FROM ${n.trigger} WHERE CUSTOMER_NO=:cif AND KYC_REF_NO=:kycRefNo${suffix}`,
      { cif: KEY.cif, kycRefNo: KEY.kycRefNo },
    );
    const higher = await this.one(
      db,
      `SELECT COUNT(*) AS N FROM ${n.stage} WHERE KYC_REF_NO=:kycRefNo AND SEQ_NO>:seqNo`,
      { kycRefNo: KEY.kycRefNo, seqNo: KEY.seqNo },
    );
    return {
      modNo: Number(c.MOD_NO),
      readyToScan: String(t.READY_TO_SCAN),
      open: m.RECORD_STAT === 'O',
      higherRevisionExists: Number(higher.N) > 0,
      stage,
    };
  }
  private version(s: OracleResumeState): void {
    must(
      s.modNo === KEY.seqNo &&
        s.stage.SEQ_NO === KEY.seqNo &&
        s.stage.KYC_REF_NO === KEY.kycRefNo &&
        s.open &&
        !s.higherRevisionExists,
      'RESUME_VERSION_OR_OPEN_STATE_CHANGED',
    );
  }
  private async changed(db: IFlexcubeSqlExecutor, sql: string, binds: SqlBinds): Promise<void> {
    must((await db.execute(sql, binds)).rowsAffected === 1, 'RESUME_CAS_NOT_ACQUIRED');
  }
  private receipt(db: IFlexcubeSqlExecutor, attemptId: string): Promise<SqlRow> {
    return this.one(
      db,
      `SELECT * FROM ${this.names.receipt} WHERE CIF=:cif AND KYC_REF_NO=:kycRefNo AND SEQ_NO=:seqNo AND ATTEMPT_ID=:attemptId FOR UPDATE NOWAIT`,
      { ...KEY, attemptId },
    );
  }
  private matches(s: OracleResumeState, json: unknown): void {
    must(
      typeof json === 'string' && trialHash(s) === trialHash(JSON.parse(json)),
      'RESUME_ORACLE_EVIDENCE_CHANGED',
    );
  }
  async claim(expected: OracleResumeState, attemptId: string, planHash: string): Promise<void> {
    await this.db.transaction(async (db) => {
      const s = await this.read(db, true);
      this.version(s);
      must(trialHash(s) === trialHash(expected), 'RESUME_ORACLE_EVIDENCE_CHANGED');
      must(
        s.stage.PROCESS_STATUS === 'E' &&
          s.readyToScan === 'E' &&
          s.stage.REIS_FINAL_STATUS === null &&
          s.stage.REQUEST &&
          s.stage.RESPONSE,
        'RESUME_ORACLE_NOT_ELIGIBLE',
      );
      await this.changed(
        db,
        `INSERT INTO ${this.names.receipt}(CIF,KYC_REF_NO,SEQ_NO,ATTEMPT_ID,PLAN_SHA256,PHASE,ORIGINAL_SNAPSHOT) VALUES(:cif,:kycRefNo,:seqNo,:attemptId,:planHash,'CLAIMED',:snapshotJson)`,
        { ...KEY, attemptId, planHash, snapshotJson: JSON.stringify(s) },
      );
      await this.changed(
        db,
        `UPDATE ${this.names.stage} SET PROCESS_STATUS='W', RETRY_COUNT=NVL(RETRY_COUNT,0)+1
        WHERE KYC_REF_NO=:kycRefNo AND SEQ_NO=:seqNo AND MSGID=:msgId AND PROCESS_STATUS='E' AND REIS_FINAL_STATUS IS NULL`,
        { kycRefNo: KEY.kycRefNo, seqNo: KEY.seqNo, msgId: String(s.stage.MSGID) },
      );
      await this.changed(
        db,
        `UPDATE ${this.names.trigger} SET READY_TO_SCAN='P' WHERE CUSTOMER_NO=:cif AND KYC_REF_NO=:kycRefNo AND READY_TO_SCAN='E'`,
        { cif: KEY.cif, kycRefNo: KEY.kycRefNo },
      );
      await this.changed(
        db,
        `UPDATE ${this.names.receipt} SET CLAIMED_SNAPSHOT=:snapshotJson WHERE ATTEMPT_ID=:attemptId AND PHASE='CLAIMED'`,
        { snapshotJson: JSON.stringify(await this.read(db)), attemptId },
      );
    });
  }
  async prepareDispatch(attemptId: string, payload: object): Promise<void> {
    await this.db.transaction(async (db) => {
      const s = await this.read(db, true);
      this.version(s);
      const r = await this.receipt(db, attemptId);
      must(r.PHASE === 'CLAIMED', 'RESUME_ORACLE_ALREADY_PREPARED');
      this.matches(s, r.CLAIMED_SNAPSHOT);
      await this.changed(
        db,
        `UPDATE ${this.names.stage} SET REQUEST=:requestJson, REQ_DATE=SYSDATE WHERE KYC_REF_NO=:kycRefNo AND SEQ_NO=:seqNo AND MSGID=:msgId AND PROCESS_STATUS='W' AND REIS_FINAL_STATUS IS NULL`,
        {
          requestJson: JSON.stringify(payload),
          kycRefNo: KEY.kycRefNo,
          seqNo: KEY.seqNo,
          msgId: String(s.stage.MSGID),
        },
      );
      await this.changed(
        db,
        `UPDATE ${this.names.receipt} SET PHASE='DISPATCHED',DISPATCH_SNAPSHOT=:snapshotJson WHERE ATTEMPT_ID=:attemptId AND PHASE='CLAIMED'`,
        { snapshotJson: JSON.stringify(await this.read(db)), attemptId },
      );
    });
  }
  async withDispatchFence<T>(attemptId: string, work: () => Promise<T>): Promise<T> {
    return this.db.transaction(async (db) => {
      const s = await this.read(db, true);
      this.version(s);
      const r = await this.receipt(db, attemptId);
      must(r.PHASE === 'DISPATCHED', 'RESUME_DISPATCH_PHASE_INVALID');
      this.matches(s, r.DISPATCH_SNAPSHOT);
      return work();
    });
  }
  async writeback(
    attemptId: string,
    wire: ReisRawResponse,
    rejectApproved: boolean,
  ): Promise<void> {
    const { finalStatus, parsed } = decisionFromWire(wire, rejectApproved),
      resultHash = trialHash(wire);
    await this.db.transaction(async (db) => {
      const s = await this.read(db, true);
      this.version(s);
      const r = await this.receipt(db, attemptId);
      if (r.PHASE === 'COMPLETED') {
        must(
          r.RESULT_SHA256 === resultHash &&
            s.stage.PROCESS_STATUS === 'S' &&
            s.stage.REIS_FINAL_STATUS === finalStatus &&
            s.readyToScan === 'P',
          'RESUME_COMPLETED_RESULT_CONFLICT',
        );
        this.matches(s, r.COMPLETED_SNAPSHOT);
        return;
      }
      must(r.PHASE === 'DISPATCHED', 'RESUME_WRITEBACK_PHASE_INVALID');
      this.matches(s, r.DISPATCH_SNAPSHOT);
      await this.changed(
        db,
        `UPDATE ${this.names.stage} SET PROCESS_STATUS='S',RESPONSE=:responseJson,RES_DATE=SYSDATE,REIS_FINAL_STATUS=:finalStatus WHERE KYC_REF_NO=:kycRefNo AND SEQ_NO=:seqNo AND MSGID=:msgId AND PROCESS_STATUS='W' AND REIS_FINAL_STATUS IS NULL`,
        {
          responseJson: JSON.stringify({ attemptId, wire, validatedResponse: parsed }),
          finalStatus,
          kycRefNo: KEY.kycRefNo,
          seqNo: KEY.seqNo,
          msgId: String(s.stage.MSGID),
        },
      );
      const after = await this.read(db);
      must(
        after.stage.PROCESS_STATUS === 'S' &&
          after.stage.REIS_FINAL_STATUS === finalStatus &&
          after.readyToScan === 'P',
        'RESUME_READBACK_MISMATCH',
      );
      await this.changed(
        db,
        `UPDATE ${this.names.receipt} SET PHASE='COMPLETED',RESULT_SHA256=:resultHash,COMPLETED_SNAPSHOT=:snapshotJson WHERE ATTEMPT_ID=:attemptId AND PHASE='DISPATCHED'`,
        { resultHash, snapshotJson: JSON.stringify(after), attemptId },
      );
    });
  }
}
