import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, FindOptionsWhere } from 'typeorm';
import { CustomerType } from '../canonical';
import { FlexcubeUpdateStatus, KycRequestStatus } from '../common/kyc-status';
import { ReisFinalStatus, ReisOnboardingStatus } from '../reis/reis-status';
import { KycCaseEntity } from './entities/kyc-case.entity';
import {
  CaseError,
  FinalStatusResult,
  FlexcubeUpdateResult,
  KycCase,
  NewKycCase,
  OnboardingResult,
} from './kyc-case';
import {
  CustomerNoConflictError,
  DuplicateKycCaseError,
  KycCaseNotFoundError,
} from './persistence.errors';
import { AmendmentOptions, IKycCaseRepository, RETRYABLE_STATUSES } from './persistence.interfaces';

const MAX_ERROR_CODE = 100;
const MAX_ERROR_MESSAGE = 1000;
const MAX_REIS_TEXT = 4000;

/** Onboarding answers that are final at once (no /customerStatus webhook follows). */
const IMMEDIATE_FINAL_STATUS: Partial<Record<ReisOnboardingStatus, ReisFinalStatus>> = {
  [ReisOnboardingStatus.CLEAN]: ReisFinalStatus.CUSTOMER,
  [ReisOnboardingStatus.REJECT]: ReisFinalStatus.BLOCKED,
};

const INTERNAL_STATUS_FOR_ONBOARDING: Record<ReisOnboardingStatus, KycRequestStatus> = {
  [ReisOnboardingStatus.CLEAN]: KycRequestStatus.REIS_CLEAN,
  [ReisOnboardingStatus.PENDING]: KycRequestStatus.REIS_PENDING,
  [ReisOnboardingStatus.REJECT]: KycRequestStatus.REIS_REJECTED,
};

function toDomain(e: KycCaseEntity): KycCase {
  return {
    internalId: e.internalId,
    kycRefNo: e.kycRefNo,
    customerNo: e.customerNo,
    reisSystemId: e.reisSystemId,
    reisCustomerId: e.reisCustomerId,
    riskCalculationId: e.riskCalculationId,
    reisId: e.reisId,
    customerType: e.customerType as CustomerType,
    internalRequestStatus: e.internalRequestStatus as KycRequestStatus,
    reisOnboardingStatus: e.reisOnboardingStatus as ReisOnboardingStatus | null,
    finalStatus: e.finalStatus as ReisFinalStatus | null,
    finalStatusAt: e.finalStatusAt,
    finalStatusReceivedCount: e.finalStatusReceivedCount,
    conflictingFinalStatus: e.conflictingFinalStatus as ReisFinalStatus | null,
    reisInstruction: e.reisInstruction,
    reisErrorMessage: e.reisErrorMessage,
    flexcubeUpdateStatus: e.flexcubeUpdateStatus as FlexcubeUpdateStatus,
    flexcubeUpdateErrorCode: e.flexcubeUpdateErrorCode,
    flexcubeUpdateErrorMessage: e.flexcubeUpdateErrorMessage,
    flexcubeUpdatedAt: e.flexcubeUpdatedAt,
    flexcubeUpdateAttemptCount: e.flexcubeUpdateAttemptCount,
    flexcubeLastAttemptAt: e.flexcubeLastAttemptAt,
    seqNo: e.seqNo,
    revisionCount: e.revisionCount,
    retryCount: e.retryCount,
    lastErrorCode: e.lastErrorCode,
    lastErrorMessage: e.lastErrorMessage,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** TypeORM implementation. The ORM never leaves the persistence module. */
@Injectable()
export class TypeOrmKycCaseRepository implements IKycCaseRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async create(input: NewKycCase): Promise<KycCase> {
    const reisSystemId = input.reisSystemId ?? input.kycRefNo;
    const existing = await this.dataSource
      .getRepository(KycCaseEntity)
      .createQueryBuilder('c')
      .where('c.kyc_ref_no = :kycRefNo OR c.reis_system_id = :reisSystemId', {
        kycRefNo: input.kycRefNo,
        reisSystemId,
      })
      .getCount();
    if (existing > 0) throw new DuplicateKycCaseError(input.kycRefNo, reisSystemId);

    const entity = this.dataSource.getRepository(KycCaseEntity).create({
      internalId: randomUUID(),
      kycRefNo: input.kycRefNo,
      customerNo: input.customerNo ?? null,
      reisSystemId,
      customerType: input.customerType,
      internalRequestStatus: KycRequestStatus.RECEIVED,
      seqNo: input.seqNo ?? 1,
      revisionCount: 1,
      retryCount: 0,
      finalStatusReceivedCount: 0,
      flexcubeUpdateStatus: FlexcubeUpdateStatus.NOT_ATTEMPTED,
    });
    try {
      await this.dataSource.getRepository(KycCaseEntity).insert(entity);
    } catch (err) {
      // Lost a race against a concurrent create: the unique indexes are the final guard.
      if (err instanceof Error && /unique/i.test(err.message)) {
        throw new DuplicateKycCaseError(input.kycRefNo, reisSystemId);
      }
      throw err;
    }
    return this.require(entity.internalId);
  }

  async findByKycRefNo(kycRefNo: string): Promise<KycCase | null> {
    return this.findOne({ kycRefNo });
  }

  async updateInternalStatus(internalId: string, status: KycRequestStatus): Promise<KycCase> {
    return this.update(internalId, { internalRequestStatus: status });
  }

  async recordOnboardingResult(internalId: string, result: OnboardingResult): Promise<KycCase> {
    const changes: Partial<KycCaseEntity> = {
      reisOnboardingStatus: result.reisOnboardingStatus,
      internalRequestStatus: INTERNAL_STATUS_FOR_ONBOARDING[result.reisOnboardingStatus],
      lastErrorCode: null,
      lastErrorMessage: null,
    };
    // Reis (03/11/2026): CLEAN and REJECT are final in the onboarding response - no webhook
    // follows. The decision is stored as the final status at once (received count stays 0:
    // no callback) and the FLEXCUBE update becomes PENDING, exactly as after a callback.
    const immediate = IMMEDIATE_FINAL_STATUS[result.reisOnboardingStatus];
    if (immediate) {
      changes.finalStatus = immediate;
      changes.finalStatusAt = new Date();
      changes.flexcubeUpdateStatus = FlexcubeUpdateStatus.PENDING;
    }
    if (result.reisCustomerId !== undefined) changes.reisCustomerId = result.reisCustomerId;
    if (result.riskCalculationId !== undefined)
      changes.riskCalculationId = result.riskCalculationId;
    if (result.reisId !== undefined) changes.reisId = result.reisId;
    // REIS response text: persisted on purpose (may be sensitive; never logged here).
    if (result.instruction !== undefined) {
      changes.reisInstruction =
        result.instruction === null ? null : truncate(result.instruction, MAX_REIS_TEXT);
    }
    if (result.errorMessage !== undefined) {
      changes.reisErrorMessage =
        result.errorMessage === null ? null : truncate(result.errorMessage, MAX_REIS_TEXT);
    }
    return this.update(internalId, changes);
  }

  async attachCustomerNo(internalId: string, customerNo: string): Promise<KycCase> {
    const current = await this.require(internalId);
    if (current.customerNo === customerNo) return current;
    if (current.customerNo !== null) {
      throw new CustomerNoConflictError(internalId, current.customerNo, customerNo);
    }
    // Conditional update so two concurrent attachers cannot both win with different values.
    const res = await this.dataSource
      .getRepository(KycCaseEntity)
      .createQueryBuilder()
      .update()
      .set({ customerNo })
      .where('internal_id = :internalId AND customer_no IS NULL', { internalId })
      .execute();
    if (!res.affected) {
      const latest = await this.require(internalId);
      if (latest.customerNo === customerNo) return latest;
      throw new CustomerNoConflictError(internalId, latest.customerNo ?? '', customerNo);
    }
    return this.require(internalId);
  }

  async recordValidationFailure(internalId: string, error: CaseError): Promise<KycCase> {
    return this.update(internalId, {
      internalRequestStatus: KycRequestStatus.VALIDATION_FAILED,
      lastErrorCode: truncate(error.code, MAX_ERROR_CODE),
      lastErrorMessage: truncate(error.message, MAX_ERROR_MESSAGE),
    });
  }

  async recordDeliveryUncertain(internalId: string, error: CaseError): Promise<KycCase> {
    return this.update(internalId, {
      internalRequestStatus: KycRequestStatus.DELIVERY_UNCERTAIN,
      lastErrorCode: truncate(error.code, MAX_ERROR_CODE),
      lastErrorMessage: truncate(error.message, MAX_ERROR_MESSAGE),
    });
  }

  async reopenForRetry(internalId: string, customerType: CustomerType): Promise<KycCase | null> {
    const res = await this.dataSource
      .getRepository(KycCaseEntity)
      .createQueryBuilder()
      .update()
      .set({
        internalRequestStatus: KycRequestStatus.RECEIVED,
        customerType,
        lastErrorCode: null,
        lastErrorMessage: null,
      })
      .where('internal_id = :internalId AND internal_request_status IN (:...retryable)', {
        internalId,
        retryable: RETRYABLE_STATUSES,
      })
      .execute();
    if (!res.affected) return null;
    return this.require(internalId);
  }

  async reopenForAmendment(
    internalId: string,
    seqNo: number,
    customerType: CustomerType,
    options: AmendmentOptions = {},
  ): Promise<KycCase | null> {
    // Quiet period (opt-in, default none): a REIS decision that is final may still be repeated by a late
    // callback (REIS retries until it gets a 200). The callback carries no revision, so it would be
    // applied to the NEXT revision of the same identity. Holding the next revision for a while after
    // the final decision lets such repeats drain first. Held = null, nothing changed.
    const quiet = options.quietPeriodMs ?? 0;
    const cutoff = new Date((options.now ?? new Date()).getTime() - quiet);
    const cutoffText = cutoff.toISOString().replace('T', ' ').replace('Z', '');
    const finalCondition =
      quiet > 0
        ? '(final_status IS NOT NULL AND final_status_at <= :quietCutoff)'
        : 'final_status IS NOT NULL';
    // Only a closed previous submission may be replaced: a final decision exists, or REIS was never
    // reached / refused it permanently. A submission still in progress is never overwritten.
    const res = await this.dataSource
      .getRepository(KycCaseEntity)
      .createQueryBuilder()
      .update()
      .set({
        seqNo,
        revisionCount: () => 'revision_count + 1',
        customerType,
        internalRequestStatus: KycRequestStatus.RECEIVED,
        reisOnboardingStatus: null,
        riskCalculationId: null,
        reisId: null,
        reisInstruction: null,
        reisErrorMessage: null,
        finalStatus: null,
        finalStatusAt: null,
        finalStatusReceivedCount: 0,
        conflictingFinalStatus: null,
        flexcubeUpdateStatus: FlexcubeUpdateStatus.NOT_ATTEMPTED,
        flexcubeUpdateErrorCode: null,
        flexcubeUpdateErrorMessage: null,
        flexcubeUpdatedAt: null,
        flexcubeUpdateAttemptCount: 0,
        flexcubeLastAttemptAt: null,
        retryCount: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
      })
      .where(
        `internal_id = :internalId AND seq_no < :seqNo AND (${finalCondition} OR ` +
          'internal_request_status IN (:...closed))',
        {
          internalId,
          seqNo,
          closed: [KycRequestStatus.VALIDATION_FAILED, KycRequestStatus.FAILED_PERMANENT],
          ...(quiet > 0 ? { quietCutoff: cutoffText } : {}),
        },
      )
      .execute();
    if (!res.affected) return null;
    return this.require(internalId);
  }

  async recordRetryableError(internalId: string, error: CaseError): Promise<KycCase> {
    await this.require(internalId);
    await this.dataSource
      .getRepository(KycCaseEntity)
      .createQueryBuilder()
      .update()
      .set({
        internalRequestStatus: KycRequestStatus.FAILED_RETRYABLE,
        retryCount: () => 'retry_count + 1',
        lastErrorCode: truncate(error.code, MAX_ERROR_CODE),
        lastErrorMessage: truncate(error.message, MAX_ERROR_MESSAGE),
      })
      .where('internal_id = :internalId', { internalId })
      .execute();
    return this.require(internalId);
  }

  async recordPermanentError(internalId: string, error: CaseError): Promise<KycCase> {
    return this.update(internalId, {
      internalRequestStatus: KycRequestStatus.FAILED_PERMANENT,
      lastErrorCode: truncate(error.code, MAX_ERROR_CODE),
      lastErrorMessage: truncate(error.message, MAX_ERROR_MESSAGE),
    });
  }

  async applyFinalStatus(
    reisSystemId: string,
    status: ReisFinalStatus,
    reisCustomerId?: number | null,
  ): Promise<FinalStatusResult> {
    // No wrapping transaction: every write below is a single atomic conditional/incremental
    // UPDATE, which stays correct under concurrent callbacks. This is the SQLite-safe design, NOT
    // the final production transaction design: review it when the production database is chosen.
    const manager = this.dataSource.manager;
    const current = await this.findOneIn(manager, { reisSystemId });
    if (!current) return { outcome: 'UNKNOWN_CASE', kycCase: null };

    // Identity check first: a different REIS customerId than the stored one is never overwritten.
    if (
      reisCustomerId != null &&
      current.reisCustomerId !== null &&
      current.reisCustomerId !== reisCustomerId
    ) {
      return { outcome: 'CUSTOMER_ID_MISMATCH', kycCase: current };
    }

    // CLEAN / REJECT were final in the onboarding response: Reis sends no webhook for them, so a
    // callback is unexpected and never touches the stored decision.
    if (
      current.internalRequestStatus === KycRequestStatus.REIS_CLEAN ||
      current.internalRequestStatus === KycRequestStatus.REIS_REJECTED
    ) {
      return { outcome: 'INCONSISTENT_STATE', kycCase: current };
    }

    if (current.finalStatus === null) {
      // A final status is only expected after REIS answered PENDING. Anything else is left alone.
      if (current.internalRequestStatus === KycRequestStatus.DELIVERY_UNCERTAIN) {
        // REIS may have processed an onboarding we could not confirm. Whether a final callback may
        // reconcile it is TBD (Bank/REIS decision): nothing is applied, the callback is audited.
        return { outcome: 'RECONCILIATION_REQUIRED', kycCase: current };
      }
      if (current.internalRequestStatus !== KycRequestStatus.REIS_PENDING) {
        return { outcome: 'INCONSISTENT_STATE', kycCase: current };
      }
      // B5: the callback carries no revision. With a single revision ever sent under this systemId there is
      // exactly one possible origin. With more, a delayed / duplicate callback of an EARLIER revision is
      // indistinguishable from the answer to the current one: never guess, quarantine and reconcile.
      if (current.revisionCount > 1) {
        return { outcome: 'RECONCILIATION_REQUIRED', kycCase: current };
      }
      const res = await manager
        .getRepository(KycCaseEntity)
        .createQueryBuilder()
        .update()
        .set({
          finalStatus: status,
          finalStatusAt: new Date(),
          finalStatusReceivedCount: 1,
          internalRequestStatus: KycRequestStatus.FINALIZED,
          // The REIS decision is stored; the FLEXCUBE update is tracked separately from here on.
          flexcubeUpdateStatus: FlexcubeUpdateStatus.PENDING,
          ...(reisCustomerId != null && current.reisCustomerId === null ? { reisCustomerId } : {}),
        })
        .where(
          'internal_id = :id AND final_status IS NULL AND internal_request_status = :pending',
          { id: current.internalId, pending: KycRequestStatus.REIS_PENDING },
        )
        .execute();
      if (res.affected) {
        return { outcome: 'APPLIED', kycCase: await this.requireIn(manager, current.internalId) };
      }
      // A concurrent callback won the race: fall through and compare with its result.
    }

    const latest = await this.requireIn(manager, current.internalId);
    if (latest.finalStatus === null) {
      return {
        outcome:
          latest.internalRequestStatus === KycRequestStatus.DELIVERY_UNCERTAIN
            ? 'RECONCILIATION_REQUIRED'
            : 'INCONSISTENT_STATE',
        kycCase: latest,
      };
    }
    if (latest.finalStatus === status) {
      await manager
        .getRepository(KycCaseEntity)
        .createQueryBuilder()
        .update()
        .set({ finalStatusReceivedCount: () => 'final_status_received_count + 1' })
        .where('internal_id = :id', { id: latest.internalId })
        .execute();
      return { outcome: 'DUPLICATE', kycCase: await this.requireIn(manager, latest.internalId) };
    }
    await manager
      .getRepository(KycCaseEntity)
      .createQueryBuilder()
      .update()
      .set({ conflictingFinalStatus: status })
      .where('internal_id = :id', { id: latest.internalId })
      .execute();
    return { outcome: 'CONFLICT', kycCase: await this.requireIn(manager, latest.internalId) };
  }

  async recordFlexcubeUpdateResult(
    internalId: string,
    result: FlexcubeUpdateResult,
  ): Promise<KycCase> {
    await this.require(internalId);
    const now = new Date();
    const changes =
      result.status === FlexcubeUpdateStatus.APPLIED
        ? {
            flexcubeUpdateStatus: FlexcubeUpdateStatus.APPLIED,
            flexcubeUpdateErrorCode: null,
            flexcubeUpdateErrorMessage: null,
            flexcubeUpdatedAt: now,
          }
        : {
            flexcubeUpdateStatus: FlexcubeUpdateStatus.FAILED,
            flexcubeUpdateErrorCode: truncate(
              result.errorCode ?? 'FLEXCUBE_UPDATE_FAILED',
              MAX_ERROR_CODE,
            ),
            flexcubeUpdateErrorMessage: truncate(result.errorMessage ?? '', MAX_ERROR_MESSAGE),
          };
    // Every recorded result is one call of the updater: count it and stamp the attempt.
    await this.dataSource
      .getRepository(KycCaseEntity)
      .createQueryBuilder()
      .update()
      .set({
        ...changes,
        flexcubeUpdateAttemptCount: () => 'flexcube_update_attempt_count + 1',
        flexcubeLastAttemptAt: now,
      })
      .where('internal_id = :internalId', { internalId })
      .execute();
    return this.require(internalId);
  }

  // ---- internals -------------------------------------------------------------------------

  private async update(internalId: string, changes: Partial<KycCaseEntity>): Promise<KycCase> {
    await this.require(internalId);
    await this.dataSource
      .getRepository(KycCaseEntity)
      .createQueryBuilder()
      .update()
      .set(changes)
      .where('internal_id = :internalId', { internalId })
      .execute();
    return this.require(internalId);
  }

  private async findOne(where: FindOptionsWhere<KycCaseEntity>): Promise<KycCase | null> {
    return this.findOneIn(this.dataSource.manager, where);
  }

  private async findOneIn(
    manager: EntityManager,
    where: FindOptionsWhere<KycCaseEntity>,
  ): Promise<KycCase | null> {
    const entity = await manager.getRepository(KycCaseEntity).findOne({ where });
    return entity ? toDomain(entity) : null;
  }

  private async require(internalId: string): Promise<KycCase> {
    return this.requireIn(this.dataSource.manager, internalId);
  }

  private async requireIn(manager: EntityManager, internalId: string): Promise<KycCase> {
    const found = await this.findOneIn(manager, { internalId });
    if (!found) throw new KycCaseNotFoundError(internalId);
    return found;
  }
}
