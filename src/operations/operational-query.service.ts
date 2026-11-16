import { Inject, Injectable } from '@nestjs/common';
import { CustomerType } from '../canonical';
import { FlexcubeUpdateStatus, KycRequestStatus } from '../common/kyc-status';
import { KycCase } from '../persistence/kyc-case';
import { IKycCaseRepository, KYC_CASE_REPOSITORY } from '../persistence/persistence.interfaces';
import {
  IWebhookEventRepository,
  WEBHOOK_EVENT_REPOSITORY,
  WebhookEvent,
  WebhookProcessingResult,
} from '../persistence/webhook-event';
import { ReisFinalStatus, ReisOnboardingStatus } from '../reis/reis-status';

const DEFAULT_LIMIT = 100;

/**
 * Safe, monitoring-oriented view of a case. Deliberately EXCLUDES: customer names/data, CUSTOMER_NO,
 * REIS `instruction` / `errorMessage` (sensitive), free-text error messages, and any payload.
 */
export interface OperationalCaseSummary {
  internalId: string;
  kycRefNo: string;
  reisSystemId: string;
  customerType: CustomerType;
  internalRequestStatus: KycRequestStatus;
  reisOnboardingStatus: ReisOnboardingStatus | null;
  riskCalculationId: string | null;
  reisId: string | null;
  finalStatus: ReisFinalStatus | null;
  finalStatusAt: Date | null;
  conflictingFinalStatus: ReisFinalStatus | null;
  flexcubeUpdateStatus: FlexcubeUpdateStatus;
  flexcubeUpdateErrorCode: string | null;
  flexcubeUpdateAttemptCount: number;
  flexcubeLastAttemptAt: Date | null;
  flexcubeUpdatedAt: Date | null;
  lastErrorCode: string | null;
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliveryUncertainCaseSummary extends OperationalCaseSummary {
  /**
   * Final-status callbacks that arrived for this case and were audited as RECONCILIATION_REQUIRED.
   * Whether they may reconcile the case is a Bank/REIS decision that is still TBD.
   */
  reconciliationCallbackCount: number;
  lastReconciliationCallbackAt: Date | null;
  /** Incoming status of the latest such callback (CUSTOMER / BLOCKED), as audited. */
  lastReconciliationIncomingStatus: string | null;
}

export interface QueryOptions {
  /** Default 100; the repository caps it at 500. */
  limit?: number;
}

export function toOperationalSummary(c: KycCase): OperationalCaseSummary {
  return {
    internalId: c.internalId,
    kycRefNo: c.kycRefNo,
    reisSystemId: c.reisSystemId,
    customerType: c.customerType,
    internalRequestStatus: c.internalRequestStatus,
    reisOnboardingStatus: c.reisOnboardingStatus,
    riskCalculationId: c.riskCalculationId,
    reisId: c.reisId,
    finalStatus: c.finalStatus,
    finalStatusAt: c.finalStatusAt,
    conflictingFinalStatus: c.conflictingFinalStatus,
    flexcubeUpdateStatus: c.flexcubeUpdateStatus,
    flexcubeUpdateErrorCode: c.flexcubeUpdateErrorCode,
    flexcubeUpdateAttemptCount: c.flexcubeUpdateAttemptCount,
    flexcubeLastAttemptAt: c.flexcubeLastAttemptAt,
    flexcubeUpdatedAt: c.flexcubeUpdatedAt,
    lastErrorCode: c.lastErrorCode,
    retryCount: c.retryCount,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** Callback results that signal a problem worth an operator's attention. */
const CONFLICT_RESULTS: WebhookProcessingResult[] = [
  'CONFLICT',
  'CUSTOMER_ID_MISMATCH',
  'INCONSISTENT_STATE',
  'RECONCILIATION_REQUIRED',
];

/**
 * Application-level operational queries for monitoring and runbooks. No HTTP endpoint exists yet
 * (no public admin API). Returns safe summaries only, never full KYC payloads or REIS free text.
 */
export interface IOperationalQueryService {
  /** Cases still REIS_PENDING that were last updated before `olderThan` (final callback overdue). */
  findStuckPendingCases(olderThan: Date, options?: QueryOptions): Promise<OperationalCaseSummary[]>;
  findDeliveryUncertainCases(options?: QueryOptions): Promise<DeliveryUncertainCaseSummary[]>;
  findFailedFlexcubeUpdates(options?: QueryOptions): Promise<OperationalCaseSummary[]>;
  /** Callback audit events (CONFLICT, CUSTOMER_ID_MISMATCH, INCONSISTENT_STATE, RECONCILIATION_REQUIRED) since `since`. */
  findRecentCallbackConflicts(since: Date, options?: QueryOptions): Promise<WebhookEvent[]>;
  findRecentUnknownCaseCallbacks(since: Date, options?: QueryOptions): Promise<WebhookEvent[]>;
}
export const OPERATIONAL_QUERY_SERVICE = Symbol('IOperationalQueryService');

@Injectable()
export class OperationalQueryService implements IOperationalQueryService {
  constructor(
    @Inject(KYC_CASE_REPOSITORY) private readonly cases: IKycCaseRepository,
    @Inject(WEBHOOK_EVENT_REPOSITORY) private readonly events: IWebhookEventRepository,
  ) {}

  async findStuckPendingCases(
    olderThan: Date,
    options: QueryOptions = {},
  ): Promise<OperationalCaseSummary[]> {
    const rows = await this.cases.findCases({
      internalRequestStatus: KycRequestStatus.REIS_PENDING,
      updatedBefore: olderThan,
      limit: options.limit ?? DEFAULT_LIMIT,
    });
    return rows.map(toOperationalSummary);
  }

  async findDeliveryUncertainCases(
    options: QueryOptions = {},
  ): Promise<DeliveryUncertainCaseSummary[]> {
    const rows = await this.cases.findCases({
      internalRequestStatus: KycRequestStatus.DELIVERY_UNCERTAIN,
      limit: options.limit ?? DEFAULT_LIMIT,
    });
    return Promise.all(
      rows.map(async (c) => {
        const callbacks = (await this.events.listByKycCaseInternalId(c.internalId)).filter(
          (e) => e.processingResult === 'RECONCILIATION_REQUIRED',
        );
        const last = callbacks[callbacks.length - 1];
        return {
          ...toOperationalSummary(c),
          reconciliationCallbackCount: callbacks.length,
          lastReconciliationCallbackAt: last?.receivedAt ?? null,
          lastReconciliationIncomingStatus: last?.incomingStatus ?? null,
        };
      }),
    );
  }

  async findFailedFlexcubeUpdates(options: QueryOptions = {}): Promise<OperationalCaseSummary[]> {
    const rows = await this.cases.findCases({
      flexcubeUpdateStatus: FlexcubeUpdateStatus.FAILED,
      limit: options.limit ?? DEFAULT_LIMIT,
    });
    return rows.map(toOperationalSummary);
  }

  findRecentCallbackConflicts(since: Date, options: QueryOptions = {}): Promise<WebhookEvent[]> {
    return this.events.listByResults(CONFLICT_RESULTS, since, options.limit ?? DEFAULT_LIMIT);
  }

  findRecentUnknownCaseCallbacks(since: Date, options: QueryOptions = {}): Promise<WebhookEvent[]> {
    return this.events.listByResults(['UNKNOWN_CASE'], since, options.limit ?? DEFAULT_LIMIT);
  }
}
