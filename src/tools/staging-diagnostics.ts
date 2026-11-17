import { OWN_MSGID_PATTERN, IFlexcubeSqlExecutor } from '../flexcube/staging/flexcube-staging';

/**
 * Read-only classification of OUR staging rows (UUID MSGID) against the current KYC versions.
 * Only counts and technical markers leave the database: never a KYC reference, a name or a
 * payload. Used by `npm run check:uat1`.
 */
export interface RecoveryDiagnostics {
  rows: { rowKind: string; kycState: string; count: number }[];
  /** N rows the service picks up by itself (never claimed, current MOD_NO, open, since the cut-off). */
  autoRecoverable: number;
  /** E rows that were never sent (no request, no REQ_DATE): candidates for the reconciliation tool. */
  neverSentInE: number;
  neverSentMarkers: { marker: string; count: number }[];
  /** Everything else of ours that needs a manual look. */
  needsReview: number;
}

/** Marker stored by the service in RESPONSE for a technical failure: {"error":"<code>"} */
const MARKER_PATTERN = '^[{]"error":"[A-Za-z0-9_-]+"[}]$';

export const recoveryClassificationSql = (staging: string): string =>
  `SELECT ROW_KIND, KYC_STATE, COUNT(*) AS N FROM (
     SELECT CASE
              WHEN s.PROCESS_STATUS = :newStatus AND s.REQ_DATE IS NULL AND s.REQUEST IS NULL THEN 'N_UNCLAIMED'
              WHEN s.PROCESS_STATUS = :errorStatus AND s.REQ_DATE IS NULL AND s.REQUEST IS NULL THEN 'E_NEVER_SENT'
              WHEN s.PROCESS_STATUS = :inProgressStatus THEN 'IN_PROGRESS'
              ELSE 'OTHER' END AS ROW_KIND,
            CASE
              WHEN m.KYC_REF_NO IS NULL THEN 'NO_MASTER'
              WHEN m.MOD_NO <> s.SEQ_NO THEN 'MOD_NO_CHANGED'
              WHEN m.RECORD_STAT <> 'O' THEN 'NOT_OPEN'
              WHEN m.KYC_CUST_TYPE NOT IN ('R', 'C') THEN 'TYPE_NOT_SUPPORTED'
              WHEN m.MAKER_DT_STAMP < TO_DATE(:since, 'YYYY-MM-DD"T"HH24:MI:SS') THEN 'BEFORE_CUTOFF'
              ELSE 'MATCHES_CURRENT_KYC' END AS KYC_STATE
       FROM ${staging} s LEFT JOIN STTM_KYC_MASTER m ON m.KYC_REF_NO = s.KYC_REF_NO
      WHERE REGEXP_LIKE(s.MSGID, '${OWN_MSGID_PATTERN}', 'i')
   ) GROUP BY ROW_KIND, KYC_STATE ORDER BY ROW_KIND, KYC_STATE`;

export const neverSentMarkersSql = (staging: string): string =>
  `SELECT MARKER, COUNT(*) AS N FROM (
     SELECT CASE WHEN REGEXP_LIKE(TO_CHAR(SUBSTR(RESPONSE, 1, 200)), '${MARKER_PATTERN}')
                 THEN TO_CHAR(SUBSTR(RESPONSE, 1, 200)) ELSE 'OTHER' END AS MARKER
       FROM ${staging}
      WHERE PROCESS_STATUS = :errorStatus AND REQ_DATE IS NULL AND REQUEST IS NULL
        AND REGEXP_LIKE(MSGID, '${OWN_MSGID_PATTERN}', 'i')
   ) GROUP BY MARKER ORDER BY MARKER`;

export async function recoveryDiagnostics(
  db: IFlexcubeSqlExecutor,
  staging: string,
  cutoff: string,
): Promise<RecoveryDiagnostics> {
  const kinds = await db.query(recoveryClassificationSql(staging), {
    newStatus: 'N',
    errorStatus: 'E',
    inProgressStatus: 'W',
    since: cutoff,
  });
  const markers = await db.query(neverSentMarkersSql(staging), { errorStatus: 'E' });
  const rows = kinds.map((r) => ({
    rowKind: String(r.ROW_KIND),
    kycState: String(r.KYC_STATE),
    count: Number(r.N),
  }));
  const sum = (pred: (r: (typeof rows)[number]) => boolean) =>
    rows.filter(pred).reduce((a, r) => a + r.count, 0);
  return {
    rows,
    autoRecoverable: sum(
      (r) => r.rowKind === 'N_UNCLAIMED' && r.kycState === 'MATCHES_CURRENT_KYC',
    ),
    neverSentInE: sum((r) => r.rowKind === 'E_NEVER_SENT'),
    neverSentMarkers: markers.map((r) => ({ marker: String(r.MARKER), count: Number(r.N) })),
    needsReview: sum(
      (r) =>
        !(r.rowKind === 'N_UNCLAIMED' && r.kycState === 'MATCHES_CURRENT_KYC') &&
        r.rowKind !== 'E_NEVER_SENT',
    ),
  };
}
