/**
 * Whether the REIS final decision has been pushed to FLEXCUBE. Tracked SEPARATELY from the REIS
 * final status: a valid REIS callback must never be lost because the FLEXCUBE update failed.
 * The real FLEXCUBE mechanism is TBD (a mock is used meanwhile). No automatic retry exists.
 */
export enum FlexcubeUpdateStatus {
  /** No REIS final status yet. */
  NOT_ATTEMPTED = 'NOT_ATTEMPTED',
  /** REIS final status stored; the FLEXCUBE update has not completed (in flight or interrupted). */
  PENDING = 'PENDING',
  APPLIED = 'APPLIED',
  FAILED = 'FAILED',
}

/**
 * Internal lifecycle of a KYC case inside the Integration API. Deliberately separate from the
 * REIS onboarding statuses (CLEAN/PENDING/REJECT) and final statuses (CUSTOMER/BLOCKED), which
 * live in reis/reis-status.ts and are stored in their own columns.
 */
export enum KycRequestStatus {
  RECEIVED = 'RECEIVED',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  /** Set just before the REIS call; if it remains after a crash the REIS outcome is unknown. */
  SUBMITTED_TO_REIS = 'SUBMITTED_TO_REIS',
  REIS_CLEAN = 'REIS_CLEAN',
  REIS_PENDING = 'REIS_PENDING',
  REIS_REJECTED = 'REIS_REJECTED',
  FINALIZED = 'FINALIZED',
  /**
   * The onboarding request may have reached REIS but its outcome is unknown (timeout, reset,
   * 5xx, unreadable 2xx). Never retried automatically: a retry could duplicate the onboarding.
   */
  DELIVERY_UNCERTAIN = 'DELIVERY_UNCERTAIN',
  /**
   * FAILED_RETRYABLE / FAILED_PERMANENT are PROVISIONAL diagnostic classifications made by this
   * integration. They are NOT confirmed REIS business rules (REIS has not provided its retry,
   * timeout or error-code policy) and nothing retries on the strength of them.
   */
  FAILED_RETRYABLE = 'FAILED_RETRYABLE',
  FAILED_PERMANENT = 'FAILED_PERMANENT',
}
