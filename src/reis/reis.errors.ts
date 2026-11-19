import { ReisOnboardingStatus } from './reis-status';
import { ReisHttpErrorResponseDetails } from './reis-error-response';

export type ReisOperation = 'authenticate' | 'searchOnboardCustomer';

export type ReisErrorCategory =
  | 'AUTHENTICATION'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'HTTP_STATUS'
  | 'MALFORMED_RESPONSE'
  | 'UNSUPPORTED_STATUS'
  | 'APPLICATION_ERROR';

/**
 * Base class of every REIS client/transport failure. The clients only CLASSIFY and report;
 * they never retry. Errors are built from our own text and never carry the underlying
 * HTTP/Axios error (its config would contain credentials and the token).
 */
export abstract class ReisClientError extends Error {
  abstract readonly category: ReisErrorCategory;

  constructor(
    readonly operation: ReisOperation,
    message: string,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Startup configuration problem. Lists variable NAMES only, never values. */
export class ReisConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid REIS configuration: ${problems.join('; ')}`);
    this.name = 'ReisConfigError';
  }
}

/** REIS rejected the credentials (authenticate) or the token (onboarding): HTTP 401/403. */
export class ReisAuthenticationError extends ReisClientError {
  readonly category = 'AUTHENTICATION' as const;
  constructor(
    operation: ReisOperation,
    readonly httpStatus: number,
    correlationId?: string,
  ) {
    super(
      operation,
      `REIS rejected authentication during ${operation} (HTTP ${httpStatus})`,
      correlationId,
    );
  }
}

/** No response within the configured timeout. The outcome on the REIS side is unknown. */
export class ReisTimeoutError extends ReisClientError {
  readonly category = 'TIMEOUT' as const;
  /** True: the request may have been processed by REIS even though we got no answer. */
  readonly requestMayHaveReachedReis = true;
  constructor(
    operation: ReisOperation,
    readonly timeoutMs: number,
    correlationId?: string,
  ) {
    super(operation, `REIS ${operation} timed out after ${timeoutMs} ms`, correlationId);
  }
}

/** Connection-level failure (refused, DNS, reset, TLS validation failure, ...). */
export class ReisNetworkError extends ReisClientError {
  readonly category = 'NETWORK' as const;
  constructor(
    operation: ReisOperation,
    /** Node/Axios error code such as ECONNREFUSED; 'UNKNOWN' if absent. */
    readonly errorCode: string,
    /**
     * False when the failure happened before any request could be sent (connection refused,
     * DNS failure, TLS validation failure). True/unknown otherwise (e.g. connection reset
     * mid-request) - REIS may have processed it.
     */
    readonly requestMayHaveReachedReis: boolean,
    correlationId?: string,
  ) {
    super(operation, `REIS ${operation} network failure (${errorCode})`, correlationId);
  }
}

/** REIS answered with a non-2xx status other than 401/403. */
export class ReisHttpStatusError extends ReisClientError {
  readonly category = 'HTTP_STATUS' as const;
  constructor(
    operation: ReisOperation,
    readonly httpStatus: number,
    correlationId?: string,
    /** Safe, bounded diagnostic only; the raw response body is never attached to the error. */
    readonly responseDetails?: ReisHttpErrorResponseDetails,
  ) {
    super(operation, `REIS ${operation} returned HTTP ${httpStatus}`, correlationId);
  }
}

/** 2xx response whose body is not valid JSON or does not have the expected shape. */
export class ReisMalformedResponseError extends ReisClientError {
  readonly category = 'MALFORMED_RESPONSE' as const;
  constructor(
    operation: ReisOperation,
    readonly reason: string,
    correlationId?: string,
  ) {
    super(operation, `Malformed REIS ${operation} response: ${reason}`, correlationId);
  }
}

/** Onboarding `status` is not one of CLEAN / PENDING / REJECT. Never coerced. */
export class ReisUnsupportedStatusError extends ReisClientError {
  readonly category = 'UNSUPPORTED_STATUS' as const;
  readonly receivedStatus: string;
  constructor(operation: ReisOperation, receivedStatus: string, correlationId?: string) {
    super(operation, `REIS ${operation} returned an unsupported status`, correlationId);
    this.receivedStatus = receivedStatus.slice(0, 50);
  }
}

/** Details REIS returned alongside an errorMessage (only documented fields). */
export interface ReisOnboardingErrorDetails {
  /** Present only if it was a recognized status. */
  status?: ReisOnboardingStatus;
  riskCalculationId?: string | number | null;
  reisId?: string | number | null;
  instruction?: string | null;
  errorMessage: string;
}

/**
 * RESERVED for a future, confirmed REIS application-error contract. Nothing raises it today:
 * a response with a valid status (including REJECT) and an `errorMessage` is a normal result.
 * The text lives in `details.errorMessage`, deliberately NOT in Error.message.
 */
export class ReisApplicationError extends ReisClientError {
  readonly category = 'APPLICATION_ERROR' as const;
  constructor(
    operation: ReisOperation,
    readonly details: ReisOnboardingErrorDetails,
    correlationId?: string,
  ) {
    super(operation, `REIS ${operation} reported an application error`, correlationId);
  }
}
