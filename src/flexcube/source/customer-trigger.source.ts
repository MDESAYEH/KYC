import { IFlexcubeSqlExecutor, SqlRow, assertSafeTableName } from '../staging/flexcube-staging';
import { normalizeSyncStartDate } from './flexcube-kyc-source';

/**
 * Trigger table agreed with Finexta (Abhilash, 18/11/2026) INSTEAD of a webhook: STTM_CUSTOMER_CUSTOM
 * (CUSTOMER_NO, KYC_REF_NO, READY_TO_SCAN). A row is inserted with READY_TO_SCAN = 'U' once the CIF is
 * authorized, and set back to 'U' after a modified CIF is authorized. The Integration API picks up 'U' rows,
 * reads the details from the real FCUBS tables, and sets the row to 'P' once it has picked it up.
 *
 * Finexta answers (Abhilash, 19/11/2026): FCUBS writes only U; the API writes P when it picks a row and E
 * when processing fails. The version is STTM_CUSTOMER.MOD_NO (joined by CUSTOMER_NO) and it IS the staging
 * SEQ_NO, because every send carries the CIF: a CIF modified without a new KYC revision gets a new SEQ_NO.
 *
 * NOT wired into the poller yet (the application workflow still holds CIF submissions). Writing P / E is the
 * only write to a FLEXCUBE-owned table, so it is refused unless `writeEnabled` is passed explicitly.
 */
export const TRIGGER_READY = 'U';
export const TRIGGER_PICKED = 'P';
export const TRIGGER_ERROR = 'E';

export interface ReadyCustomer {
  /** The CIF, exactly as the trigger row holds it (a string: leading zeros are kept). */
  customerNo: string;
  kycRefNo: string;
  /** Current CIF revision (STTM_CUSTOMER.MOD_NO) = the staging SEQ_NO (Finexta 19/11/2026). */
  seqNo: number;
  /** Current KYC revision (STTM_KYC_MASTER.MOD_NO), for evidence only. */
  kycModNo: number;
  customerType: 'INDIVIDUAL' | 'CORPORATE';
  /** Staging rows that already exist for this CIF revision (decides reuse / skip, never an overwrite). */
  stagingRows: number;
  /**
   * Rows of the KYC with a HIGHER SEQ_NO (written before the trigger flow, SEQ_NO = KYC MOD_NO). FLEXCUBE's
   * account check reads the highest SEQ_NO (Abhilash 19/11/2026), so such a customer must not be sent: E.
   */
  higherRows: number;
}

export class TriggerWriteDisabledError extends Error {
  constructor() {
    super('Writing READY_TO_SCAN is disabled (pass writeEnabled explicitly)');
    this.name = 'TriggerWriteDisabledError';
  }
}

export const customerTriggerTable = 'STTM_CUSTOMER_CUSTOM';

/**
 * Rows still waiting, with the CIF revision (SEQ_NO) and the open KYC master row (cut-off applied there: the
 * trigger table has no date).
 */
export const readyCustomersSql = (stagingTable: string, corporate: boolean): string =>
  `SELECT t.CUSTOMER_NO, t.KYC_REF_NO, c.MOD_NO AS CIF_MOD_NO, m.MOD_NO AS KYC_MOD_NO, m.KYC_CUST_TYPE,
          (SELECT COUNT(*) FROM ${stagingTable} s
            WHERE s.KYC_REF_NO = t.KYC_REF_NO AND s.SEQ_NO = c.MOD_NO) AS STAGING_ROWS,
          (SELECT COUNT(*) FROM ${stagingTable} s
            WHERE s.KYC_REF_NO = t.KYC_REF_NO AND s.SEQ_NO > c.MOD_NO) AS HIGHER_ROWS
     FROM ${customerTriggerTable} t
     JOIN STTM_CUSTOMER c ON c.CUSTOMER_NO = t.CUSTOMER_NO
     JOIN STTM_KYC_MASTER m ON m.KYC_REF_NO = t.KYC_REF_NO
    WHERE t.READY_TO_SCAN = :readyStatus
      AND m.RECORD_STAT = 'O'
      AND m.KYC_CUST_TYPE IN ${corporate ? "('R', 'C')" : "('R')"}
      AND m.MAKER_DT_STAMP >= TO_DATE(:since, 'YYYY-MM-DD"T"HH24:MI:SS')
    ORDER BY t.KYC_REF_NO
    FETCH FIRST :maxRows ROWS ONLY`;

/**
 * Conditional: only a row still at U, and only while the CIF is still at the revision we staged, is taken; two
 * instances never pick the same CIF, and a CIF modified in between is left at U for the next pass.
 */
export const markPickedSql = `UPDATE ${customerTriggerTable} t
    SET READY_TO_SCAN = :pickedStatus
  WHERE t.CUSTOMER_NO = :customerNo AND t.KYC_REF_NO = :kycRefNo AND t.READY_TO_SCAN = :readyStatus
    AND EXISTS (SELECT 1 FROM STTM_CUSTOMER c WHERE c.CUSTOMER_NO = t.CUSTOMER_NO AND c.MOD_NO = :seqNo)`;

/** U or P -> E for ONE row whose processing failed (Finexta: the API sets E); same revision condition. */
export const markErrorSql = `UPDATE ${customerTriggerTable} t
    SET READY_TO_SCAN = :errorStatus
  WHERE t.CUSTOMER_NO = :customerNo AND t.KYC_REF_NO = :kycRefNo
    AND t.READY_TO_SCAN IN (:readyStatus, :pickedStatus)
    AND EXISTS (SELECT 1 FROM STTM_CUSTOMER c WHERE c.CUSTOMER_NO = t.CUSTOMER_NO AND c.MOD_NO = :seqNo)`;

const toReady = (r: SqlRow): ReadyCustomer => ({
  customerNo: String(r.CUSTOMER_NO),
  kycRefNo: String(r.KYC_REF_NO),
  seqNo: Number(r.CIF_MOD_NO),
  kycModNo: Number(r.KYC_MOD_NO),
  customerType: r.KYC_CUST_TYPE === 'C' ? 'CORPORATE' : 'INDIVIDUAL',
  stagingRows: Number(r.STAGING_ROWS ?? 0),
  higherRows: Number(r.HIGHER_ROWS ?? 0),
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
  async markPicked(customer: ReadyCustomer): Promise<boolean> {
    if (!this.writeEnabled) throw new TriggerWriteDisabledError();
    const { rowsAffected } = await this.db.execute(markPickedSql, {
      pickedStatus: TRIGGER_PICKED,
      customerNo: customer.customerNo,
      kycRefNo: customer.kycRefNo,
      readyStatus: TRIGGER_READY,
      seqNo: customer.seqNo,
    });
    return rowsAffected === 1;
  }

  /** Processing failed (Finexta: E). A row FCUBS moved to a newer CIF revision is not touched. */
  async markError(customer: ReadyCustomer): Promise<boolean> {
    if (!this.writeEnabled) throw new TriggerWriteDisabledError();
    const { rowsAffected } = await this.db.execute(markErrorSql, {
      errorStatus: TRIGGER_ERROR,
      customerNo: customer.customerNo,
      kycRefNo: customer.kycRefNo,
      readyStatus: TRIGGER_READY,
      pickedStatus: TRIGGER_PICKED,
      seqNo: customer.seqNo,
    });
    return rowsAffected === 1;
  }
}
