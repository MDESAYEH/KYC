import { TransformationError } from '../canonical/transformation.errors';
import { KycRequestStatus } from '../common/kyc-status';
import { UnmappedReferenceValueError } from '../mapping/reference-mapping';
import { ReisClientError } from '../reis/reis.errors';
import { FailureStage } from './kyc-submission.result';

/**
 * How a failure is recorded. This is a PROVISIONAL DIAGNOSTIC classification made by the
 * integration: REIS has not yet provided its retry/timeout/error-code policy, so FAILED_PERMANENT
 * and FAILED_RETRYABLE are NOT confirmed REIS business rules. Nothing here retries anything.
 */
export interface FailureClassification {
  stage: FailureStage;
  /** Stable code stored as last_error_code. */
  code: string;
  /** Safe description (no customer data, no secrets) stored as last_error_message. */
  message: string;
  /** Diagnostic: the onboarding request may have been received by REIS. */
  requestMayHaveReachedReis: boolean;
  persist:
    | KycRequestStatus.VALIDATION_FAILED
    | KycRequestStatus.FAILED_PERMANENT
    | KycRequestStatus.FAILED_RETRYABLE
    | KycRequestStatus.DELIVERY_UNCERTAIN;
}

const VALIDATION_CODES: Record<TransformationError['kind'], string> = {
  MISSING_FIELD: 'MISSING_REQUIRED_FIELD',
  INVALID_VALUE: 'INVALID_FIELD_VALUE',
  RULE_NOT_CONFIGURED: 'RULE_NOT_CONFIGURED',
};

/**
 * Failures raised by the mapper/transformer, i.e. BEFORE REIS is contacted. Returns null for any
 * other error (a bug), which the workflow rethrows.
 */
export function classifyPreReisFailure(error: unknown): FailureClassification | null {
  if (error instanceof UnmappedReferenceValueError) {
    return {
      stage: 'VALIDATION',
      code: 'UNMAPPED_REFERENCE',
      // The submitted value is deliberately left out: it may be free text (e.g. document type).
      message: `No active ${error.mappingType} mapping for a submitted value`,
      requestMayHaveReachedReis: false,
      persist: KycRequestStatus.VALIDATION_FAILED,
    };
  }
  if (error instanceof TransformationError) {
    return {
      stage: 'VALIDATION',
      code: VALIDATION_CODES[error.kind],
      message: error.message, // names fields/rules only, never customer data
      requestMayHaveReachedReis: false,
      persist: KycRequestStatus.VALIDATION_FAILED,
    };
  }
  return null;
}

/** The HTTP status text plus REIS' own reason (bounded, redacted: reis-error-response.ts). */
function withReisReason(error: ReisClientError): string {
  const reason = (error as { responseDetails?: { body?: string } }).responseDetails?.body;
  return reason ? `${error.message}: ${reason}` : error.message;
}

/**
 * REIS client failures. The poller sends FAILED_RETRYABLE and DELIVERY_UNCERTAIN again (attempt limit and
 * delay from .env); FAILED_PERMANENT is final for the revision.
 *  - authenticate failures never delivered an onboarding request and do not depend on the customer's data
 *    (credentials, network, REIS down): retryable;
 *  - onboarding timeout / reset / 5xx / unreadable answer: the outcome is unknown (DELIVERY_UNCERTAIN);
 *  - onboarding 401 / 403: the token was refused, not the customer: retryable;
 *  - onboarding 4xx: REIS refused the data: permanent.
 */
export function classifyReisFailure(error: ReisClientError): FailureClassification {
  const failure = (
    stage: FailureStage,
    code: string,
    persist: FailureClassification['persist'],
    requestMayHaveReachedReis: boolean,
  ): FailureClassification => ({
    stage,
    code,
    message: error.message, // built from our own text; carries no secrets or customer data
    requestMayHaveReachedReis,
    persist,
  });
  const httpStatus = (error as { httpStatus?: number }).httpStatus ?? 0;

  if (error.operation === 'authenticate') {
    const S = 'REIS_AUTHENTICATE' as const;
    switch (error.category) {
      case 'AUTHENTICATION':
        return failure(S, 'REIS_AUTH_REJECTED', KycRequestStatus.FAILED_RETRYABLE, false);
      case 'TIMEOUT':
        return failure(S, 'REIS_AUTH_TIMEOUT', KycRequestStatus.FAILED_RETRYABLE, false);
      case 'NETWORK':
        return failure(S, 'REIS_AUTH_NETWORK_ERROR', KycRequestStatus.FAILED_RETRYABLE, false);
      case 'HTTP_STATUS':
        return failure(S, 'REIS_AUTH_HTTP_ERROR', KycRequestStatus.FAILED_RETRYABLE, false);
      case 'MALFORMED_RESPONSE':
        return failure(S, 'REIS_AUTH_MALFORMED_RESPONSE', KycRequestStatus.FAILED_RETRYABLE, false);
      default:
        return failure(S, 'REIS_AUTH_FAILED', KycRequestStatus.FAILED_RETRYABLE, false);
    }
  }

  const S = 'REIS_ONBOARDING' as const;
  switch (error.category) {
    case 'AUTHENTICATION': // REIS answered 401/403: it refused the token, not the customer
      return failure(S, 'REIS_ONBOARDING_AUTH_REJECTED', KycRequestStatus.FAILED_RETRYABLE, true);
    case 'TIMEOUT':
      return failure(S, 'REIS_ONBOARDING_TIMEOUT', KycRequestStatus.DELIVERY_UNCERTAIN, true);
    case 'NETWORK': {
      const reached = (error as { requestMayHaveReachedReis?: boolean }).requestMayHaveReachedReis;
      return reached === false
        ? failure(S, 'REIS_ONBOARDING_NETWORK_ERROR', KycRequestStatus.FAILED_RETRYABLE, false)
        : failure(S, 'REIS_ONBOARDING_NETWORK_ERROR', KycRequestStatus.DELIVERY_UNCERTAIN, true);
    }
    case 'HTTP_STATUS':
      return httpStatus >= 500
        ? failure(S, 'REIS_ONBOARDING_HTTP_5XX', KycRequestStatus.DELIVERY_UNCERTAIN, true)
        : {
            ...failure(S, 'REIS_ONBOARDING_HTTP_ERROR', KycRequestStatus.FAILED_PERMANENT, true),
            message: withReisReason(error),
          };
    case 'MALFORMED_RESPONSE':
      return failure(
        S,
        'REIS_ONBOARDING_MALFORMED_RESPONSE',
        KycRequestStatus.DELIVERY_UNCERTAIN,
        true,
      );
    case 'UNSUPPORTED_STATUS':
      return failure(
        S,
        'REIS_ONBOARDING_UNSUPPORTED_STATUS',
        KycRequestStatus.DELIVERY_UNCERTAIN,
        true,
      );
    default:
      return failure(S, 'REIS_ONBOARDING_FAILED', KycRequestStatus.DELIVERY_UNCERTAIN, true);
  }
}
