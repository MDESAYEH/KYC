/**
 * Outcome of one /customerStatus callback. PROCESSING is transient (the event row is written
 * before the callback is applied, so an interrupted run stays visible).
 */
export type WebhookProcessingResult =
  | 'PROCESSING'
  | 'APPLIED'
  | 'DUPLICATE'
  | 'CONFLICT'
  | 'UNKNOWN_CASE'
  | 'INCONSISTENT_STATE'
  | 'RECONCILIATION_REQUIRED'
  | 'CUSTOMER_ID_MISMATCH'
  | 'INVALID'
  | 'SECURITY_REJECTED'
  | 'UPDATE_FAILED';

/**
 * Audit record of a callback. Deliberately NOT the payload: only safe technical fields. No
 * tokens, credentials, names or other personal data. `eventId` is generated here because the
 * current REIS sample carries none.
 */
export interface WebhookEvent {
  eventId: string;
  receivedAt: Date;
  /** Echoed REIS systemId (= KYC_REF_NO), truncated; null if absent/unusable or unauthorized. */
  systemId: string | null;
  /** Echoed status text, truncated; null if absent or unauthorized. */
  incomingStatus: string | null;
  /** Echoed REIS customerId (an identifier, not FLEXCUBE CUSTOMER_NO). */
  incomingCustomerId: number | null;
  systemName: string | null;
  serviceType: string | null;
  processingResult: WebhookProcessingResult;
  /** Short machine code explaining the result (e.g. INVALID_PAYLOAD). Never free text. */
  detailCode: string | null;
  kycCaseInternalId: string | null;
  processedAt: Date | null;
}

export interface NewWebhookEvent {
  receivedAt: Date;
  systemId?: string | null;
  incomingStatus?: string | null;
  incomingCustomerId?: number | null;
  systemName?: string | null;
  serviceType?: string | null;
  /** Defaults to PROCESSING. */
  processingResult?: WebhookProcessingResult;
  detailCode?: string | null;
  kycCaseInternalId?: string | null;
}

export interface WebhookEventCompletion {
  processingResult: Exclude<WebhookProcessingResult, 'PROCESSING'>;
  detailCode?: string | null;
  kycCaseInternalId?: string | null;
}

export interface IWebhookEventRepository {
  /** Inserts an audit row (default result PROCESSING) and returns it with its generated eventId. */
  start(input: NewWebhookEvent): Promise<WebhookEvent>;
  /** Sets the final processing result and processedAt. */
  complete(eventId: string, completion: WebhookEventCompletion): Promise<WebhookEvent>;
  findByEventId(eventId: string): Promise<WebhookEvent | null>;
  listBySystemId(systemId: string): Promise<WebhookEvent[]>;
  listByKycCaseInternalId(kycCaseInternalId: string): Promise<WebhookEvent[]>;
  /** Events with one of the given results received at/after `since`, newest first, capped. */
  listByResults(
    results: WebhookProcessingResult[],
    since: Date,
    limit: number,
  ): Promise<WebhookEvent[]>;
}
export const WEBHOOK_EVENT_REPOSITORY = Symbol('IWebhookEventRepository');
