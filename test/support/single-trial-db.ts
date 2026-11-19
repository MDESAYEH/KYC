import { assertValidBinds } from '../../src/flexcube/staging/sql-binds';
import { SqlBinds, SqlRow } from '../../src/flexcube/staging/flexcube-staging';
import { SINGLE_KYC_TRIAL as TARGET } from '../../src/tools/single-kyc-trial.contract';
import { FakeFlexcubeDb } from './fake-flexcube-db';

/** Synthetic, in-memory Oracle executor for the single-trial statements, NOT SQL execution proof. */
export class SingleTrialDb extends FakeFlexcubeDb {
  writes: { sql: string; binds: SqlBinds }[] = [];
  /** STTM_CUSTOMER (CIF revision) and STTM_CUSTOMER_CUSTOM (Finexta trigger) of the target. */
  customers: { CUSTOMER_NO: string; MOD_NO: number }[] = [
    { CUSTOMER_NO: TARGET.expectedCif, MOD_NO: TARGET.seqNo },
  ];
  triggers: { CUSTOMER_NO: string; KYC_REF_NO: string; READY_TO_SCAN: string }[] = [
    { CUSTOMER_NO: TARGET.expectedCif, KYC_REF_NO: TARGET.kycRefNo, READY_TO_SCAN: 'U' },
  ];
  private trigger(b: SqlBinds) {
    return this.triggers.find((t) => t.CUSTOMER_NO === b.cif && t.KYC_REF_NO === b.kycRefNo);
  }
  private cifAt(b: SqlBinds): boolean {
    return this.customers.some((c) => c.CUSTOMER_NO === b.cif && c.MOD_NO === b.seqNo);
  }
  beforeWrite?: (sql: string, binds: SqlBinds) => void;
  override async query(sql: string, b: SqlBinds): Promise<SqlRow[]> {
    if (sql.includes('KYC_CUST_TYPE, RECORD_STAT FROM STTM_KYC_MASTER')) {
      this.statements.push(sql);
      assertValidBinds(sql, b);
      return this.master.filter((m) => m.KYC_REF_NO === b.kycRefNo && m.RECORD_STAT === 'O');
    }
    if (sql.includes('SEQ_NO > :seqNo')) {
      this.statements.push(sql);
      assertValidBinds(sql, b);
      const n = this.staging.filter(
        (r) => r.KYC_REF_NO === b.kycRefNo && r.SEQ_NO > Number(b.seqNo),
      ).length;
      return [{ N: n }];
    }
    return super.query(sql, b);
  }
  override async execute(sql: string, b: SqlBinds) {
    assertValidBinds(sql, b);
    if (b.kycRefNo !== TARGET.kycRefNo || b.seqNo !== TARGET.seqNo)
      throw Error('attempt to write outside trial scope');
    this.beforeWrite?.(sql, b);
    const error = this.executeHook?.(sql, b);
    if (error) throw error;
    this.writes.push({ sql, binds: { ...b } });
    if (sql.startsWith('INSERT')) return super.execute(sql, b);
    this.statements.push(sql);
    if (sql.startsWith('UPDATE STTM_CUSTOMER_CUSTOM')) {
      const t = this.trigger(b);
      const from = sql.includes('SET READY_TO_SCAN = :pickedStatus')
        ? b.readyStatus
        : b.pickedStatus;
      if (!t || t.READY_TO_SCAN !== from || !this.cifAt(b)) return { rowsAffected: 0 };
      t.READY_TO_SCAN = String(b.pickedStatus === from ? b.errorStatus : b.pickedStatus);
      return { rowsAffected: 1 };
    }
    const row = this.staging.find(
      (r) => r.KYC_REF_NO === b.kycRefNo && r.SEQ_NO === b.seqNo && r.MSGID === b.msgId,
    );
    if (!row) return { rowsAffected: 0 };
    const versionOpen =
      this.cifAt(b) &&
      this.master.some((m) => m.KYC_REF_NO === b.kycRefNo && m.RECORD_STAT === 'O');
    const triggerIs = (status: unknown) => this.trigger(b)?.READY_TO_SCAN === status;
    if (sql.includes('RESPONSE = NULL')) {
      if (
        !versionOpen ||
        !triggerIs(b.readyStatus) ||
        row.PROCESS_STATUS !== b.errorStatus ||
        row.REQUEST !== null ||
        row.REQ_DATE != null ||
        row.REIS_FINAL_STATUS != null ||
        row.RETRY_COUNT !== 1 ||
        row.RESPONSE !== b.expectedResponse
      )
        return { rowsAffected: 0 };
      row.PROCESS_STATUS = String(b.targetStatus);
      row.RESPONSE = null;
      row.RETRY_COUNT = 0;
      delete row.RES_DATE;
    } else if (sql.includes('REQ_DATE = NULL')) {
      if (row.PROCESS_STATUS !== b.workStatus || row.REQUEST !== null) return { rowsAffected: 0 };
      row.PROCESS_STATUS = String(b.targetStatus);
      delete row.REQ_DATE;
    } else if (sql.includes('REQ_DATE = SYSDATE')) {
      if (
        !versionOpen ||
        !triggerIs(b.readyStatus) ||
        row.PROCESS_STATUS !== 'N' ||
        row.REQUEST !== null ||
        row.RESPONSE !== null ||
        row.REQ_DATE != null ||
        row.RES_DATE != null ||
        row.REIS_FINAL_STATUS != null ||
        row.RETRY_COUNT !== 0
      )
        return { rowsAffected: 0 };
      row.PROCESS_STATUS = String(b.targetStatus);
      row.REQ_DATE = '2026-11-17T11:00:00';
    } else if (sql.includes('SET REQUEST =')) {
      if (
        !versionOpen ||
        !triggerIs(b.pickedStatus) ||
        row.PROCESS_STATUS !== b.workStatus ||
        row.REQUEST !== null ||
        row.RESPONSE !== null
      )
        return { rowsAffected: 0 };
      row.REQUEST = String(b.requestJson);
    } else if (sql.includes('SET PROCESS_STATUS = :resultStatus')) {
      if (row.PROCESS_STATUS !== b.workStatus || row.REQUEST === null) return { rowsAffected: 0 };
      row.PROCESS_STATUS = String(b.resultStatus);
      row.RESPONSE = String(b.responseJson);
      row.RES_DATE = '2026-11-17T11:01:00';
      row.RETRY_COUNT += Number(b.retryIncrement);
    } else if (sql.includes('SET REIS_FINAL_STATUS')) {
      if (
        row.PROCESS_STATUS !== 'S' ||
        row.REQUEST === null ||
        row.RESPONSE === null ||
        (row.REIS_FINAL_STATUS != null && row.REIS_FINAL_STATUS !== b.wireStatus)
      )
        return { rowsAffected: 0 };
      row.REIS_FINAL_STATUS = String(b.wireStatus);
    } else throw Error('unrecognized single-trial statement');
    return { rowsAffected: 1 };
  }
}
