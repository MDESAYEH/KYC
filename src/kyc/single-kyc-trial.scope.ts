/** Explicit one-record experiment. The reported CIF is a comparison value, never a source fallback. */
export const SINGLE_KYC_TRIAL = Object.freeze({
  kycRefNo: '001ZKYC26151003Y',
  seqNo: 2,
  expectedCif: '00005804',
});

/** Fence both old and proposed identities out of the legacy MAX(SEQ_NO)/APPROVED callback path. */
export function singleTrialCallbackIsHeld(systemId: string): boolean {
  return systemId === SINGLE_KYC_TRIAL.kycRefNo || systemId === SINGLE_KYC_TRIAL.expectedCif;
}
