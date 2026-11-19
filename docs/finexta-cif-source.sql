-- CIF source for the single-KYC trial (--cif-sql). READ-ONLY. Not run by the code on its own.
-- Origin: Abhilash (Finexta), 17/11/2026: CIF = STTM_CUSTOMER.CUSTOMER_NO, linked by KYC_REF_NO.
-- Updated 19/11/2026 for the trigger-table flow agreed with Finexta:
--   * the KYC is sent only while its row in STTM_CUSTOMER_CUSTOM is READY_TO_SCAN = 'U' (FCUBS sets U after the
--     CIF is authorized, and again after a CIF modification is authorized);
--   * SEQ_NO = STTM_CUSTOMER.MOD_NO (Abhilash 19/11/2026: every send carries the CIF), so :seqNo is bound to the
--     CIF revision, not to STTM_KYC_MASTER.MOD_NO. A CIF modified after the preflight returns no row (refused);
--   * only CUSTOMER_NO is selected (aliased CIF_VALUE, the column the trial reads); no other customer data.
-- Checked 19/11/2026 on UAT1 (read-only): CIF 00005818, STTM_CUSTOMER.MOD_NO = 1, trigger row = U.
SELECT C.CUSTOMER_NO AS CIF_VALUE
  FROM STTM_CUSTOMER C
 WHERE C.KYC_REF_NO = :kycRefNo
   AND C.MOD_NO = :seqNo
   AND C.KYC_DETAILS = 'V'
   AND C.RECORD_STAT = 'O'
   AND C.AUTH_STAT = 'A'
   AND EXISTS (SELECT 1
                 FROM STTM_CUSTOMER_CUSTOM T
                WHERE T.CUSTOMER_NO = C.CUSTOMER_NO
                  AND T.KYC_REF_NO = C.KYC_REF_NO
                  AND T.READY_TO_SCAN = 'U')
   AND EXISTS (SELECT 1
                 FROM STTM_KYC_MASTER K
                WHERE K.KYC_REF_NO = C.KYC_REF_NO
                  AND K.RECORD_STAT = 'O'
                  AND K.AUTH_STAT = 'A')
