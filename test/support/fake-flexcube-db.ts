import {
  IFlexcubeSqlExecutor,
  OWN_MSGID_PATTERN,
  SqlBinds,
  SqlRow,
} from '../../src/flexcube/staging/flexcube-staging';
import { assertValidBinds } from '../../src/flexcube/staging/sql-binds';

export type StagingRow = {
  KYC_REF_NO: string;
  SEQ_NO: number;
  MSGID: string;
  PROCESS_STATUS: string;
  REQUEST: string | null;
  RESPONSE: string | null;
  RETRY_COUNT: number;
  REQ_DATE?: string;
  RES_DATE?: string;
  REIS_FINAL_STATUS?: string | null;
  /** Test-only: minutes since the row was claimed (the fake has no clock). */
  AGE_MIN?: number;
};

/**
 * In-memory stand-in for the FLEXCUBE database: it understands exactly the statements the
 * integration layer issues (staging INSERT / UPDATE, pending / recovery / detail / key-person
 * SELECTs). Synthetic data only.
 *
 * Every statement goes through assertValidBinds first, like the production Oracle executor, so a
 * bind variable named like an Oracle reserved word (`:from`, `:to` -> ORA-01745 on UAT1) or a bind
 * that does not match its placeholder fails in the test instead of on the bank database.
 *
 * Hooks make a statement fail (e.g. a CHECK constraint on the claim UPDATE, a lost connection).
 */
export class FakeFlexcubeDb implements IFlexcubeSqlExecutor {
  staging: StagingRow[] = [];
  master: {
    KYC_REF_NO: string;
    KYC_CUST_TYPE: string;
    MOD_NO: number;
    AUTH_STAT: string;
    RECORD_STAT?: string;
    /** Normalized YYYY-MM-DDTHH:MM:SS; default is after the test cut-off. */
    MAKER_DT_STAMP?: string;
  }[] = [];
  details = new Map<string, SqlRow>();
  products = new Map<string, string[]>();
  countries = new Map<string, string[]>();
  keyPersons = new Map<string, SqlRow[]>();
  /** Does STTM_KYC_CORP_KEYPERSONS have the configured key-person type column? */
  keypersonColumnPresent = true;
  pendingCalls: { sql: string; binds: SqlBinds }[] = [];
  allSql: { sql: string; binds: SqlBinds }[] = [];
  /** Every statement received (execute and query), in order. */
  statements: string[] = [];
  failInsertWith: Error | null = null;
  executeHook: ((sql: string, b: SqlBinds) => Error | undefined) | null = null;
  queryHook: ((sql: string, b: SqlBinds) => Error | undefined) | null = null;

  async execute(sql: string, b: SqlBinds) {
    this.statements.push(sql);
    assertValidBinds(sql, b);
    const hooked = this.executeHook?.(sql, b);
    if (hooked) throw hooked;
    const find = () =>
      this.staging.filter((r) => r.KYC_REF_NO === b.kycRefNo && r.SEQ_NO === b.seqNo);
    if (sql.startsWith('INSERT')) {
      if (this.failInsertWith) throw this.failInsertWith;
      if (find().length) throw new Error('ORA-00001: unique constraint violated');
      this.staging.push({
        KYC_REF_NO: String(b.kycRefNo),
        SEQ_NO: Number(b.seqNo),
        MSGID: String(b.msgId),
        PROCESS_STATUS: String(b.initialStatus),
        REQUEST: null,
        RESPONSE: null,
        RETRY_COUNT: 0,
      });
      return { rowsAffected: 1 };
    }
    if (sql.includes('PROCESS_STATUS IN (:sourceStatusNew, :sourceStatusWork)')) {
      const failed = find().filter((r) =>
        [b.sourceStatusNew, b.sourceStatusWork].includes(r.PROCESS_STATUS),
      );
      for (const r of failed) {
        r.PROCESS_STATUS = String(b.targetStatus);
        r.RESPONSE = b.responseJson as string;
        r.RETRY_COUNT += 1;
        r.RES_DATE = 'SYSDATE';
      }
      return { rowsAffected: failed.length };
    }
    if (sql.includes('RESPONSE = NULL')) {
      // reconciliation E -> N: the UPDATE repeats the WHOLE eligibility predicate
      const restored = find().filter(
        (r) =>
          r.MSGID === b.msgId &&
          (r.RES_DATE ?? null) === b.originalResDate &&
          this.neverSentEligible(r, b),
      );
      for (const r of restored) {
        r.PROCESS_STATUS = String(b.targetStatus);
        r.RESPONSE = null;
        r.RETRY_COUNT = 0;
        delete r.RES_DATE;
      }
      return { rowsAffected: restored.length };
    }
    if (sql.includes(':originalStatus')) {
      // rollback of a reconciled row: only while it is exactly in the post-restore state
      const back = find().filter((r) => this.restoredState(r, b));
      for (const r of back) {
        r.PROCESS_STATUS = String(b.originalStatus);
        r.RESPONSE = b.originalResponse as string | null;
        r.RETRY_COUNT = Number(b.originalRetryCount);
        if (b.originalResDate === null) delete r.RES_DATE;
        else r.RES_DATE = String(b.originalResDate);
      }
      return { rowsAffected: back.length };
    }
    const rows = find().filter((r) => r.PROCESS_STATUS === b.sourceStatus);
    if (sql.includes('REQ_DATE = NULL')) {
      // release: W -> N, only while nothing was stored
      const released = rows.filter((r) => r.REQUEST === null);
      for (const r of released) {
        r.PROCESS_STATUS = String(b.targetStatus);
        delete r.REQ_DATE;
      }
      return { rowsAffected: released.length };
    }
    for (const r of rows) {
      if (sql.includes('+ :retryIncrement')) {
        // complete(): a CLOB column is set only when its bind is present (no COALESCE on Oracle)
        r.PROCESS_STATUS = String(b.targetStatus);
        if (sql.includes('REQUEST = :requestJson')) r.REQUEST = b.requestJson as string;
        if (sql.includes('RESPONSE = :responseJson')) r.RESPONSE = b.responseJson as string;
        r.RETRY_COUNT += Number(b.retryIncrement);
        if (sql.includes('RES_DATE = SYSDATE')) r.RES_DATE = 'SYSDATE';
      } else {
        r.PROCESS_STATUS = String(b.targetStatus);
        if (sql.includes('REQ_DATE = SYSDATE')) r.REQ_DATE = 'SYSDATE';
      }
    }
    return { rowsAffected: rows.length };
  }

  async query(sql: string, b: SqlBinds): Promise<SqlRow[]> {
    this.statements.push(sql);
    assertValidBinds(sql, b);
    if (!/^\s*SELECT/i.test(sql)) throw new Error('only SELECT is allowed in query()');
    const hooked = this.queryHook?.(sql, b);
    if (hooked) throw hooked;
    if (sql.includes('IN (:expectedResponse0')) {
      return this.staging
        .filter((r) => this.neverSentEligible(r, b))
        .slice(0, Number(b.maxRows))
        .map((r) => ({ KYC_REF_NO: r.KYC_REF_NO, SEQ_NO: r.SEQ_NO }));
    }
    if (sql.includes('REQ_DATE_ISO')) {
      return this.staging
        .filter((r) => r.KYC_REF_NO === b.kycRefNo && r.SEQ_NO === b.seqNo)
        .map((r) => ({
          KYC_REF_NO: r.KYC_REF_NO,
          SEQ_NO: r.SEQ_NO,
          MSGID: r.MSGID,
          PROCESS_STATUS: r.PROCESS_STATUS,
          REQUEST: r.REQUEST,
          RESPONSE: r.RESPONSE,
          RETRY_COUNT: r.RETRY_COUNT,
          REQ_DATE_ISO: r.REQ_DATE ?? null,
          RES_DATE_ISO: r.RES_DATE ?? null,
          REIS_FINAL_STATUS: r.REIS_FINAL_STATUS ?? null,
        }));
    }
    if (sql.includes(':currentStatus')) {
      return [
        {
          N: this.staging.filter(
            (r) => r.KYC_REF_NO === b.kycRefNo && r.SEQ_NO === b.seqNo && this.restoredState(r, b),
          ).length,
        },
      ];
    }
    if (sql.includes(':uncertainMarker')) {
      const uuid = new RegExp(OWN_MSGID_PATTERN, 'i');
      return this.staging
        .filter(
          (s) =>
            uuid.test(s.MSGID) &&
            ((s.PROCESS_STATUS === b.errorStatus &&
              (s.RESPONSE ?? '').includes(String(b.uncertainMarker))) ||
              (s.PROCESS_STATUS === b.inProgressStatus && (s.AGE_MIN ?? 0) > Number(b.ageMinutes))),
        )
        .slice(0, Number(b.maxRows))
        .map((s) => ({ KYC_REF_NO: s.KYC_REF_NO, SEQ_NO: s.SEQ_NO }));
    }
    if (sql.includes('FROM ALL_TAB_COLUMNS')) return [{ N: this.keypersonColumnPresent ? 1 : 0 }];
    if (sql.includes('s.REQ_DATE IS NULL')) {
      // recovery of our own rows left at N: UUID MSGID, never claimed, open KYC since the cut-off
      const uuid = new RegExp(OWN_MSGID_PATTERN, 'i');
      return this.master
        .filter((m) => this.typeAllowed(sql, m.KYC_CUST_TYPE))
        .filter((m) => (m.RECORD_STAT ?? 'O') === 'O')
        .filter((m) => (m.MAKER_DT_STAMP ?? '2026-12-01T00:00:00') >= String(b.since))
        .filter((m) =>
          this.staging.some(
            (s) =>
              s.KYC_REF_NO === m.KYC_REF_NO &&
              s.SEQ_NO === m.MOD_NO &&
              s.PROCESS_STATUS === b.newStatus &&
              s.REQ_DATE === undefined &&
              s.REQUEST === null &&
              uuid.test(s.MSGID),
          ),
        )
        .slice(0, Number(b.maxRows));
    }
    if (sql.includes('REQ_DATE < SYSDATE')) {
      const uuid = new RegExp(OWN_MSGID_PATTERN, 'i');
      return this.staging
        .filter(
          (s) =>
            s.PROCESS_STATUS === b.inProgressStatus &&
            (s.AGE_MIN ?? 0) > Number(b.ageMinutes) &&
            uuid.test(s.MSGID),
        )
        .map((s) => ({ KYC_REF_NO: s.KYC_REF_NO, SEQ_NO: s.SEQ_NO }));
    }
    if (sql.includes('FROM STTM_KYC_MASTER')) {
      this.pendingCalls.push({ sql, binds: b });
      return this.master
        .filter((m) => this.typeAllowed(sql, m.KYC_CUST_TYPE))
        .filter((m) => (m.RECORD_STAT ?? 'O') === 'O')
        .filter((m) => (m.MAKER_DT_STAMP ?? '2026-12-01T00:00:00') >= String(b.since))
        .filter(
          (m) => !this.staging.some((s) => s.KYC_REF_NO === m.KYC_REF_NO && s.SEQ_NO === m.MOD_NO),
        )
        .slice(0, Number(b.maxRows));
    }
    const k = String(b.kycRefNo);
    this.allSql.push({ sql, binds: b });
    if (sql.includes('STTM_KYC_CORP_KEYPERSONS')) return this.keyPersons.get(k) ?? [];
    if (sql.includes('PRODUCT_CUSTOM')) {
      return (this.products.get(k) ?? []).map((p) => ({ PRODUCT_CODE: p }));
    }
    if (sql.includes('STTM_KYC_CORP_COUNTRY_CUSTOM')) {
      return (this.countries.get(k) ?? []).map((c) => ({ OPERATION_COUNTRY: c }));
    }
    const d = this.details.get(k);
    return d ? [d] : [];
  }

  /** Mirror of StagingSubmissionRepository.neverSentPredicate (SELECT and UPDATE share it). */
  private neverSentEligible(r: StagingRow, b: SqlBinds): boolean {
    const expected = Object.entries(b)
      .filter(([k]) => k.startsWith('expectedResponse'))
      .map(([, v]) => v);
    return (
      r.PROCESS_STATUS === b.errorStatus &&
      r.REQUEST === null &&
      r.REQ_DATE === undefined &&
      (r.REIS_FINAL_STATUS ?? null) === null &&
      r.RETRY_COUNT === 1 &&
      new RegExp(OWN_MSGID_PATTERN, 'i').test(r.MSGID) &&
      expected.includes(r.RESPONSE) &&
      this.master.some(
        (m) =>
          m.KYC_REF_NO === r.KYC_REF_NO &&
          m.MOD_NO === r.SEQ_NO &&
          (m.RECORD_STAT ?? 'O') === 'O' &&
          ['R', 'C'].includes(m.KYC_CUST_TYPE) &&
          (m.MAKER_DT_STAMP ?? '2026-12-01T00:00:00') >= String(b.since),
      )
    );
  }

  /** Mirror of StagingSubmissionRepository.restoredStatePredicate. */
  private restoredState(r: StagingRow, b: SqlBinds): boolean {
    return (
      r.MSGID === b.msgId &&
      r.PROCESS_STATUS === b.currentStatus &&
      r.REQUEST === null &&
      r.RESPONSE === null &&
      r.REQ_DATE === undefined &&
      r.RES_DATE === undefined &&
      (r.REIS_FINAL_STATUS ?? null) === null &&
      r.RETRY_COUNT === 0
    );
  }

  /** The SQL lists the KYC types it accepts: IN ('R', 'C') or, without corporate support, IN ('R'). */
  private typeAllowed(sql: string, type: string): boolean {
    const m = /KYC_CUST_TYPE IN \(([^)]*)\)/.exec(sql);
    return m ? m[1].includes(`'${type}'`) : false;
  }
}
