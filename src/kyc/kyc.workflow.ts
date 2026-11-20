import { Logger } from '@nestjs/common';
import { CanonicalKycCustomer, CustomerType } from '../canonical';
import { ReisOnboardingRequest } from '../reis/dto';
import { FlexcubeUpdateStatus, KycRequestStatus } from '../common/kyc-status';
import { FlexcubeCustomerRequest } from '../flexcube/dto/flexcube-customer.request';
import {
  IFlexcubeStatusUpdater,
  IFlexcubeToCanonicalMapper,
} from '../flexcube/flexcube.interfaces';
import { KycCase } from '../persistence/kyc-case';
import { DuplicateKycCaseError } from '../persistence/persistence.errors';
import { InvalidFieldValueError } from '../canonical/transformation.errors';
import { IKycCaseRepository, RETRYABLE_STATUSES } from '../persistence/persistence.interfaces';
import { CifIdentityError, requireCif } from '../reis/cif-identity';
import { ReisClientError } from '../reis/reis.errors';
import { ICanonicalToReisTransformer, IReisOnboardingClient } from '../reis/reis.interfaces';
import {
  classifyPreReisFailure,
  classifyReisFailure,
  FailureClassification,
} from './kyc-failure.classifier';
import {
  DuplicateReason,
  KycSubmissionResult,
  SubmissionDuplicate,
  SubmissionFailed,
} from './kyc-submission.result';
import { IKycWorkflow, SubmitOptions } from './kyc.interfaces';

/** Why an existing case of the same revision is not sent again (retryable statuses are reopened instead). */
const DUPLICATE_REASON: Partial<Record<KycRequestStatus, DuplicateReason>> = {
  [KycRequestStatus.REIS_CLEAN]: 'ALREADY_CLEAN',
  [KycRequestStatus.REIS_PENDING]: 'AWAITING_FINAL_STATUS',
  [KycRequestStatus.REIS_REJECTED]: 'ALREADY_REJECTED',
  [KycRequestStatus.FINALIZED]: 'ALREADY_FINALIZED',
  [KycRequestStatus.FAILED_PERMANENT]: 'PREVIOUS_ATTEMPT_FAILED',
};

/**
 * One submission of a FLEXCUBE customer to REIS:
 *
 *   FLEXCUBE request -> mapper -> transformer (systemId = CIF) -> case -> REIS onboard -> case result
 *   -> REIS_FINAL_STATUS at once for CLEAN / REJECT (PENDING is finished by the REIS callback)
 *
 * Identity: REIS systemId = the FLEXCUBE CIF (CUSTOMER_NO); KYC_REF_NO + SEQ_NO stay the internal key.
 * - The same revision is sent again only while REIS has not answered it (RETRYABLE_STATUSES); the poller decides
 *   when (attempt limit and delay).
 * - A higher SEQ_NO (CIF modified) replaces a closed previous revision.
 * - Validation / mapping errors happen before REIS is called.
 * - Logs carry the KYC reference, codes and statuses; never names, payloads or REIS free text.
 */
export class KycWorkflow implements IKycWorkflow {
  private readonly logger = new Logger(KycWorkflow.name);

  constructor(
    private readonly mapper: IFlexcubeToCanonicalMapper,
    private readonly transformer: ICanonicalToReisTransformer,
    private readonly cases: IKycCaseRepository,
    private readonly reis: IReisOnboardingClient,
    private readonly flexcube: IFlexcubeStatusUpdater,
  ) {}

  async submit(
    request: FlexcubeCustomerRequest,
    options: SubmitOptions,
  ): Promise<KycSubmissionResult> {
    const { seqNo } = options;
    if (!Number.isInteger(seqNo) || seqNo < 1) {
      throw new Error('Internal error: seqNo must be a positive integer');
    }
    const kycRefNo = request?.KYC_REF_NO;
    if (typeof kycRefNo !== 'string' || kycRefNo.trim() === '') {
      return this.failure(
        {
          stage: 'VALIDATION',
          code: 'MISSING_REQUIRED_FIELD',
          message: 'Required field "KYC_REF_NO" is missing or blank',
          requestMayHaveReachedReis: false,
          persist: KycRequestStatus.VALIDATION_FAILED,
        },
        null,
      );
    }

    // 1. Idempotency: a revision REIS already answered is never sent again. A newer SEQ_NO (amendment) is
    //    allowed once the previous revision is closed.
    const existing = await this.cases.findByKycRefNo(kycRefNo);
    const amendment = existing !== null && seqNo > existing.seqNo;
    const reopenable = options.afterRejection
      ? [...RETRYABLE_STATUSES, KycRequestStatus.FAILED_PERMANENT]
      : RETRYABLE_STATUSES;
    if (existing && !amendment && !reopenable.includes(existing.internalRequestStatus)) {
      return this.duplicate(existing);
    }

    // 2. Validate, normalize and transform. Any failure here means REIS is never called.
    let canonicalType: CustomerType;
    let reisRequest;
    let customerNo: string | null;
    try {
      const canonical = this.mapper.map(request);
      canonicalType = canonical.customerType;
      customerNo = canonical.customerNo;
      reisRequest = await this.toReisRequest(canonical);
    } catch (error) {
      const classification = classifyPreReisFailure(error);
      if (!classification) throw error; // unexpected: do not hide bugs
      if (amendment) {
        // A rejected amendment never touches the previous (closed) submission's case.
        return { ...(await this.failure(classification, null)), kycCase: existing };
      }
      return this.failBeforeReis(request, kycRefNo, existing, classification);
    }
    const reisSystemId = this.identityOf(request);
    if (reisSystemId === null || reisRequest.systemId !== reisSystemId) {
      throw new Error('Internal error: REIS systemId does not match the submission identity');
    }

    // 3. Create (or reopen) the case.
    let kycCase: KycCase;
    if (existing && amendment) {
      const reopened = await this.cases.reopenForAmendment(
        existing.internalId,
        seqNo,
        canonicalType,
      );
      if (!reopened) return this.duplicate((await this.cases.findByKycRefNo(kycRefNo)) ?? existing);
      kycCase = reopened;
    } else if (existing) {
      const reopened = await this.cases.reopenForRetry(
        existing.internalId,
        canonicalType,
        reopenable,
      );
      if (!reopened) return this.duplicate((await this.cases.findByKycRefNo(kycRefNo)) ?? existing);
      kycCase = reopened;
    } else {
      try {
        kycCase = await this.cases.create({
          kycRefNo,
          customerType: canonicalType,
          customerNo,
          seqNo,
          reisSystemId,
        });
      } catch (error) {
        if (error instanceof DuplicateKycCaseError) {
          const winner = await this.cases.findByKycRefNo(kycRefNo);
          if (winner) return this.duplicate(winner);
        }
        throw error;
      }
    }
    if (customerNo && !kycCase.customerNo) {
      kycCase = await this.cases.attachCustomerNo(kycCase.internalId, customerNo);
    }

    // 4. Call REIS once. The client authenticates afresh; retries are the poller's decision.
    await this.cases.updateInternalStatus(kycCase.internalId, KycRequestStatus.SUBMITTED_TO_REIS);
    let response;
    try {
      response = await this.reis.onboard(reisRequest, { correlationId: kycCase.internalId });
    } catch (error) {
      if (error instanceof ReisClientError) {
        return { ...(await this.failure(classifyReisFailure(error), kycCase)), reisRequest };
      }
      // Unknown error after the request may have been sent: record uncertainty, then surface it.
      await this.cases.recordDeliveryUncertain(kycCase.internalId, {
        code: 'UNEXPECTED_ERROR',
        message: 'Unexpected error while calling REIS',
      });
      throw error;
    }

    // 5. Persist the onboarding result (CLEAN / PENDING / REJECT stay distinct).
    const updated = await this.cases.recordOnboardingResult(kycCase.internalId, {
      reisOnboardingStatus: response.status,
      riskCalculationId:
        response.riskCalculationId == null ? null : String(response.riskCalculationId),
      reisId: response.reisId == null ? null : String(response.reisId),
      // REIS response text is persisted on purpose, but is never logged (see the log call below).
      instruction: response.instruction,
      errorMessage: response.errorMessage,
    });
    // CLEAN / REJECT are final at once (no webhook follows): tell FLEXCUBE now.
    const final = await this.notifyFlexcubeIfFinal(updated);
    this.logger.log({
      event: 'kyc.submission.onboarded',
      kycRefNo: updated.kycRefNo,
      seqNo: updated.seqNo,
      internalId: updated.internalId,
      reisOnboardingStatus: response.status,
      internalRequestStatus: updated.internalRequestStatus,
    });
    return {
      outcome: 'ONBOARDED',
      reisOnboardingStatus: response.status,
      instruction: response.instruction,
      errorMessage: response.errorMessage,
      kycCase: final,
      reisRequest,
      reisResponse: response,
    };
  }

  /**
   * After an immediate final decision (CLEAN -> CUSTOMER, REJECT -> BLOCKED) the FLEXCUBE update is attempted
   * once. A failure never loses the REIS decision: it is recorded as FAILED on the case.
   */
  private async notifyFlexcubeIfFinal(kycCase: KycCase): Promise<KycCase> {
    if (
      kycCase.finalStatus === null ||
      kycCase.flexcubeUpdateStatus !== FlexcubeUpdateStatus.PENDING
    ) {
      return kycCase;
    }
    try {
      await this.flexcube.updateStatus({
        kycRefNo: kycCase.kycRefNo,
        customerNo: kycCase.customerNo,
        finalStatus: kycCase.finalStatus,
        seqNo: kycCase.seqNo,
        reisCustomerId: kycCase.reisCustomerId ?? undefined,
        idempotencyKey: `${kycCase.internalId}:${kycCase.finalStatus}`,
      });
    } catch (error) {
      return this.cases.recordFlexcubeUpdateResult(kycCase.internalId, {
        status: FlexcubeUpdateStatus.FAILED,
        errorCode: 'FLEXCUBE_UPDATE_FAILED',
        errorMessage: `FLEXCUBE status update failed (${error instanceof Error ? error.name : 'Error'})`,
      });
    }
    return this.cases.recordFlexcubeUpdateResult(kycCase.internalId, {
      status: FlexcubeUpdateStatus.APPLIED,
    });
  }

  async preview(request: FlexcubeCustomerRequest): Promise<object> {
    return this.toReisRequest(this.mapper.map(request));
  }

  // ---- identity: REIS systemId = CIF -------------------------------------------------------

  /** The field mapping with systemId = CIF; a related party may not carry the same systemId. */
  private async toReisRequest(canonical: CanonicalKycCustomer): Promise<ReisOnboardingRequest> {
    const systemId = requireCif(canonical.customerNo);
    const request = await this.transformer.transform(canonical);
    if (request.relations.some((relation) => relation.systemId === systemId)) {
      throw new InvalidFieldValueError('relation.systemId', 'collides with the primary CIF');
    }
    return { ...request, systemId };
  }

  /** The CIF of the request, or null when it has none. */
  private identityOf(request: FlexcubeCustomerRequest): string | null {
    try {
      return requireCif(request?.CUSTOMER_NO);
    } catch (error) {
      if (error instanceof CifIdentityError) return null;
      throw error;
    }
  }

  // ---- helpers ---------------------------------------------------------------------------

  private duplicate(kycCase: KycCase): SubmissionDuplicate {
    const reason = DUPLICATE_REASON[kycCase.internalRequestStatus] ?? 'IN_PROGRESS';
    this.logger.warn({
      event: 'kyc.submission.duplicate',
      kycRefNo: kycCase.kycRefNo,
      seqNo: kycCase.seqNo,
      internalId: kycCase.internalId,
      reason,
      internalRequestStatus: kycCase.internalRequestStatus,
    });
    return { outcome: 'DUPLICATE', reason, kycCase };
  }

  /** Persists a failure raised before REIS was contacted. */
  private async failBeforeReis(
    request: FlexcubeCustomerRequest,
    kycRefNo: string,
    existing: KycCase | null,
    classification: FailureClassification,
  ): Promise<KycSubmissionResult> {
    let kycCase: KycCase | null = existing;
    if (!kycCase) {
      const customerType = this.customerTypeOf(request);
      const reisSystemId = this.identityOf(request);
      if (customerType && reisSystemId !== null) {
        try {
          kycCase = await this.cases.create({ kycRefNo, customerType, reisSystemId });
        } catch (error) {
          if (error instanceof DuplicateKycCaseError) {
            const winner = await this.cases.findByKycRefNo(kycRefNo);
            if (winner) return this.duplicate(winner);
          }
          throw error;
        }
      }
    }
    return this.failure(classification, kycCase);
  }

  private customerTypeOf(request: FlexcubeCustomerRequest): CustomerType | null {
    if (request.CUSTOMER_TYPE === 'INDIVIDUAL') return CustomerType.INDIVIDUAL;
    if (request.CUSTOMER_TYPE === 'CORPORATE') return CustomerType.CORPORATE;
    return null;
  }

  private async failure(
    c: FailureClassification,
    kycCase: KycCase | null,
  ): Promise<SubmissionFailed> {
    let saved = kycCase;
    if (kycCase) {
      const error = { code: c.code, message: c.message };
      switch (c.persist) {
        case KycRequestStatus.VALIDATION_FAILED:
          saved = await this.cases.recordValidationFailure(kycCase.internalId, error);
          break;
        case KycRequestStatus.FAILED_RETRYABLE:
          saved = await this.cases.recordRetryableError(kycCase.internalId, error);
          break;
        case KycRequestStatus.FAILED_PERMANENT:
          saved = await this.cases.recordPermanentError(kycCase.internalId, error);
          break;
        case KycRequestStatus.DELIVERY_UNCERTAIN:
          saved = await this.cases.recordDeliveryUncertain(kycCase.internalId, error);
          break;
      }
    }
    this.logger.warn({
      event: 'kyc.submission.failed',
      kycRefNo: saved?.kycRefNo,
      seqNo: saved?.seqNo,
      internalId: saved?.internalId,
      stage: c.stage,
      code: c.code,
      detail: c.message,
      persistedStatus: c.persist,
      requestMayHaveReachedReis: c.requestMayHaveReachedReis,
    });
    return {
      outcome: 'FAILED',
      stage: c.stage,
      code: c.code,
      message: c.message,
      requestMayHaveReachedReis: c.requestMayHaveReachedReis,
      persistedStatus: c.persist,
      kycCase: saved,
    };
  }
}
