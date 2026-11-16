import { CustomerType } from '../canonical';
import { ReisFinalStatus } from '../reis/reis-status';
import {
  CaseError,
  CaseCriteria,
  FinalStatusResult,
  FlexcubeUpdateResult,
  KycCase,
  NewKycCase,
  OnboardingResult,
} from './kyc-case';
import { KycRequestStatus } from '../common/kyc-status';

/**
 * Persistence for KYC correlation, audit and retry state. Independent of the database
 * technology: implementations (TypeORM today) stay inside the persistence module.
 *
 * Update methods throw KycCaseNotFoundError when the case does not exist.
 */
export interface IKycCaseRepository {
  /** Creates a case in RECEIVED state. Throws DuplicateKycCaseError on kycRefNo/systemId reuse. */
  create(input: NewKycCase): Promise<KycCase>;

  findByInternalId(internalId: string): Promise<KycCase | null>;
  findByKycRefNo(kycRefNo: string): Promise<KycCase | null>;
  /** Used to correlate the /customerStatus callback. */
  findByReisSystemId(reisSystemId: string): Promise<KycCase | null>;

  updateInternalStatus(internalId: string, status: KycRequestStatus): Promise<KycCase>;

  /** Stores the REIS onboarding result, sets the matching internal status, clears last error. */
  recordOnboardingResult(internalId: string, result: OnboardingResult): Promise<KycCase>;

  /**
   * Attaches CUSTOMER_NO once FLEXCUBE creates the customer. Idempotent for the same value;
   * throws CustomerNoConflictError for a different value.
   */
  attachCustomerNo(internalId: string, customerNo: string): Promise<KycCase>;

  /** Input rejected before any REIS call (validation / mapping / transformation): VALIDATION_FAILED. */
  recordValidationFailure(internalId: string, error: CaseError): Promise<KycCase>;
  /**
   * Moves a VALIDATION_FAILED case back to RECEIVED so corrected data can be submitted under the
   * same KYC_REF_NO (REIS was never contacted). Returns null - changing nothing - if the case is
   * not currently VALIDATION_FAILED. Clears the last error.
   */
  reopenAfterValidationFailure(
    internalId: string,
    customerType: CustomerType,
  ): Promise<KycCase | null>;
  /**
   * A newer FLEXCUBE submission (higher SEQ_NO, i.e. an amendment) replaces a CLOSED previous one
   * (final status known, VALIDATION_FAILED or FAILED_PERMANENT): the case restarts at RECEIVED
   * with the new seqNo and every per-submission field cleared. Returns null - changing nothing -
   * when the case is still in progress or the seqNo is not higher.
   */
  reopenForAmendment(
    internalId: string,
    seqNo: number,
    customerType: CustomerType,
  ): Promise<KycCase | null>;
  /** The REIS outcome is unknown: status DELIVERY_UNCERTAIN, error recorded, retryCount unchanged. */
  recordDeliveryUncertain(internalId: string, error: CaseError): Promise<KycCase>;

  /** Temporary failure: status FAILED_RETRYABLE, retryCount + 1, error recorded. */
  recordRetryableError(internalId: string, error: CaseError): Promise<KycCase>;
  /** Permanent failure: status FAILED_PERMANENT, retryCount unchanged, error recorded. */
  recordPermanentError(internalId: string, error: CaseError): Promise<KycCase>;

  /**
   * Idempotent final-status recording keyed by REIS systemId. Never overwrites an existing final
   * status and never changes a case that is not in the expected PENDING state:
   *  - UNKNOWN_CASE          no case for that systemId
   *  - CUSTOMER_ID_MISMATCH  callback customerId differs from the stored one (nothing changes)
   *  - INCONSISTENT_STATE    no final status yet but the case is not REIS_PENDING (nothing changes)
   *  - APPLIED               first final status: stored once, case FINALIZED, flexcube update PENDING
   *  - DUPLICATE             identical status again (only the received count grows)
   *  - CONFLICT              different status than the stored one (original kept, attempt flagged)
   * `reisCustomerId` is stored only if the case has none yet.
   */
  applyFinalStatus(
    reisSystemId: string,
    status: ReisFinalStatus,
    reisCustomerId?: number | null,
  ): Promise<FinalStatusResult>;

  /**
   * Records whether the FLEXCUBE update succeeded. Independent of the REIS final status, which is
   * never touched or lost when the update fails.
   */
  recordFlexcubeUpdateResult(internalId: string, result: FlexcubeUpdateResult): Promise<KycCase>;

  /**
   * Operator recovery: atomically moves a case with a final status from flexcube update FAILED to
   * PENDING so exactly one caller runs the update. Returns null (changing nothing) otherwise.
   */
  claimFlexcubeRecovery(internalId: string): Promise<KycCase | null>;

  /** Operational lookup (oldest-updated first). Returns full cases; callers must summarize them. */
  findCases(criteria: CaseCriteria): Promise<KycCase[]>;
}
export const KYC_CASE_REPOSITORY = Symbol('IKycCaseRepository');
