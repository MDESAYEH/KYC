/** Initial status returned by REIS searchOnboardCustomer (V1.2). */
export enum ReisOnboardingStatus {
  CLEAN = 'CLEAN',
  PENDING = 'PENDING',
  REJECT = 'REJECT',
}

/** Final status sent by REIS to POST /customerStatus after a PENDING workflow completes. */
export enum ReisFinalStatus {
  CUSTOMER = 'CUSTOMER',
  BLOCKED = 'BLOCKED',
}
