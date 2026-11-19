import {
  SINGLE_KYC_TRIAL as TARGET,
  SingleTrialRefusedError,
  trialHash,
} from './single-kyc-trial.contract';

/** Offline review contract only. No DB connection, state change, reset or HTTP execution. */
export interface ResumeSnapshot {
  cif: string;
  kycRefNo: string;
  seqNo: number;
  modNo: number;
  msgId: string;
  processStatus: string;
  readyToScan: string;
  reisFinalStatus: string | null;
  request: string;
  response: string;
  payloadSha256: string;
  /** Includes Oracle dates/retry count, local case and ALL callback audit rows. */
  stateSha256: string;
  open: boolean;
  higherRevisionExists: boolean;
  callbackCount: number;
  /** Non-null after reservation, even on crash or auth failure; never reusable. */
  reservationId: string | null;
  attempts: { id: string; evidenceSha256: string }[];
}

export interface ReisAbsenceConfirmation {
  reference: string;
  confirmedBy: string;
  confirmedAt: string;
  documentSha256: string;
  cif: string;
  kycRefNo: string;
  seqNo: number;
  attempts: ResumeSnapshot['attempts'];
  noOnboardingCreated: boolean;
  noOnboardingProcessed: boolean;
}

const refuse = (code: string): never => {
  throw new SingleTrialRefusedError(code);
};
const hash = (s: string) => /^[a-f0-9]{64}$/.test(s);
const text = (s: string) => typeof s === 'string' && s.trim().length >= 5;

export function planSingleKycResume(
  snapshot: ResumeSnapshot,
  confirmation: ReisAbsenceConfirmation,
  now = Date.now(),
) {
  if (
    snapshot.cif !== TARGET.expectedCif ||
    snapshot.kycRefNo !== TARGET.kycRefNo ||
    snapshot.seqNo !== TARGET.seqNo ||
    snapshot.modNo !== TARGET.seqNo
  )
    refuse('RESUME_TARGET_OR_MOD_NO_CHANGED');
  if (
    snapshot.processStatus !== 'E' ||
    snapshot.readyToScan !== 'E' ||
    snapshot.reisFinalStatus !== null ||
    !snapshot.request ||
    !snapshot.response ||
    !snapshot.msgId ||
    !snapshot.open ||
    snapshot.higherRevisionExists
  )
    refuse('RESUME_STATE_NOT_ELIGIBLE');
  if (snapshot.callbackCount !== 0) refuse('RESUME_CALLBACK_REQUIRES_RECONCILIATION');
  if (snapshot.reservationId !== null) refuse('RESUME_ALREADY_RESERVED_NO_RESEND');
  if (
    !hash(snapshot.payloadSha256) ||
    !hash(snapshot.stateSha256) ||
    snapshot.attempts.length !== 2 ||
    new Set(snapshot.attempts.map((a) => a.id)).size !== 2 ||
    snapshot.attempts.some((a) => !text(a.id) || !hash(a.evidenceSha256))
  )
    refuse('RESUME_TWO_COMPLETE_ATTEMPTS_REQUIRED');
  const at = Date.parse(confirmation.confirmedAt);
  if (
    !text(confirmation.reference) ||
    !text(confirmation.confirmedBy) ||
    !hash(confirmation.documentSha256) ||
    !Number.isFinite(at) ||
    at > now ||
    now - at > 3_600_000 ||
    confirmation.noOnboardingCreated !== true ||
    confirmation.noOnboardingProcessed !== true
  )
    refuse('RESUME_DOCUMENTED_REIS_CONFIRMATION_REQUIRED');
  const attemptSet = (attempts: ResumeSnapshot['attempts']) =>
    [...attempts].sort((a, b) => a.id.localeCompare(b.id));
  if (
    confirmation.cif !== snapshot.cif ||
    confirmation.kycRefNo !== snapshot.kycRefNo ||
    confirmation.seqNo !== snapshot.seqNo ||
    trialHash(attemptSet(confirmation.attempts)) !== trialHash(attemptSet(snapshot.attempts))
  )
    refuse('RESUME_REIS_CONFIRMATION_SCOPE_MISMATCH');
  const plan = { version: 1 as const, snapshot, confirmation };
  return { plan, planSha256: trialHash(plan), sendingAuthorized: false as const };
}

export type SingleKycResumePlan = ReturnType<typeof planSingleKycResume>;

/** Additional approval, separate from REIS confirmation and from the original trial approval. */
export interface ResumeApproval {
  approvedBy: string;
  approvedAt: string;
  planSha256: string;
  executionApproved: boolean;
}

/** Must be checked again inside the future atomic reservation transaction. */
export function assertResumeApproval(
  reviewed: SingleKycResumePlan,
  current: ResumeSnapshot,
  approval: ResumeApproval,
  now = Date.now(),
): void {
  if (trialHash(reviewed.plan) !== reviewed.planSha256) refuse('RESUME_PLAN_DAMAGED');
  const fresh = planSingleKycResume(current, reviewed.plan.confirmation, now);
  if (fresh.planSha256 !== reviewed.planSha256) refuse('RESUME_STATE_CHANGED');
  const at = Date.parse(approval.approvedAt);
  if (
    approval.executionApproved !== true ||
    !text(approval.approvedBy) ||
    approval.planSha256 !== reviewed.planSha256 ||
    !Number.isFinite(at) ||
    at > now ||
    now - at > 3_600_000
  )
    refuse('RESUME_EXPLICIT_EXECUTION_APPROVAL_REQUIRED');
}
