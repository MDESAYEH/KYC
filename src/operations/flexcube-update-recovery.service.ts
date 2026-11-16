import { Inject, Injectable, Logger } from '@nestjs/common';
import { FlexcubeUpdateStatus } from '../common/kyc-status';
import { FLEXCUBE_STATUS_UPDATER, IFlexcubeStatusUpdater } from '../flexcube/flexcube.interfaces';
import { KycCase } from '../persistence/kyc-case';
import { IKycCaseRepository, KYC_CASE_REPOSITORY } from '../persistence/persistence.interfaces';

export type FlexcubeRecoveryOutcome =
  /** The updater succeeded; flexcube_update_status is now APPLIED. */
  | 'RECOVERED'
  /** The updater failed again; flexcube_update_status stays FAILED with fresh safe error metadata. */
  | 'STILL_FAILED'
  /** Already APPLIED: nothing was executed (idempotent). */
  | 'ALREADY_APPLIED'
  | 'NOT_ELIGIBLE'
  | 'CASE_NOT_FOUND';

export type RecoveryIneligibleReason =
  /** No REIS final decision (CUSTOMER / BLOCKED) exists, so there is nothing to push. */
  | 'NO_FINAL_STATUS'
  /** The update is not FAILED (NOT_ATTEMPTED, or PENDING = in flight / interrupted). */
  | 'UPDATE_NOT_FAILED';

export interface FlexcubeRecoveryResult {
  outcome: FlexcubeRecoveryOutcome;
  reason?: RecoveryIneligibleReason;
  kycCase: KycCase | null;
}

/**
 * Operator-triggered recovery of FAILED FLEXCUBE status updates. Application service only: there
 * is no HTTP endpoint, no scheduler and no automatic retry. The real FLEXCUBE updater is still TBD
 * (a mock is bound), so this exercises the seam, not a real FLEXCUBE integration.
 */
export interface IFlexcubeUpdateRecoveryService {
  retryFailedUpdate(kycCaseId: string): Promise<FlexcubeRecoveryResult>;
}
export const FLEXCUBE_UPDATE_RECOVERY_SERVICE = Symbol('IFlexcubeUpdateRecoveryService');

/**
 * Rules:
 *  - only a case that already has a REIS final status (CUSTOMER / BLOCKED) and whose FLEXCUBE update
 *    is FAILED is retried; the REIS decision is NEVER modified;
 *  - the case is claimed atomically (FAILED -> PENDING) so concurrent operators run the updater once;
 *  - success -> APPLIED; failure -> FAILED again with updated safe metadata (code, generic message,
 *    attempt count, last attempt time). Only technical data is stored: no payloads, tokens or
 *    credentials;
 *  - an already APPLIED update is never executed again.
 */
@Injectable()
export class FlexcubeUpdateRecoveryService implements IFlexcubeUpdateRecoveryService {
  private readonly logger = new Logger(FlexcubeUpdateRecoveryService.name);

  constructor(
    @Inject(KYC_CASE_REPOSITORY) private readonly cases: IKycCaseRepository,
    @Inject(FLEXCUBE_STATUS_UPDATER) private readonly updater: IFlexcubeStatusUpdater,
  ) {}

  async retryFailedUpdate(kycCaseId: string): Promise<FlexcubeRecoveryResult> {
    const current = await this.cases.findByInternalId(kycCaseId);
    if (!current) return { outcome: 'CASE_NOT_FOUND', kycCase: null };
    const early = this.precheck(current);
    if (early) return early;

    const claimed = await this.cases.claimFlexcubeRecovery(kycCaseId);
    if (!claimed) {
      // Lost a race (another operator recovered it, or the state changed): report the fresh state.
      const latest = (await this.cases.findByInternalId(kycCaseId)) ?? current;
      return (
        this.precheck(latest) ?? {
          outcome: 'NOT_ELIGIBLE',
          reason: 'UPDATE_NOT_FAILED',
          kycCase: latest,
        }
      );
    }

    try {
      await this.updater.updateStatus({
        kycRefNo: claimed.kycRefNo,
        customerNo: claimed.customerNo,
        finalStatus: claimed.finalStatus as NonNullable<KycCase['finalStatus']>,
        reisCustomerId: claimed.reisCustomerId ?? undefined,
        // Same key as the original attempt, so a real updater can deduplicate.
        idempotencyKey: `${claimed.internalId}:${claimed.finalStatus}`,
      });
    } catch (error) {
      const failed = await this.cases.recordFlexcubeUpdateResult(kycCaseId, {
        status: FlexcubeUpdateStatus.FAILED,
        errorCode: 'FLEXCUBE_UPDATE_FAILED',
        errorMessage: `FLEXCUBE status update failed (${error instanceof Error ? error.name : 'Error'})`,
      });
      this.logger.warn({
        event: 'flexcube.recovery.failed',
        internalId: kycCaseId,
        attempts: failed.flexcubeUpdateAttemptCount,
      });
      return { outcome: 'STILL_FAILED', kycCase: failed };
    }
    const applied = await this.cases.recordFlexcubeUpdateResult(kycCaseId, {
      status: FlexcubeUpdateStatus.APPLIED,
    });
    this.logger.log({
      event: 'flexcube.recovery.recovered',
      internalId: kycCaseId,
      attempts: applied.flexcubeUpdateAttemptCount,
    });
    return { outcome: 'RECOVERED', kycCase: applied };
  }

  private precheck(c: KycCase): FlexcubeRecoveryResult | null {
    if (c.finalStatus === null) {
      return { outcome: 'NOT_ELIGIBLE', reason: 'NO_FINAL_STATUS', kycCase: c };
    }
    if (c.flexcubeUpdateStatus === FlexcubeUpdateStatus.APPLIED) {
      return { outcome: 'ALREADY_APPLIED', kycCase: c };
    }
    if (c.flexcubeUpdateStatus !== FlexcubeUpdateStatus.FAILED) {
      return { outcome: 'NOT_ELIGIBLE', reason: 'UPDATE_NOT_FAILED', kycCase: c };
    }
    return null;
  }
}
