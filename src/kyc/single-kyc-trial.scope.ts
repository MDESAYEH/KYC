/** Explicit one-record experiment. The reported CIF is a comparison value, never a source fallback. */
export const SINGLE_KYC_TRIAL = Object.freeze({
  kycRefNo: '001ZKYC26151003Y',
  /**
   * Staging SEQ_NO = STTM_CUSTOMER.MOD_NO of the CIF (Finexta, Abhilash 19/11/2026: every send carries the
   * CIF, so the CIF revision is the version). Read 19/11/2026: CIF MOD_NO 1 (KYC MOD_NO 2). If the CIF is
   * modified again, the approved CIF SELECT returns no row and the trial refuses: this constant is then
   * changed by a reviewed commit, never at run time.
   */
  seqNo: 1,
  expectedCif: '00005818',
});

/**
 * Only the OLD identity (systemId = KYC_REF_NO) stays quarantined: it was never sent, so a callback under it is
 * unexpected. The CIF identity was released on 19/11/2026 after the review of 9f8b5fc: a callback is applied only
 * when exactly one revision was ever sent under the CIF (kyc_case.revision_count = 1, true for this trial) and the
 * staging update REQUIRES the case's exact SEQ_NO (no MAX(SEQ_NO) fallback), so it can only reach this trial's row.
 */
export function singleTrialCallbackIsHeld(systemId: string): boolean {
  return systemId === SINGLE_KYC_TRIAL.kycRefNo;
}
