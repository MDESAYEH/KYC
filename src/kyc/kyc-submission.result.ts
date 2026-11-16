import { KycRequestStatus } from '../common/kyc-status';
import { KycCase } from '../persistence/kyc-case';
import { ReisOnboardingStatus } from '../reis/reis-status';

/** Where in the flow a submission failed. */
export type FailureStage = 'VALIDATION' | 'REIS_AUTHENTICATE' | 'REIS_ONBOARDING';

/**
 * Why a repeated KYC_REF_NO was not processed again. No external call is made and nothing is
 * changed in any of these cases: automatic resubmission is not allowed until the Bank defines the
 * retry / resubmission business rule.
 */
export type DuplicateReason =
  /** Case exists but REIS was not (yet) confirmed contacted: in flight, or interrupted. */
  | 'IN_PROGRESS_OR_UNCERTAIN'
  | 'ALREADY_CLEAN'
  /** PENDING at REIS: waiting for the later /customerStatus callback. */
  | 'AWAITING_FINAL_STATUS'
  | 'ALREADY_REJECTED'
  | 'ALREADY_FINALIZED'
  /** A previous onboarding call may have reached REIS and its outcome is unknown. */
  | 'DELIVERY_UNCERTAIN'
  /** A previous attempt failed (retry/resubmission rule TBD). */
  | 'PREVIOUS_ATTEMPT_FAILED';

/** REIS answered CLEAN, PENDING or REJECT. All three are normal, distinct outcomes. */
export interface SubmissionOnboarded {
  outcome: 'ONBOARDED';
  reisOnboardingStatus: ReisOnboardingStatus;
  /** Returned to the caller only; NOT persisted (REIS free text may carry personal data). */
  instruction?: string | null;
  errorMessage?: string | null;
  kycCase: KycCase;
  /** Exact body sent to REIS and the validated response (for the FLEXCUBE staging table). */
  reisRequest: object;
  reisResponse: object;
}

/** The KYC_REF_NO already has a case; no REIS call was made. */
export interface SubmissionDuplicate {
  outcome: 'DUPLICATE';
  reason: DuplicateReason;
  kycCase: KycCase;
}

/** The submission failed; the failure is classified and persisted. Never retried automatically. */
export interface SubmissionFailed {
  outcome: 'FAILED';
  stage: FailureStage;
  /** Stable machine-readable code (also stored as last_error_code). */
  code: string;
  /** Diagnostic only: true when the onboarding request may have been received by REIS. */
  requestMayHaveReachedReis: boolean;
  /** Internal status the case was left in (VALIDATION_FAILED, FAILED_*, DELIVERY_UNCERTAIN). */
  persistedStatus: KycRequestStatus;
  /** Null only when nothing identifiable could be persisted (no usable KYC_REF_NO/customer type). */
  kycCase: KycCase | null;
  /** Body that was (or would have been) sent to REIS, when transformation succeeded. */
  reisRequest?: object;
}

export type KycSubmissionResult = SubmissionOnboarded | SubmissionDuplicate | SubmissionFailed;
