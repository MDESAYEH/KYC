import type { SingleTrialApproval } from '../tools/single-kyc-trial.contract';

/**
 * The exact conditions that must ALL hold before the two hard gates of the single-record trial may be
 * lifted: (1) the CLI refusal EXACT_REVISION_CALLBACK_ROUTE_NOT_IMPLEMENTED, (2) the callback quarantine
 * of the trial identities. This function only REPORTS what is still unmet (preflight shows it). It
 * never lifts anything: both gates are constants in the code and are removed only by a reviewed change
 * after this list is empty and the evidence behind each approval reference was inspected by a person.
 * Passing local tests is not one of the conditions and never satisfies any of them.
 */
export type TrialGate =
  | 'VOCABULARY_NOT_CLEAN_PENDING_BLOCKED'
  | 'POLLING_ENABLED'
  | 'APPROVAL_MISSING'
  | 'APPROVAL_STALE_OR_INVALID'
  | 'EVIDENCE_HASH_MISMATCH'
  | 'FINEXTA_STATUS_CONTRACT_REFERENCE_MISSING'
  | 'ORACLE_CLAIM_TEST_REFERENCE_MISSING'
  | 'CIF_SOURCE_NOT_VERIFIED'
  | 'CIF_NOT_AVAILABLE_BEFORE_SUBMISSION'
  | 'REIS_IDENTITIES_NOT_CHECKED'
  | 'CALLBACK_ROUTING_REFERENCE_MISSING'
  | 'SENDERS_NOT_STOPPED'
  | 'BACKUPS_NOT_VERIFIED'
  | 'REJECT_MAPPING_NOT_DECIDED';

export interface TrialGateInput {
  /** FLEXCUBE_FINAL_STATUS_VOCABULARY in effect. */
  vocabulary: string;
  pollEnabled: boolean;
  approval?: Partial<SingleTrialApproval>;
  /** What the current preflight computed; the approval must carry exactly these. */
  expected?: { planSha256?: string; sourceSqlSha256?: string; claimSqlSha256?: string };
  now?: number;
}

const ref = (v: unknown) => typeof v === 'string' && v.trim().length >= 5;

export function evaluateTrialGates(input: TrialGateInput): {
  unmet: TrialGate[];
  /** true only when nothing is unmet: it means "a reviewed change MAY now lift the gates", not that they are lifted. */
  mayBeLiftedByReviewedChange: boolean;
} {
  const unmet: TrialGate[] = [];
  const a = input.approval;
  if (input.vocabulary !== 'clean-pending-blocked')
    unmet.push('VOCABULARY_NOT_CLEAN_PENDING_BLOCKED');
  if (input.pollEnabled) unmet.push('POLLING_ENABLED');
  if (!a) {
    unmet.push('APPROVAL_MISSING');
  } else {
    const at = Date.parse(a.approvedAt ?? '');
    const now = input.now ?? Date.now();
    if (!ref(a.approvedBy) || !Number.isFinite(at) || at > now || now - at > 3_600_000) {
      unmet.push('APPROVAL_STALE_OR_INVALID');
    }
    const e = input.expected;
    if (
      !e ||
      a.planSha256 !== e.planSha256 ||
      a.sourceSqlSha256 !== e.sourceSqlSha256 ||
      a.claimSqlSha256 !== e.claimSqlSha256
    ) {
      unmet.push('EVIDENCE_HASH_MISMATCH');
    }
    if (!ref(a.cleanPendingBlockedContractReference))
      unmet.push('FINEXTA_STATUS_CONTRACT_REFERENCE_MISSING');
    if (!ref(a.isolatedOracleClaimTestReference)) unmet.push('ORACLE_CLAIM_TEST_REFERENCE_MISSING');
    if (a.cifSourceAndJoinVerified !== true || !ref(a.sourceReference))
      unmet.push('CIF_SOURCE_NOT_VERIFIED');
    if (a.cifAvailableBeforeSubmission !== true) unmet.push('CIF_NOT_AVAILABLE_BEFORE_SUBMISSION');
    if (a.oldAndCifIdentitiesAbsent !== true || !ref(a.reisIdentityCheckReference))
      unmet.push('REIS_IDENTITIES_NOT_CHECKED');
    if (!ref(a.exactRevisionCallbackRoutingReference))
      unmet.push('CALLBACK_ROUTING_REFERENCE_MISSING');
    if (a.pollingAndOtherSendersStopped !== true) unmet.push('SENDERS_NOT_STOPPED');
    if (a.backupsVerified !== true) unmet.push('BACKUPS_NOT_VERIFIED');
    if (typeof a.rejectToBlockedApproved !== 'boolean') unmet.push('REJECT_MAPPING_NOT_DECIDED');
  }
  return { unmet, mayBeLiftedByReviewedChange: unmet.length === 0 };
}
