import { assertValidBinds } from '../../src/flexcube/staging/sql-binds';
import { SqlBinds, SqlRow } from '../../src/flexcube/staging/flexcube-staging';
import { SINGLE_KYC_TRIAL as TARGET } from '../../src/tools/single-kyc-trial.contract';
import { FakeFlexcubeDb } from './fake-flexcube-db';

/** Synthetic, in-memory Oracle executor for the single-trial statements, NOT SQL execution proof. */
export class SingleTrialDb extends FakeFlexcubeDb {
  writes: { sql: string; binds: SqlBinds }[] = [];
  beforeWrite?: (sql: string, binds: SqlBinds) => void;
  override async query(sql: string, b: SqlBinds): Promise<SqlRow[]> {
    if (sql.includes('KYC_CUST_TYPE, RECORD_STAT FROM STTM_KYC_MASTER')) {
      this.statements.push(sql);
      assertValidBinds(sql, b);
      return this.master.filter(
        (m) => m.KYC_REF_NO === b.kycRefNo && m.MOD_NO === b.seqNo && m.RECORD_STAT === 'O',
      );
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
    const row = this.staging.find(
      (r) => r.KYC_REF_NO === b.kycRefNo && r.SEQ_NO === b.seqNo && r.MSGID === b.msgId,
    );
    if (!row) return { rowsAffected: 0 };
    const versionOpen = this.master.some(
      (m) => m.KYC_REF_NO === b.kycRefNo && m.MOD_NO === b.seqNo && m.RECORD_STAT === 'O',
    );
    if (sql.includes('REQ_DATE = SYSDATE')) {
      if (
        !versionOpen ||
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
