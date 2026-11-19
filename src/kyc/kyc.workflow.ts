import { Inject, Injectable, Logger } from '@nestjs/common';
import { CanonicalKycCustomer, CustomerType } from '../canonical';
import { ReisOnboardingRequest } from '../reis/dto';
import { FlexcubeUpdateStatus, KycRequestStatus } from '../common/kyc-status';
import { FlexcubeCustomerRequest } from '../flexcube/dto/flexcube-customer.request';
import {
  FLEXCUBE_STATUS_UPDATER,
  FLEXCUBE_TO_CANONICAL_MAPPER,
  IFlexcubeStatusUpdater,
  IFlexcubeToCanonicalMapper,
} from '../flexcube/flexcube.interfaces';
import { KycCase } from '../persistence/kyc-case';
import { DuplicateKycCaseError } from '../persistence/persistence.errors';
import { IKycCaseRepository, KYC_CASE_REPOSITORY } from '../persistence/persistence.interfaces';
import { ReisClientError } from '../reis/reis.errors';
import {
  CANONICAL_TO_REIS_TRANSFORMER,
  ICanonicalToReisTransformer,
  IReisOnboardingClient,
  REIS_ONBOARDING_CLIENT,
} from '../reis/reis.interfaces';
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

const DUPLICATE_REASON: Record<KycRequestStatus, DuplicateReason | undefined> = {
  [KycRequestStatus.RECEIVED]: 'IN_PROGRESS_OR_UNCERTAIN',
  [KycRequestStatus.SUBMITTED_TO_REIS]: 'IN_PROGRESS_OR_UNCERTAIN',
  [KycRequestStatus.REIS_CLEAN]: 'ALREADY_CLEAN',
  [KycRequestStatus.REIS_PENDING]: 'AWAITING_FINAL_STATUS',
  [KycRequestStatus.REIS_REJECTED]: 'ALREADY_REJECTED',
  [KycRequestStatus.FINALIZED]: 'ALREADY_FINALIZED',
  [KycRequestStatus.DELIVERY_UNCERTAIN]: 'DELIVERY_UNCERTAIN',
  [KycRequestStatus.FAILED_RETRYABLE]: 'PREVIOUS_ATTEMPT_FAILED',
  [KycRequestStatus.FAILED_PERMANENT]: 'PREVIOUS_ATTEMPT_FAILED',
  // Not a duplicate: REIS was never contacted, so corrected data may be submitted again.
  [KycRequestStatus.VALIDATION_FAILED]: undefined,
};

/**
 * Orchestrates one submission:
 *
 *   FLEXCUBE request -> mapper -> transformer -> create/persist case -> REIS onboard
 *   (fresh authentication inside the client) -> persist the onboarding result
 *
 * KYC_REF_NO is the REIS systemId. Responsibilities stay separate: the mapper/transformer never
 * call REIS, the REIS client never touches the repository, the repository knows nothing of HTTP.
 *
 * Safety rules:
 *  - Nothing is ever retried or resubmitted automatically (retry/resubmission policy is TBD).
 *  - A repeated KYC_REF_NO returns a typed DUPLICATE result and makes no external call; the only
 *    exception is a case that failed VALIDATION (REIS never contacted).
 *  - Validation/mapping/transformation errors happen before REIS is contacted.
 *  - Only classification codes and safe text are persisted: never tokens, credentials, payloads,
 *    customer values, or REIS free text (instruction / errorMessage).
 */
@Injectable()
export class KycWorkflow implements IKycWorkflow {
  private readonly logger = new Logger(KycWorkflow.name);

  constructor(
    @Inject(FLEXCUBE_TO_CANONICAL_MAPPER) private readonly mapper: IFlexcubeToCanonicalMapper,
    @Inject(CANONICAL_TO_REIS_TRANSFORMER)
    private readonly transformer: ICanonicalToReisTransformer,
    @Inject(KYC_CASE_REPOSITORY) private readonly cases: IKycCaseRepository,
    @Inject(REIS_ONBOARDING_CLIENT) private readonly reis: IReisOnboardingClient,
    @Inject(FLEXCUBE_STATUS_UPDATER) private readonly flexcube: IFlexcubeStatusUpdater,
  ) {}

  async submit(
    request: FlexcubeCustomerRequest,
    options: SubmitOptions = {},
  ): Promise<KycSubmissionResult> {
    const seqNo = options.seqNo ?? 1;
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

    // 1. Idempotency: the same submission (KYC_REF_NO + SEQ_NO) is never sent twice
    //    (VALIDATION_FAILED excepted). A newer SEQ_NO (amendment) is allowed once the previous
    //    submission is closed; while it is still in progress the amendment is reported as duplicate.
    const existing = await this.cases.findByKycRefNo(kycRefNo);
    const amendment = existing !== null && seqNo > existing.seqNo;
    if (
      existing &&
      !amendment &&
      existing.internalRequestStatus !== KycRequestStatus.VALIDATION_FAILED
    ) {
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
      const reopened = await this.cases.reopenAfterValidationFailure(
        existing.internalId,
        canonicalType,
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

    // 4. Call REIS exactly once. The client authenticates afresh and never retries.
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
   * After an immediate final decision (CLEAN -> CUSTOMER, REJECT -> BLOCKED) the FLEXCUBE update
   * is attempted once. A failure never loses the REIS decision: it is recorded as FAILED and the
   * existing operator recovery (claimFlexcubeRecovery) can replay it.
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

  // ---- identity (overridden by CifKycWorkflow) -------------------------------------------

  /** The REIS request built from the canonical customer. Historical identity: systemId = KYC_REF_NO. */
  protected toReisRequest(canonical: CanonicalKycCustomer): Promise<ReisOnboardingRequest> {
    return this.transformer.transform(canonical);
  }

  /** The REIS systemId of this submission, or null when it cannot be determined. */
  protected identityOf(request: FlexcubeCustomerRequest): string | null {
    return typeof request.KYC_REF_NO === 'string' ? request.KYC_REF_NO : null;
  }

  // ---- helpers ---------------------------------------------------------------------------

  private duplicate(kycCase: KycCase): SubmissionDuplicate {
    const reason = DUPLICATE_REASON[kycCase.internalRequestStatus] ?? 'IN_PROGRESS_OR_UNCERTAIN';
    this.logger.warn({
      event: 'kyc.submission.duplicate',
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
      internalId: saved?.internalId,
      stage: c.stage,
      code: c.code,
      persistedStatus: c.persist,
      requestMayHaveReachedReis: c.requestMayHaveReachedReis,
    });
    return {
      outcome: 'FAILED',
      stage: c.stage,
      code: c.code,
      requestMayHaveReachedReis: c.requestMayHaveReachedReis,
      persistedStatus: c.persist,
      kycCase: saved,
    };
  }
}
