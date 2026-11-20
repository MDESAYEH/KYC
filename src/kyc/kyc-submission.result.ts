import { KycRequestStatus } from '../common/kyc-status';
import { KycCase } from '../persistence/kyc-case';
import { ReisOnboardingStatus } from '../reis/reis-status';

/** Where in the flow a submission failed. */
export type FailureStage = 'VALIDATION' | 'REIS_AUTHENTICATE' | 'REIS_ONBOARDING';

/** Why an existing case was not sent again (no REIS call, nothing changed). */
export type DuplicateReason =
  /** Another submission of the case is being processed right now. */
  | 'IN_PROGRESS'
  | 'ALREADY_CLEAN'
  /** PENDING at REIS: waiting for the /customerStatus callback. */
  | 'AWAITING_FINAL_STATUS'
  | 'ALREADY_REJECTED'
  | 'ALREADY_FINALIZED'
  /** REIS refused this revision permanently; a corrected CIF (new SEQ_NO) is needed. */
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

/** The revision already has a case that is not sent again; no REIS call was made. */
export interface SubmissionDuplicate {
  outcome: 'DUPLICATE';
  reason: DuplicateReason;
  kycCase: KycCase;
}

/** The submission failed; the failure is classified and persisted (persistedStatus decides a retry). */
export interface SubmissionFailed {
  outcome: 'FAILED';
  stage: FailureStage;
  /** Stable machine-readable code (also stored as last_error_code). */
  code: string;
  /** What failed, e.g. 'Required field "BIRTH_DATE" is missing or blank'. Names fields, never values. */
  message: string;
  /** Diagnostic only: true when the onboarding request may have been received by REIS. */
  requestMayHaveReachedReis: boolean;
  persistedStatus: KycRequestStatus;
  /** Null when the request was too broken to create a case (no KYC_REF_NO / CIF / customer type). */
  kycCase: KycCase | null;
  /** Body that was (or would have been) sent to REIS, when transformation succeeded. */
  reisRequest?: object;
}

export type KycSubmissionResult = SubmissionOnboarded | SubmissionDuplicate | SubmissionFailed;
