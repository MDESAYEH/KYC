import {
  FlexcubeCorporateDto,
  FlexcubeCustomerRequest,
  FlexcubeIndividualDto,
  FlexcubeRelatedPartyDto,
} from '../dto/flexcube-customer.request';
import {
  assertSafeColumnName,
  assertSafeTableName,
  DEFAULT_KEYPERSON_TYPE_COLUMN,
  IFlexcubeSqlExecutor,
  SqlRow,
} from '../staging/flexcube-staging';
import {
  CORPORATE_COUNTRIES_SQL,
  corporateKeypersonsSql,
  CORPORATE_KYC_SQL,
  CORPORATE_PRODUCTS_SQL,
  INDIVIDUAL_KYC_SQL,
  INDIVIDUAL_PRODUCTS_SQL,
  CORPORATE_TYPE_COLUMN_EXISTS_SQL,
  pendingKycSql,
  stuckNewKycSql,
} from './flexcube-kyc.queries';
import { oraCode } from '../oracle-error';

/** A saved KYC waiting for REIS; seqNo is the staging SEQ_NO (FLEXCUBE MOD_NO). */
export interface PendingKyc {
  kycRefNo: string;
  seqNo: number;
  customerType: 'INDIVIDUAL' | 'CORPORATE';
}

const toPendingKyc = (r: SqlRow): PendingKyc => ({
  kycRefNo: String(r.KYC_REF_NO),
  seqNo: Number(r.MOD_NO),
  customerType: r.KYC_CUST_TYPE === 'C' ? 'CORPORATE' : 'INDIVIDUAL',
});

/** The KYC detail rows could not be found (e.g. deleted or not yet committed). */
export class KycDetailsNotFoundError extends Error {
  constructor(readonly kycRefNo: string) {
    super(`KYC details not found for ${kycRefNo}`);
    this.name = 'KycDetailsNotFoundError';
  }
}

/**
 * FLEXCUBE_SYNC_START_DATE: ISO date (YYYY-MM-DD) or local timestamp (YYYY-MM-DDTHH:MM[:SS],
 * no time-zone suffix: it is compared with the database's own MAKER_DT_STAMP). Returns the
 * normalized YYYY-MM-DDTHH:MM:SS bind value, or undefined when it is not a real date.
 */
export function normalizeSyncStartDate(raw: string | undefined): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec((raw ?? '').trim());
  if (!m) return undefined;
  const [y, mo, d, h = 0, mi = 0, s = 0] = m.slice(1).map((v) => (v === undefined ? 0 : Number(v)));
  const check = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const valid =
    check.getUTCFullYear() === y &&
    check.getUTCMonth() === mo - 1 &&
    check.getUTCDate() === d &&
    h < 24 &&
    mi < 60 &&
    s < 60;
  if (!valid) return undefined;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}`;
}

/** Oracle DATE (JS Date, session time zone) -> YYYY-MM-DD; strings are passed through. */
export function oracleDate(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  return String(value);
}

/** Text column -> trimmed string, blank/NULL -> undefined. */
const text = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
};

/**
 * Reads saved KYCs from the FLEXCUBE STTM tables (read-only SELECTs) and turns them into the
 * FlexcubeCustomerRequest the existing mapper validates. Missing values are passed as missing:
 * the mapper / transformer reject them before any REIS call (nothing is invented here).
 * Corporate key persons (STTM_KYC_CORP_KEYPERSONS + _CUSTOM) are read as raw RELATED_PARTIES; the
 * mapper validates them (relationship code, systemId, mandatory fields).
 */
export class FlexcubeKycSource {
  private readonly pendingSql: { corporate: string; individualOnly: string };
  private readonly stuckNewSql: { corporate: string; individualOnly: string };
  private readonly keypersonsSql: string;
  private readonly typeColumn: string;

  /** Corporate KYCs are taken only after the type column was proven to exist (refresh below). */
  private corporateSupported = false;
  private corporateCheckedAt = Number.NEGATIVE_INFINITY;
  /** Why corporates are (not) supported: COLUMN_FOUND, COLUMN_NOT_FOUND or the Oracle error code. */
  corporateSupportReason = 'NOT_CHECKED';

  private readonly since: string;

  /** `syncStartDate` is the raw FLEXCUBE_SYNC_START_DATE; an invalid value is rejected here. */
  constructor(
    private readonly db: IFlexcubeSqlExecutor,
    stagingTable: string,
    syncStartDate: string,
    /** Column holding the key-person type (FLEXCUBE_KEYPERSON_TYPE_COLUMN). */
    keypersonTypeColumn: string = DEFAULT_KEYPERSON_TYPE_COLUMN,
  ) {
    const since = normalizeSyncStartDate(syncStartDate);
    if (since === undefined) {
      throw new Error('FLEXCUBE_SYNC_START_DATE must be an ISO date or timestamp (YYYY-MM-DD)');
    }
    this.since = since;
    const table = assertSafeTableName(stagingTable);
    this.pendingSql = {
      corporate: pendingKycSql(table, true),
      individualOnly: pendingKycSql(table, false),
    };
    this.stuckNewSql = {
      corporate: stuckNewKycSql(table, true),
      individualOnly: stuckNewKycSql(table, false),
    };
    this.typeColumn = assertSafeColumnName(keypersonTypeColumn);
    this.keypersonsSql = corporateKeypersonsSql(this.typeColumn);
  }

  /**
   * Proves (metadata only, cached 10 minutes) that the configured key-person type column exists.
   * Without it a corporate KYC cannot be told from its individual / company key persons, so
   * corporates are not selected at all: no staging row, no error, nothing sent. Never guesses a
   * column. A failing check also disables corporates (safe default).
   */
  async refreshCorporateSupport(nowMs: number = Date.now()): Promise<boolean> {
    if (nowMs - this.corporateCheckedAt < 10 * 60_000) return this.corporateSupported;
    this.corporateCheckedAt = nowMs;
    try {
      const rows = await this.db.query(CORPORATE_TYPE_COLUMN_EXISTS_SQL, {
        columnName: this.typeColumn.toUpperCase(),
      });
      this.corporateSupported = Number(rows[0]?.N) > 0;
      this.corporateSupportReason = this.corporateSupported ? 'COLUMN_FOUND' : 'COLUMN_NOT_FOUND';
    } catch (error) {
      this.corporateSupported = false;
      this.corporateSupportReason = oraCode(error);
    }
    return this.corporateSupported;
  }

  get supportsCorporate(): boolean {
    return this.corporateSupported;
  }

  async findPending(maxRows: number): Promise<PendingKyc[]> {
    const sql = this.corporateSupported
      ? this.pendingSql.corporate
      : this.pendingSql.individualOnly;
    const rows = await this.db.query(sql, { since: this.since, maxRows });
    return rows.map(toPendingKyc);
  }

  /** Our own staging rows left at N (never claimed) by an earlier failed pass, still open. */
  async findOwnStuckNew(maxRows: number): Promise<PendingKyc[]> {
    const sql = this.corporateSupported
      ? this.stuckNewSql.corporate
      : this.stuckNewSql.individualOnly;
    const rows = await this.db.query(sql, {
      newStatus: 'N',
      since: this.since,
      maxRows,
    });
    return rows.map(toPendingKyc);
  }

  async load(pending: PendingKyc): Promise<FlexcubeCustomerRequest> {
    return pending.customerType === 'CORPORATE'
      ? this.loadCorporate(pending.kycRefNo)
      : this.loadIndividual(pending.kycRefNo);
  }

  private async one(sql: string, kycRefNo: string): Promise<SqlRow> {
    const rows = await this.db.query(sql, { kycRefNo });
    if (rows.length !== 1) throw new KycDetailsNotFoundError(kycRefNo);
    return rows[0];
  }

  private async list(sql: string, kycRefNo: string, column: string): Promise<string[]> {
    const rows = await this.db.query(sql, { kycRefNo });
    return rows.map((r) => text(r[column])).filter((v): v is string => v !== undefined);
  }

  private async loadIndividual(kycRefNo: string): Promise<FlexcubeCustomerRequest> {
    const r = await this.one(INDIVIDUAL_KYC_SQL, kycRefNo);
    const individual = {
      FIRST_NAME: text(r.FIRST_NAME),
      LAST_NAME: text(r.LAST_NAME),
      BIRTH_DATE: oracleDate(r.BIRTH_DATE),
      BIRTH_PLACE: text(r.BIRTH_PLACE),
      NID: text(r.PASSPORT_NO),
      EXPIRY_DATE: oracleDate(r.PASSPORT_EXPIRY_DATE),
      RELATION_PEP: text(r.RELATION_PEP),
      NATIONALITY: text(r.NATIONALITY),
      CITIZENSHIP: text(r.LOCAL_ADDR_COUNTRY),
      PROFESSION: text(r.OCCUPATION),
      ACC_PURPOSE: text(r.ACC_PURPOSE),
      RESIDENT: text(r.RESIDENT),
      FUND_SOURCE: text(r.FUNDS_SOURCE),
      MONTHLY_INCOME: r.TOTAL_INCOME as number,
    } as FlexcubeIndividualDto;
    return {
      KYC_REF_NO: kycRefNo,
      CUSTOMER_TYPE: 'INDIVIDUAL',
      ACCOUNT_MANAGER_LOGIN: text(r.ACCOUNT_MANAGER_LOGIN),
      ACCOUNT_MANAGER_EMAIL: text(r.ACCOUNT_MANAGER_EMAIL),
      PEP: text(r.PEP),
      PRODUCT_CODES: await this.list(INDIVIDUAL_PRODUCTS_SQL, kycRefNo, 'PRODUCT_CODE'),
      DISTRIBUTION_CHANNEL: text(r.DISTRIBUTION_CHANNEL),
      individual,
    } as FlexcubeCustomerRequest;
  }

  /** Key persons as raw values; blank text -> undefined, dates -> YYYY-MM-DD. No validation here. */
  private async relatedParties(kycRefNo: string): Promise<FlexcubeRelatedPartyDto[]> {
    const rows = await this.db.query(this.keypersonsSql, { kycRefNo });
    return rows.map(
      (k) =>
        ({
          KYC_ID: text(k.KYC_ID),
          NAME: text(k.NAME),
          KYC_KEYPERSON_TYPE: text(k.KYC_KEYPERSON_TYPE),
          RELATIONSHIP: text(k.RELATIONSHIP),
          DATE_OF_BIRTH: oracleDate(k.DATE_OF_BIRTH),
          NATIONALITY: text(k.NATIONALITY),
          ADDRESS_COUNTRY: text(k.ADDRESS_COUNTRY),
          PLACE_OF_BIRTH: text(k.PLACE_OF_BIRTH),
          TIN: text(k.TIN),
          HAS_CUSTOM_ROW: k.CUSTOM_KYC_REF_NO !== null && k.CUSTOM_KYC_REF_NO !== undefined,
          FIRST_NAME: text(k.FIRST_NAME),
          LAST_NAME: text(k.LAST_NAME),
          PASSPORT_NUMBER: text(k.PASSPORT_NUMBER),
          PASSPORT_ISSUE_DATE: oracleDate(k.PASSPORT_ISSUE_DATE),
          PASSPORT_EXPIRY_DATE: oracleDate(k.PASSPORT_EXPIRY_DATE),
          PLACE_OF_ISSUE: text(k.PLACE_OF_ISSUE),
          NATIONAL_ID: text(k.NATIONAL_ID),
        }) as FlexcubeRelatedPartyDto,
    );
  }

  private async loadCorporate(kycRefNo: string): Promise<FlexcubeCustomerRequest> {
    const r = await this.one(CORPORATE_KYC_SQL, kycRefNo);
    const corporate = {
      CRP_BUSINESS_NAME: text(r.CRP_BUSINESS_NAME),
      PARENT_CMPNY_COUNTRY: text(r.PARENT_CMPNY_COUNTRY),
      OPERATION_COUNTRY: await this.list(CORPORATE_COUNTRIES_SQL, kycRefNo, 'OPERATION_COUNTRY'),
      LEGAL_ENTITY: text(r.LEGAL_ENTITY),
      ACTIVITY: text(r.ACTIVITY),
      ACC_PURPOSE: text(r.ACC_PURPOSE),
      SOURCE_OF_INCOME: text(r.FUNDS_SOURCE),
      FIN_INFO: r.ANNUAL_TURNOVER as number,
      TRADE_NO: text(r.TRADE_LICENCE_NO),
      RELATED_PARTIES: await this.relatedParties(kycRefNo),
    } as FlexcubeCorporateDto;
    return {
      KYC_REF_NO: kycRefNo,
      CUSTOMER_TYPE: 'CORPORATE',
      ACCOUNT_MANAGER_LOGIN: text(r.ACCOUNT_MANAGER_LOGIN),
      ACCOUNT_MANAGER_EMAIL: text(r.ACCOUNT_MANAGER_EMAIL),
      PEP: text(r.PEP),
      PRODUCT_CODES: await this.list(CORPORATE_PRODUCTS_SQL, kycRefNo, 'PRODUCT_CODE'),
      DISTRIBUTION_CHANNEL: text(r.DISTRIBUTION_CHANNEL),
      corporate,
    } as FlexcubeCustomerRequest;
  }
}
