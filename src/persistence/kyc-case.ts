import { CustomerType } from '../canonical';
import { FlexcubeUpdateStatus, KycRequestStatus } from '../common/kyc-status';
import { ReisFinalStatus, ReisOnboardingStatus } from '../reis/reis-status';

/**
 * Correlation / audit / retry record for one KYC submission. Database-agnostic.
 *
 *   FLEXCUBE KYC_REF_NO  <->  REIS systemId   (both searchable)
 *
 * Never holds tokens, passwords, REIS credentials, or full request/response payloads.
 */
export interface KycCase {
  internalId: string;
  kycRefNo: string;
  /** Null until the customer is created in FLEXCUBE. */
  customerNo: string | null;
  /** Value sent to REIS as systemId (currently equal to kycRefNo). */
  reisSystemId: string;
  reisCustomerId: number | null;
  riskCalculationId: string | null;
  reisId: string | null;
  customerType: CustomerType;
  internalRequestStatus: KycRequestStatus;
  /** Initial REIS result: CLEAN / PENDING / REJECT. */
  reisOnboardingStatus: ReisOnboardingStatus | null;
  /** Final /customerStatus result: CUSTOMER / BLOCKED. Set at most once. */
  finalStatus: ReisFinalStatus | null;
  finalStatusAt: Date | null;
  /** Number of callbacks received that agreed with finalStatus (1 = first, >1 = duplicates). */
  finalStatusReceivedCount: number;
  /** Set when a callback arrived with a final status that conflicts with finalStatus. */
  conflictingFinalStatus: ReisFinalStatus | null;
  /**
   * Onboarding response text from REIS. May contain sensitive information: persisted on purpose,
   * but never logged, never put into exception messages, never exposed by unrelated responses.
   */
  reisInstruction: string | null;
  reisErrorMessage: string | null;
  /** REIS final decision vs FLEXCUBE update are separate facts. */
  flexcubeUpdateStatus: FlexcubeUpdateStatus;
  flexcubeUpdateErrorCode: string | null;
  flexcubeUpdateErrorMessage: string | null;
  flexcubeUpdatedAt: Date | null;
  /** How many times the FLEXCUBE updater was called (automatic first attempt + manual recoveries). */
  flexcubeUpdateAttemptCount: number;
  flexcubeLastAttemptAt: Date | null;
  /** Latest FLEXCUBE submission sequence (staging SEQ_NO); 1 for the first submission. */
  seqNo: number;
  retryCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewKycCase {
  kycRefNo: string;
  customerType: CustomerType;
  customerNo?: string | null;
  /** Defaults to kycRefNo (current correlation rule). */
  reisSystemId?: string;
  /** FLEXCUBE submission sequence; defaults to 1. */
  seqNo?: number;
}

export interface OnboardingResult {
  reisOnboardingStatus: ReisOnboardingStatus;
  reisCustomerId?: number | null;
  riskCalculationId?: string | null;
  reisId?: string | null;
  /** REIS `instruction`; stored when provided (sensitive: never log). */
  instruction?: string | null;
  /** REIS `errorMessage`; stored when provided (sensitive: never log). */
  errorMessage?: string | null;
}

export interface CaseError {
  code: string;
  /** Must not contain secrets; it is truncated before storage. */
  message: string;
}

/** Result of recording a final-status callback (webhook idempotency foundation). */
export type FinalStatusOutcome =
  /** First final status for this case; state was updated. */
  | 'APPLIED'
  /** Same final status already recorded; state unchanged (only the received count grows). */
  | 'DUPLICATE'
  /** A different final status was already recorded; state unchanged, conflict flagged. */
  | 'CONFLICT'
  /** No case with that systemId. */
  | 'UNKNOWN_CASE'
  /** Callback carries a REIS customerId different from the one already stored; nothing changed. */
  | 'CUSTOMER_ID_MISMATCH'
  /**
   * The case is not in the expected PENDING lifecycle state (e.g. CLEAN, REJECT, uncertain,
   * failed) and has no final status; nothing changed and no override rule is invented.
   */
  | 'INCONSISTENT_STATE'
  /**
   * The case is DELIVERY_UNCERTAIN (onboarding outcome unknown) and REIS now sent a final status.
   * Whether such a callback may reconcile the case automatically is TBD (Bank/REIS decision), so
   * nothing is applied: finalStatus is not set, FLEXCUBE is not called, onboarding is not retried.
   * The callback is audited (including the incoming CUSTOMER/BLOCKED value).
   */
  | 'RECONCILIATION_REQUIRED';

export interface FinalStatusResult {
  outcome: FinalStatusOutcome;
  /** Case after the operation; null for UNKNOWN_CASE. */
  kycCase: KycCase | null;
}

export interface FlexcubeUpdateResult {
  status: FlexcubeUpdateStatus.APPLIED | FlexcubeUpdateStatus.FAILED;
  /** Failure classification code only. */
  errorCode?: string;
  /** Safe text only; never customer data. */
  errorMessage?: string;
}

/** Query criteria for operational lookups. `limit` is mandatory (capped by the repository). */
export interface CaseCriteria {
  internalRequestStatus?: import('../common/kyc-status').KycRequestStatus;
  flexcubeUpdateStatus?: FlexcubeUpdateStatus;
  /** Only cases last updated before this instant. */
  updatedBefore?: Date;
  limit: number;
}
