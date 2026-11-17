import { createHash } from 'node:crypto';

/** Fixed scope: this tool has no batch mode or caller-selectable record. CIF is comparison only. */
export { SINGLE_KYC_TRIAL } from '../kyc/single-kyc-trial.scope';
export const SINGLE_TRIAL_CONFIRMATION = 'SEND_ONE_VERIFIED_KYC';
export const trialHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class SingleTrialRefusedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SingleTrialRefusedError';
  }
}

export interface SingleTrialApproval {
  approvedBy: string;
  approvedAt: string;
  planSha256: string;
  sourceSqlSha256: string;
  sourceReference: string;
  cifSourceAndJoinVerified: boolean;
  cifAvailableBeforeSubmission: boolean;
  /** REIS operations checked both the old KYC identity and CIF; no existing onboarding/customer. */
  oldAndCifIdentitiesAbsent: boolean;
  reisIdentityCheckReference: string;
  isolatedOracleClaimTestReference: string;
  claimSqlSha256: string;
  /** Finexta confirmed the table constraints/triggers AND consuming FLEXCUBE logic. */
  cleanPendingBlockedContractReference: string;
  /** Real callback route must update this exact KYC/SEQ_NO, not MAX(SEQ_NO), using the trial wire values. */
  exactRevisionCallbackRoutingReference: string;
  pollingAndOtherSendersStopped: boolean;
  backupsVerified: boolean;
  /** REJECT is not silently equated with BLOCKED without this separate approval. */
  rejectToBlockedApproved: boolean;
}

export function assertTrialApproval(
  approval: SingleTrialApproval | undefined,
  planSha256: string,
  sourceSqlSha256: string,
  claimSqlSha256: string,
  confirmation: string | undefined,
  now = Date.now(),
): asserts approval is SingleTrialApproval {
  if (confirmation !== SINGLE_TRIAL_CONFIRMATION)
    throw new SingleTrialRefusedError('CONFIRMATION_REQUIRED');
  if (!approval || typeof approval !== 'object')
    throw new SingleTrialRefusedError('OPERATIONAL_APPROVAL_REQUIRED');
  const at = Date.parse(approval.approvedAt);
  if (!Number.isFinite(at) || at > now || now - at > 3_600_000)
    throw new SingleTrialRefusedError('APPROVAL_EXPIRED_OR_INVALID');
  if (
    approval.planSha256 !== planSha256 ||
    approval.sourceSqlSha256 !== sourceSqlSha256 ||
    approval.claimSqlSha256 !== claimSqlSha256
  )
    throw new SingleTrialRefusedError('APPROVAL_EVIDENCE_CHANGED');
  for (const key of [
    'approvedBy',
    'sourceReference',
    'reisIdentityCheckReference',
    'isolatedOracleClaimTestReference',
    'cleanPendingBlockedContractReference',
    'exactRevisionCallbackRoutingReference',
  ] as const) {
    if (typeof approval[key] !== 'string' || approval[key].trim().length < 5)
      throw new SingleTrialRefusedError('APPROVAL_REFERENCE_REQUIRED');
  }
  for (const key of [
    'cifSourceAndJoinVerified',
    'cifAvailableBeforeSubmission',
    'oldAndCifIdentitiesAbsent',
    'pollingAndOtherSendersStopped',
    'backupsVerified',
  ] as const) {
    if (approval[key] !== true) throw new SingleTrialRefusedError('PREREQUISITE_NOT_APPROVED');
  }
}
