import {
  IFlexcubeSqlExecutor,
  SqlBinds,
  SqlRow,
} from '../../src/flexcube/staging/flexcube-staging';

export interface FakeStagingRow {
  KYC_REF_NO: string;
  SEQ_NO: number;
  MSGID: string;
  PROCESS_STATUS: string;
  REQUEST: string | null;
  RESPONSE: string | null;
  RETRY_COUNT: number;
}

/**
 * In-memory FLEXCUBE for the polling end-to-end tests: understands only the statements the
 * integration layer issues (pending + detail + key-person SELECTs, staging INSERT / UPDATE).
 * Synthetic data only. Rejects anything that is not a SELECT, INSERT or the known UPDATEs.
 */
export class FakeFlexcubeKycDb implements IFlexcubeSqlExecutor {
  staging: FakeStagingRow[] = [];
  master: { KYC_REF_NO: string; KYC_CUST_TYPE: string; MOD_NO: number; AUTH_STAT: string }[] = [];
  details = new Map<string, SqlRow>();
  products = new Map<string, string[]>();
  countries = new Map<string, string[]>();
  keyPersons = new Map<string, SqlRow[]>();
  readonly statements: string[] = [];

  async execute(sql: string, b: SqlBinds): Promise<{ rowsAffected: number }> {
    this.statements.push(sql);
    const find = () =>
      this.staging.filter((r) => r.KYC_REF_NO === b.kycRefNo && r.SEQ_NO === b.seqNo);
    if (sql.startsWith('INSERT')) {
      if (find().length) throw new Error('ORA-00001: unique constraint violated');
      this.staging.push({
        KYC_REF_NO: String(b.kycRefNo),
        SEQ_NO: Number(b.seqNo),
        MSGID: String(b.msgId),
        PROCESS_STATUS: String(b.status),
        REQUEST: null,
        RESPONSE: null,
        RETRY_COUNT: 0,
      });
      return { rowsAffected: 1 };
    }
    if (!sql.includes('UPDATE')) throw new Error(`unexpected statement: ${sql}`);
    const rows = find().filter((r) => r.PROCESS_STATUS === b.from);
    for (const r of rows) {
      if (sql.includes('REQUEST = COALESCE')) {
        r.PROCESS_STATUS = String(b.status);
        r.REQUEST = (b.request as string | null) ?? r.REQUEST;
        r.RESPONSE = (b.response as string | null) ?? r.RESPONSE;
        r.RETRY_COUNT += Number(b.retry);
      } else {
        r.PROCESS_STATUS = String(b.to);
      }
    }
    return { rowsAffected: rows.length };
  }

  async query(sql: string, b: SqlBinds): Promise<SqlRow[]> {
    this.statements.push(sql);
    if (!/^\s*SELECT/i.test(sql)) throw new Error('only SELECT is allowed in query()');
    if (sql.includes('FROM STTM_KYC_MASTER')) {
      return this.master
        .filter((m) => ['R', 'C'].includes(m.KYC_CUST_TYPE))
        .filter(
          (m) => !this.staging.some((s) => s.KYC_REF_NO === m.KYC_REF_NO && s.SEQ_NO === m.MOD_NO),
        )
        .slice(0, Number(b.maxRows));
    }
    const k = String(b.kycRefNo);
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
}
