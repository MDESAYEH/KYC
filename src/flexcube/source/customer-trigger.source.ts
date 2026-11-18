import { IFlexcubeSqlExecutor, SqlRow, assertSafeTableName } from '../staging/flexcube-staging';
import { normalizeSyncStartDate } from './flexcube-kyc-source';

/**
 * Trigger table agreed with Finexta (Abhilash, 18/11/2026) INSTEAD of a webhook: STTM_CUSTOMER_CUSTOM
 * (CUSTOMER_NO, KYC_REF_NO, READY_TO_SCAN). A row is inserted with READY_TO_SCAN = 'U' once the CIF is
 * authorized, and set back to 'U' after a modified CIF is authorized. The Integration API picks up 'U' rows,
 * reads the details from the real FCUBS tables, and sets the row to 'P' once it has picked it up.
 *
 * NOT wired into the poller yet: open questions for Finexta (docs/customer-trigger-table.md) - values other
 * than U / P, a version / date column for modified CIFs, backfill of old customers, UPDATE grant. Writing 'P'
 * is the only write to a FLEXCUBE-owned table, so it is refused unless `writeEnabled` is passed explicitly.
 */
export const TRIGGER_READY = 'U';
export const TRIGGER_PICKED = 'P';

export interface ReadyCustomer {
  /** The CIF, exactly as the trigger row holds it (a string: leading zeros are kept). */
  customerNo: string;
  kycRefNo: string;
  /** Current KYC revision (STTM_KYC_MASTER.MOD_NO) = the staging SEQ_NO. */
  seqNo: number;
  customerType: 'INDIVIDUAL' | 'CORPORATE';
  /** Staging rows that already exist for this exact revision (a re-triggered CIF of a sent revision). */
  stagingRows: number;
}

export class TriggerWriteDisabledError extends Error {
  constructor() {
    super('Writing READY_TO_SCAN is disabled (pass writeEnabled explicitly)');
    this.name = 'TriggerWriteDisabledError';
  }
}

export const customerTriggerTable = 'STTM_CUSTOMER_CUSTOM';

/** Rows still waiting, joined to the open KYC master row (cut-off applied there: the trigger table has no date). */
export const readyCustomersSql = (stagingTable: string, corporate: boolean): string =>
  `SELECT t.CUSTOMER_NO, t.KYC_REF_NO, m.MOD_NO, m.KYC_CUST_TYPE,
          (SELECT COUNT(*) FROM ${stagingTable} s
            WHERE s.KYC_REF_NO = t.KYC_REF_NO AND s.SEQ_NO = m.MOD_NO) AS STAGING_ROWS
     FROM ${customerTriggerTable} t
     JOIN STTM_KYC_MASTER m ON m.KYC_REF_NO = t.KYC_REF_NO
    WHERE t.READY_TO_SCAN = :readyStatus
      AND m.RECORD_STAT = 'O'
      AND m.KYC_CUST_TYPE IN ${corporate ? "('R', 'C')" : "('R')"}
      AND m.MAKER_DT_STAMP >= TO_DATE(:since, 'YYYY-MM-DD"T"HH24:MI:SS')
    ORDER BY t.KYC_REF_NO
    FETCH FIRST :maxRows ROWS ONLY`;

/** Conditional: only a row still at U is taken, so two instances never pick the same CIF. */
export const markPickedSql = `UPDATE ${customerTriggerTable}
    SET READY_TO_SCAN = :pickedStatus
  WHERE CUSTOMER_NO = :customerNo AND KYC_REF_NO = :kycRefNo AND READY_TO_SCAN = :readyStatus`;

const toReady = (r: SqlRow): ReadyCustomer => ({
  customerNo: String(r.CUSTOMER_NO),
  kycRefNo: String(r.KYC_REF_NO),
  seqNo: Number(r.MOD_NO),
  customerType: r.KYC_CUST_TYPE === 'C' ? 'CORPORATE' : 'INDIVIDUAL',
  stagingRows: Number(r.STAGING_ROWS ?? 0),
});

export class CustomerTriggerSource {
  private readonly since: string;
  private readonly sql: { corporate: string; individualOnly: string };

  constructor(
    private readonly db: IFlexcubeSqlExecutor,
    stagingTable: string,
    syncStartDate: string,
    private readonly writeEnabled = false,
  ) {
    const since = normalizeSyncStartDate(syncStartDate);
    if (since === undefined) throw new Error('FLEXCUBE_SYNC_START_DATE is required');
    this.since = since;
    const table = assertSafeTableName(stagingTable);
    this.sql = {
      corporate: readyCustomersSql(table, true),
      individualOnly: readyCustomersSql(table, false),
    };
  }

  /** READ-ONLY. `corporate` must only be true once the key-person type column is proven (as for the poller). */
  async findReady(maxRows: number, corporate = false): Promise<ReadyCustomer[]> {
    const rows = await this.db.query(corporate ? this.sql.corporate : this.sql.individualOnly, {
      readyStatus: TRIGGER_READY,
      since: this.since,
      maxRows,
    });
    return rows.map(toReady);
  }

  /**
   * U -> P for ONE row. Call it only AFTER the staging row for this revision is durable, so a crash in
   * between leaves the row at U and the next pass finds the existing staging row (idempotent) instead of
   * losing the customer. Returns false when the row was no longer at U (taken elsewhere / changed).
   */
  async markPicked(customerNo: string, kycRefNo: string): Promise<boolean> {
    if (!this.writeEnabled) throw new TriggerWriteDisabledError();
    const { rowsAffected } = await this.db.execute(markPickedSql, {
      pickedStatus: TRIGGER_PICKED,
      customerNo,
      kycRefNo,
      readyStatus: TRIGGER_READY,
    });
    return rowsAffected === 1;
  }
}
