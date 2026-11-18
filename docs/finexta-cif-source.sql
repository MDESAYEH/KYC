-- CIF source for the single-KYC trial (--cif-sql). READ-ONLY. Not run.
-- Origin: Abhilash (Finexta), 17/11/2026: CIF = STTM_CUSTOMER.CUSTOMER_NO, linked by KYC_REF_NO. The CIF must exist
-- before the KYC is sent to REIS. His query had a "FROM FROM" typo and selected C.* - adapted here and to be confirmed by him:
--   * only CUSTOMER_NO is selected (aliased CIF_VALUE, the column the trial reads); no other customer data;
--   * columns are qualified (C.KYC_REF_NO);
--   * K.MOD_NO = :seqNo ties the CIF to the exact KYC revision (the trial runner requires the :seqNo bind).
--     This condition was added by development and was NOT in Abhilash's query: he must confirm or reject it.
-- Status 18/11/2026: REIS_KYC gets ORA-00942 on STTM_CUSTOMER (SELECT grant requested from Tareq). The CIF of
-- 001ZKYC26151003Y is NOT verified yet; B1 closes only when this returns exactly one row equal to 00005804.
SELECT C.CUSTOMER_NO AS CIF_VALUE
  FROM STTM_CUSTOMER C
 WHERE C.KYC_REF_NO = :kycRefNo
   AND C.KYC_DETAILS = 'V'
   AND C.RECORD_STAT = 'O'
   AND C.AUTH_STAT = 'A'
   AND EXISTS (SELECT 1
                 FROM STTM_KYC_MASTER K
                WHERE K.KYC_REF_NO = C.KYC_REF_NO
                  AND K.MOD_NO = :seqNo
                  AND K.RECORD_STAT = 'O'
                  AND K.AUTH_STAT = 'A')
