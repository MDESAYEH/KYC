import {
  assertSafeTableName,
  IFlexcubeSqlExecutor,
  OWN_MSGID_PATTERN,
  SqlRow,
} from '../staging/flexcube-staging';
import { normalizeSyncStartDate } from './flexcube-kyc-source';

/**
 * Trigger table agreed with Finexta (Abhilash, 18-19/11/2026): STTM_CUSTOMER_CUSTOM (CUSTOMER_NO, KYC_REF_NO,
 * READY_TO_SCAN). FCUBS sets U after a CIF is created or modified and authorized; the API sets P when it picks
 * the row and E when processing fails. The revision is STTM_CUSTOMER.MOD_NO and it IS the staging SEQ_NO.
 */
export const TRIGGER_READY = 'U';
export const TRIGGER_PICKED = 'P';
export const TRIGGER_ERROR = 'E';

export const customerTriggerTable = 'STTM_CUSTOMER_CUSTOM';

/** One CIF revision to send (new, or again after a failed attempt). */
export interface TriggerWork {
  /** The CIF, exactly as the trigger row holds it (a string: leading zeros are kept). */
  customerNo: string;
  kycRefNo: string;
  /** CIF revision (STTM_CUSTOMER.MOD_NO) = staging SEQ_NO. */
  seqNo: number;
  customerType: 'INDIVIDUAL' | 'CORPORATE';
  /** Staging rows of this revision (0 = not staged yet). */
  stagingRows: number;
  /**
   * Rows of the KYC with a HIGHER SEQ_NO (written before the trigger flow). FLEXCUBE's account check reads the
   * highest SEQ_NO, so such a customer must not be sent.
   */
  higherRows: number;
  /** Failed attempts already counted on the staging row. */
  retryCount: number;
  /** The trigger is already P (a retry): it is not picked again. */
  picked: boolean;
  /**
   * A revision that failed validation (never sent) is checked again: the data may have been corrected in FLEXCUBE
   * without a new CIF revision. Its trigger is E and its staging row E.
   */
  recheck: boolean;
  /** For a recheck after a REIS rejection: the REQUEST that was refused (sent again only if the data changed). */
  previousRequest?: string;
}

const types = (corporate: boolean) => (corporate ? "('R', 'C')" : "('R')");

/** U rows with the CIF revision and the open KYC master row (created since the cut-off, when one is set). */
export const readyCustomersSql = (
  stagingTable: string,
  corporate: boolean,
  cutOff: boolean,
): string =>
  `SELECT t.CUSTOMER_NO, t.KYC_REF_NO, c.MOD_NO AS CIF_MOD_NO, m.KYC_CUST_TYPE,
          (SELECT COUNT(*) FROM ${stagingTable} s
            WHERE s.KYC_REF_NO = t.KYC_REF_NO AND s.SEQ_NO = c.MOD_NO) AS STAGING_ROWS,
          (SELECT COUNT(*) FROM ${stagingTable} s
            WHERE s.KYC_REF_NO = t.KYC_REF_NO AND s.SEQ_NO > c.MOD_NO) AS HIGHER_ROWS,
          (SELECT NVL(MAX(s.RETRY_COUNT), 0) FROM ${stagingTable} s
            WHERE s.KYC_REF_NO = t.KYC_REF_NO AND s.SEQ_NO = c.MOD_NO) AS RETRY_COUNT
     FROM ${customerTriggerTable} t
     JOIN STTM_CUSTOMER c ON c.CUSTOMER_NO = t.CUSTOMER_NO
     JOIN STTM_KYC_MASTER m ON m.KYC_REF_NO = t.KYC_REF_NO
    WHERE t.READY_TO_SCAN = :readyStatus
      AND m.RECORD_STAT = 'O'
      AND m.KYC_CUST_TYPE IN ${types(corporate)}
      ${cutOff ? `AND m.MAKER_DT_STAMP >= TO_DATE(:since, 'YYYY-MM-DD"T"HH24:MI:SS')` : ''}
    ORDER BY t.KYC_REF_NO
    FETCH FIRST :maxRows ROWS ONLY`;

/**
 * Our N rows waiting for another attempt: at least one failed attempt, the last one older than the delay, the
 * trigger still P and the CIF still at the same revision (a newer revision comes back as U instead).
 */
export const retryDueSql = (stagingTable: string, corporate: boolean): string =>
  `SELECT t.CUSTOMER_NO, t.KYC_REF_NO, c.MOD_NO AS CIF_MOD_NO, m.KYC_CUST_TYPE,
          NVL(s.RETRY_COUNT, 0) AS RETRY_COUNT
     FROM ${stagingTable} s
     JOIN ${customerTriggerTable} t ON t.KYC_REF_NO = s.KYC_REF_NO
     JOIN STTM_CUSTOMER c ON c.CUSTOMER_NO = t.CUSTOMER_NO AND c.MOD_NO = s.SEQ_NO
     JOIN STTM_KYC_MASTER m ON m.KYC_REF_NO = t.KYC_REF_NO
    WHERE s.PROCESS_STATUS = :newStatus
      AND NVL(s.RETRY_COUNT, 0) > 0
      AND REGEXP_LIKE(s.MSGID, '${OWN_MSGID_PATTERN}', 'i')
      AND (s.RES_DATE IS NULL OR s.RES_DATE < SYSDATE - (:delaySeconds / 86400))
      AND t.READY_TO_SCAN = :pickedStatus
      AND m.RECORD_STAT = 'O'
      AND m.KYC_CUST_TYPE IN ${types(corporate)}
    ORDER BY s.RES_DATE
    FETCH FIRST :maxRows ROWS ONLY`;

/**
 * Our E rows that failed validation (RESPONSE stage VALIDATION) or whose data REIS refused (HTTP 4xx), last checked
 * before the delay, trigger E and the CIF still at the same revision: the KYC is read and validated again.
 * Only the latest revision of a KYC is rechecked: an older row stays E as history once a higher SEQ_NO exists.
 */
export const recheckDueSql = (stagingTable: string, corporate: boolean): string =>
  `SELECT t.CUSTOMER_NO, t.KYC_REF_NO, c.MOD_NO AS CIF_MOD_NO, m.KYC_CUST_TYPE, s.REQUEST AS PREVIOUS_REQUEST
     FROM ${stagingTable} s
     JOIN ${customerTriggerTable} t ON t.KYC_REF_NO = s.KYC_REF_NO
     JOIN STTM_CUSTOMER c ON c.CUSTOMER_NO = t.CUSTOMER_NO AND c.MOD_NO = s.SEQ_NO
     JOIN STTM_KYC_MASTER m ON m.KYC_REF_NO = t.KYC_REF_NO
    WHERE s.PROCESS_STATUS = :errorStatus
      AND NOT EXISTS (SELECT 1 FROM ${stagingTable} h
                       WHERE h.KYC_REF_NO = s.KYC_REF_NO AND h.SEQ_NO > s.SEQ_NO)
      AND (INSTR(s.RESPONSE, :validationMarker) > 0 OR INSTR(s.RESPONSE, :rejectedMarker) > 0
           OR INSTR(s.RESPONSE, :refusedAgainMarker) > 0)
      AND REGEXP_LIKE(s.MSGID, '${OWN_MSGID_PATTERN}', 'i')
      AND (s.RES_DATE IS NULL OR s.RES_DATE < SYSDATE - (:delaySeconds / 86400))
      AND t.READY_TO_SCAN = :errorStatus
      AND m.RECORD_STAT = 'O'
      AND m.KYC_CUST_TYPE IN ${types(corporate)}
    ORDER BY s.RES_DATE
    FETCH FIRST :maxRows ROWS ONLY`;

/** Marker of a validation failure in the staging RESPONSE (written by the poller). */
export const VALIDATION_MARKER = '"stage":"VALIDATION"';
/** Marker of a REIS refusal of the data (HTTP 4xx other than 401 / 403). */
export const REJECTED_MARKER = '"error":"REIS_ONBOARDING_HTTP_ERROR"';
/** Marker of an older poller version that refused to resend a REIS-refused revision. */
export const REFUSED_AGAIN_MARKER = '"duplicate":"PREVIOUS_ATTEMPT_FAILED"';
/** Every RESPONSE marker of a row the recheck may read again. */
export const RECHECK_MARKERS = [VALIDATION_MARKER, REJECTED_MARKER, REFUSED_AGAIN_MARKER] as const;

/** U (or E for a recheck) -> P only while the CIF is still at the staged revision. */
export const markPickedSql = `UPDATE ${customerTriggerTable} t
    SET READY_TO_SCAN = :pickedStatus
  WHERE t.CUSTOMER_NO = :customerNo AND t.KYC_REF_NO = :kycRefNo AND t.READY_TO_SCAN = :readyStatus
    AND EXISTS (SELECT 1 FROM STTM_CUSTOMER c WHERE c.CUSTOMER_NO = t.CUSTOMER_NO AND c.MOD_NO = :seqNo)`;

/** U or P -> E for one row whose processing failed; same revision condition. */
export const markErrorSql = `UPDATE ${customerTriggerTable} t
    SET READY_TO_SCAN = :errorStatus
  WHERE t.CUSTOMER_NO = :customerNo AND t.KYC_REF_NO = :kycRefNo
    AND t.READY_TO_SCAN IN (:readyStatus, :pickedStatus)
    AND EXISTS (SELECT 1 FROM STTM_CUSTOMER c WHERE c.CUSTOMER_NO = t.CUSTOMER_NO AND c.MOD_NO = :seqNo)`;

const toWork = (r: SqlRow, picked: boolean, recheck = false): TriggerWork => ({
  customerNo: String(r.CUSTOMER_NO),
  kycRefNo: String(r.KYC_REF_NO),
  seqNo: Number(r.CIF_MOD_NO),
  customerType: r.KYC_CUST_TYPE === 'C' ? 'CORPORATE' : 'INDIVIDUAL',
  stagingRows: picked || recheck ? 1 : Number(r.STAGING_ROWS ?? 0),
  higherRows: picked || recheck ? 0 : Number(r.HIGHER_ROWS ?? 0),
  retryCount: recheck ? 0 : Number(r.RETRY_COUNT ?? 0),
  picked,
  recheck,
  ...(recheck && r.PREVIOUS_REQUEST != null ? { previousRequest: String(r.PREVIOUS_REQUEST) } : {}),
});

export class CustomerTriggerSource {
  private readonly since: string | undefined;
  private readonly sql: {
    ready: Record<'corporate' | 'individual', string>;
    retry: Record<'corporate' | 'individual', string>;
    recheck: Record<'corporate' | 'individual', string>;
  };

  constructor(
    private readonly db: IFlexcubeSqlExecutor,
    stagingTable: string,
    /** FLEXCUBE_SYNC_START_DATE (optional): only KYCs created on / after it. Undefined = no cut-off. */
    syncStartDate?: string,
  ) {
    if (syncStartDate !== undefined) {
      this.since = normalizeSyncStartDate(syncStartDate);
      if (this.since === undefined) throw new Error('FLEXCUBE_SYNC_START_DATE is not a valid date');
    }
    const cutOff = this.since !== undefined;
    const table = assertSafeTableName(stagingTable);
    this.sql = {
      ready: {
        corporate: readyCustomersSql(table, true, cutOff),
        individual: readyCustomersSql(table, false, cutOff),
      },
      retry: { corporate: retryDueSql(table, true), individual: retryDueSql(table, false) },
      recheck: { corporate: recheckDueSql(table, true), individual: recheckDueSql(table, false) },
    };
  }

  /** New CIF revisions (trigger U). `corporate` only once the key-person type column is proven. */
  async findReady(maxRows: number, corporate: boolean): Promise<TriggerWork[]> {
    const rows = await this.db.query(this.sql.ready[corporate ? 'corporate' : 'individual'], {
      readyStatus: TRIGGER_READY,
      ...(this.since !== undefined ? { since: this.since } : {}),
      maxRows,
    });
    return rows.map((r) => toWork(r, false));
  }

  /** Failed attempts whose delay has passed (trigger P, staging N). */
  async findRetryDue(
    maxRows: number,
    corporate: boolean,
    delaySeconds: number,
  ): Promise<TriggerWork[]> {
    const rows = await this.db.query(this.sql.retry[corporate ? 'corporate' : 'individual'], {
      newStatus: 'N',
      delaySeconds,
      pickedStatus: TRIGGER_PICKED,
      maxRows,
    });
    return rows.map((r) => toWork(r, true));
  }

  /** Validation failures and REIS data refusals whose recheck delay has passed (trigger E, staging E). */
  async findRecheckDue(
    maxRows: number,
    corporate: boolean,
    delaySeconds: number,
  ): Promise<TriggerWork[]> {
    const rows = await this.db.query(this.sql.recheck[corporate ? 'corporate' : 'individual'], {
      errorStatus: TRIGGER_ERROR,
      validationMarker: VALIDATION_MARKER,
      rejectedMarker: REJECTED_MARKER,
      refusedAgainMarker: REFUSED_AGAIN_MARKER,
      delaySeconds,
      maxRows,
    });
    return rows.map((r) => toWork(r, false, true));
  }

  /** U -> P (E -> P for a recheck) for one row; false when it moved or the CIF changed. */
  async markPicked(work: TriggerWork): Promise<boolean> {
    const { rowsAffected } = await this.db.execute(markPickedSql, {
      pickedStatus: TRIGGER_PICKED,
      customerNo: work.customerNo,
      kycRefNo: work.kycRefNo,
      readyStatus: work.recheck ? TRIGGER_ERROR : TRIGGER_READY,
      seqNo: work.seqNo,
    });
    return rowsAffected === 1;
  }

  /** U / P -> E. A row FCUBS moved to a newer CIF revision is not touched. */
  async markError(work: TriggerWork): Promise<boolean> {
    const { rowsAffected } = await this.db.execute(markErrorSql, {
      errorStatus: TRIGGER_ERROR,
      customerNo: work.customerNo,
      kycRefNo: work.kycRefNo,
      readyStatus: TRIGGER_READY,
      pickedStatus: TRIGGER_PICKED,
      seqNo: work.seqNo,
    });
    return rowsAffected === 1;
  }
}
