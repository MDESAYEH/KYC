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
  expectedCif: '00005804',
});

/**
 * BOTH identities are held for the two-attempt incident. revision_count=1 does not establish
 * which attempt produced a callback when the same SEQ_NO was attempted more than once.
 * Do not route to the latest case or trust caller-supplied attemptId/SEQ_NO extensions.
 * Only a separately reviewed provider correlation contract may release this quarantine.
 */
export function singleTrialCallbackIsHeld(systemId: string): boolean {
  return systemId === SINGLE_KYC_TRIAL.kycRefNo || systemId === SINGLE_KYC_TRIAL.expectedCif;
}
