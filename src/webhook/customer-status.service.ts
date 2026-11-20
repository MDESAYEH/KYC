import { Inject, Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FlexcubeUpdateStatus } from '../common/kyc-status';
import { FLEXCUBE_STATUS_UPDATER, IFlexcubeStatusUpdater } from '../flexcube/flexcube.interfaces';
import { KycCase } from '../persistence/kyc-case';
import { IKycCaseRepository, KYC_CASE_REPOSITORY } from '../persistence/persistence.interfaces';
import {
  IWebhookEventRepository,
  WEBHOOK_EVENT_REPOSITORY,
  WebhookEvent,
  WebhookProcessingResult,
} from '../persistence/webhook-event';
import { CustomerStatusDto } from './dto/customer-status.dto';
import { IWebhookSecurityStrategy, WEBHOOK_SECURITY_STRATEGY } from './webhook.interfaces';

export type CustomerStatusResult = Exclude<WebhookProcessingResult, 'PROCESSING'>;

/** Typed internal outcome; the controller maps it to HTTP. Carries no customer data. */
export interface CustomerStatusOutcome {
  result: CustomerStatusResult;
  /** Internal audit event id. */
  eventId: string;
}

export interface CustomerStatusRequest {
  headers: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
  body: unknown;
}

const toInt = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
};

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Processes a REIS /customerStatus callback:
 *
 *   security strategy -> validate -> correlate by systemId (= KYC_REF_NO) -> idempotent final
 *   status -> IFlexcubeStatusUpdater (mock until the FLEXCUBE mechanism is known)
 *
 * - The REIS final decision is persisted FIRST and is never lost: a FLEXCUBE update failure only
 *   changes `flexcubeUpdateStatus` (no automatic retry exists).
 * - Only the first valid callback (outcome APPLIED) triggers the FLEXCUBE update, so duplicates and
 *   concurrent identical callbacks cause exactly one business effect.
 * - Every callback leaves an audit row with safe technical fields only (never the payload).
 * - Logs carry event id, outcome and internal ids: never payloads, REIS free text or secrets.
 */
@Injectable()
export class CustomerStatusService {
  private readonly logger = new Logger(CustomerStatusService.name);

  constructor(
    @Inject(WEBHOOK_SECURITY_STRATEGY) private readonly security: IWebhookSecurityStrategy,
    @Inject(KYC_CASE_REPOSITORY) private readonly cases: IKycCaseRepository,
    @Inject(WEBHOOK_EVENT_REPOSITORY) private readonly events: IWebhookEventRepository,
    @Inject(FLEXCUBE_STATUS_UPDATER) private readonly updater: IFlexcubeStatusUpdater,
  ) {}

  async handle(request: CustomerStatusRequest): Promise<CustomerStatusOutcome> {
    const receivedAt = new Date();

    // 1. Security first: nothing of an unauthorized body is read, parsed or stored.
    if (!(await this.authorized(request))) return this.auditSecurityRejection(receivedAt);

    // 2. Validate the callback.
    const body = request.body;
    const isObject = typeof body === 'object' && body !== null && !Array.isArray(body);
    const received = isObject ? (body as Record<string, unknown>) : {};
    // V1.5 names the field "Status" in its attribute table but the sample uses "status": accept
    // both. Both present with different values is malformed.
    const statusConflict =
      received.status !== undefined &&
      received.Status !== undefined &&
      received.status !== received.Status;
    const withStatus =
      received.status === undefined && received.Status !== undefined
        ? { ...received, status: received.Status }
        : received;
    // systemId under another spelling (systemID, SystemId, system_id) or as a number (a CIF without its
    // leading zeros): taken as text; correlation then also tries the CIF without leading zeros.
    const idKey = Object.keys(withStatus).find((k) => /^system_?id$/i.test(k));
    const idValue = idKey === undefined ? undefined : withStatus[idKey];
    let raw: Record<string, unknown> =
      typeof idValue === 'number' && Number.isInteger(idValue)
        ? { ...withStatus, systemId: String(idValue) }
        : idKey !== undefined && idKey !== 'systemId'
          ? { ...withStatus, systemId: idValue }
          : withStatus;
    // REIS UAT sends no systemId (20/11/2026): { _hash, status, customerId, systemName, ServiceType,
    // businessKey }. The case is then found by the REIS customer id we stored from the onboarding answer.
    if (raw.systemId === undefined && isObject) {
      const reisCustomerId = toInt(raw.customerId) ?? toInt(raw.businessKey);
      const known =
        reisCustomerId === null ? null : await this.cases.findByReisCustomerId(reisCustomerId);
      if (known?.reisSystemId) {
        raw = { ...raw, systemId: known.reisSystemId, customerId: reisCustomerId };
      }
    }
    const errors =
      isObject && !statusConflict
        ? await validate(plainToInstance(CustomerStatusDto, raw), { forbidUnknownValues: true })
        : [{ property: statusConflict ? 'status' : 'body' }];

    const safeCustomerId =
      typeof raw.customerId === 'number' && Number.isInteger(raw.customerId)
        ? raw.customerId
        : null;
    const echo = {
      receivedAt,
      systemId: asString(raw.systemId),
      incomingStatus: asString(raw.status),
      incomingCustomerId: safeCustomerId,
      systemName: asString(raw.systemName),
      serviceType: asString(raw.ServiceType),
    };

    if (errors.length > 0) {
      // Which fields failed (names only, never values), e.g. INVALID_PAYLOAD:ServiceType,customerId
      const detailCode = `INVALID_PAYLOAD:${errors.map((e) => e.property).join(',')}`.slice(0, 100);
      const event = await this.events.start({ ...echo, detailCode });
      const done = await this.events.complete(event.eventId, {
        processingResult: 'INVALID',
        detailCode,
      });
      this.logger.warn({
        event: 'customerStatus.invalid',
        eventId: done.eventId,
        fields: errors.map((e) => e.property),
        received: Object.keys(received),
      });
      return this.finish(done, 'INVALID');
    }

    // 3. Audit before acting, so an interrupted run stays visible as PROCESSING.
    const event = await this.events.start(echo);

    // 4. Correlate by systemId and apply the final status idempotently.
    const dto = plainToInstance(CustomerStatusDto, raw);
    const applied = await this.cases.applyFinalStatus(dto.systemId, dto.status, dto.customerId);
    const kycCase = applied.kycCase;
    const caseId = kycCase?.internalId ?? null;

    switch (applied.outcome) {
      case 'APPLIED':
        return this.afterApplied(event, kycCase as KycCase, dto);
      case 'DUPLICATE':
      case 'CONFLICT':
      case 'UNKNOWN_CASE':
      case 'INCONSISTENT_STATE':
      case 'RECONCILIATION_REQUIRED': // DELIVERY_UNCERTAIN case: audited, nothing applied, no FLEXCUBE call
      case 'CUSTOMER_ID_MISMATCH': {
        const done = await this.events.complete(event.eventId, {
          processingResult: applied.outcome,
          kycCaseInternalId: caseId,
          detailCode: applied.outcome,
        });
        return this.finish(done, applied.outcome, caseId);
      }
    }
  }

  /**
   * A /customerStatus request the HTTP layer rejected before it reached the handler (e.g.
   * syntactically invalid JSON). Safe metadata only: the raw body is never available here and is
   * never stored. The security strategy still runs first (it only needs headers / address), so an
   * unauthorized caller is recorded as SECURITY_REJECTED rather than INVALID.
   */
  async auditMalformedRequest(
    request: Omit<CustomerStatusRequest, 'body'>,
    detailCode: string,
  ): Promise<CustomerStatusOutcome> {
    const receivedAt = new Date();
    if (!(await this.authorized({ ...request, body: undefined }))) {
      return this.auditSecurityRejection(receivedAt);
    }
    const event = await this.events.start({ receivedAt, detailCode });
    const done = await this.events.complete(event.eventId, {
      processingResult: 'INVALID',
      detailCode,
    });
    return this.finish(done, 'INVALID');
  }

  // ---- helpers ---------------------------------------------------------------------------

  private async auditSecurityRejection(receivedAt: Date): Promise<CustomerStatusOutcome> {
    const event = await this.events.start({
      receivedAt,
      processingResult: 'SECURITY_REJECTED',
      detailCode: 'SECURITY_REJECTED',
    });
    const done = await this.events.complete(event.eventId, {
      processingResult: 'SECURITY_REJECTED',
      detailCode: 'SECURITY_REJECTED',
    });
    return this.finish(done, 'SECURITY_REJECTED');
  }

  private async authorized(request: CustomerStatusRequest): Promise<boolean> {
    try {
      return (
        (await this.security.authorize({
          headers: request.headers,
          remoteAddress: request.remoteAddress,
        })) === true
      );
    } catch {
      return false; // a failing strategy never lets a call through
    }
  }

  /** First valid callback: tell FLEXCUBE exactly once; the REIS decision is already stored. */
  private async afterApplied(
    event: WebhookEvent,
    kycCase: KycCase,
    dto: CustomerStatusDto,
  ): Promise<CustomerStatusOutcome> {
    try {
      await this.updater.updateStatus({
        kycRefNo: kycCase.kycRefNo,
        customerNo: kycCase.customerNo,
        finalStatus: dto.status,
        seqNo: kycCase.seqNo,
        reisCustomerId: kycCase.reisCustomerId ?? undefined,
        idempotencyKey: `${kycCase.internalId}:${dto.status}`,
      });
    } catch (error) {
      // The REIS final status stays persisted. Only the separate FLEXCUBE update state changes.
      await this.cases.recordFlexcubeUpdateResult(kycCase.internalId, {
        status: FlexcubeUpdateStatus.FAILED,
        errorCode: 'FLEXCUBE_UPDATE_FAILED',
        errorMessage: `FLEXCUBE status update failed (${error instanceof Error ? error.name : 'Error'})`,
      });
      const done = await this.events.complete(event.eventId, {
        processingResult: 'UPDATE_FAILED',
        kycCaseInternalId: kycCase.internalId,
        detailCode: 'FLEXCUBE_UPDATE_FAILED',
      });
      return this.finish(done, 'UPDATE_FAILED', kycCase.internalId);
    }
    await this.cases.recordFlexcubeUpdateResult(kycCase.internalId, {
      status: FlexcubeUpdateStatus.APPLIED,
    });
    const done = await this.events.complete(event.eventId, {
      processingResult: 'APPLIED',
      kycCaseInternalId: kycCase.internalId,
    });
    return this.finish(done, 'APPLIED', kycCase.internalId);
  }

  private finish(
    event: WebhookEvent,
    result: CustomerStatusResult,
    internalId?: string | null,
  ): CustomerStatusOutcome {
    const log = { event: 'customerStatus.processed', eventId: event.eventId, result, internalId };
    if (result === 'APPLIED' || result === 'DUPLICATE') this.logger.log(log);
    else this.logger.warn(log);
    return { result, eventId: event.eventId };
  }
}
