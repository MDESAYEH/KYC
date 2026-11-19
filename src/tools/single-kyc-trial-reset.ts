import { SINGLE_KYC_TRIAL as TARGET, SingleTrialRefusedError } from './single-kyc-trial.contract';
import { SingleKycTrialRepository, UNDELIVERED_RESPONSE } from './single-kyc-trial.repository';
import { StagingBackupRow } from '../flexcube/staging/staging-submission.repository';

/**
 * Undo of a single-KYC trial send that NEVER reached REIS's onboarding endpoint (for example the 19/11/2026
 * attempt that stopped at authentication: REIS unreachable). It puts back exactly the state before the send so
 * the normal preflight -> approval -> send can run again:
 *   staging row E {"wire":null,"delivery":"UNCERTAIN"} -> untouched N (same MSGID), trigger E -> U,
 *   the local case created by the attempt (DELIVERY_UNCERTAIN, no REIS result) is removed.
 *
 * Refused unless ALL the evidence says nothing reached REIS: no wire.json (no HTTP response of onboarding was
 * ever captured), failure.json equal to the marker, the staging row and the local case exactly as the failed
 * attempt left them, the trigger at E, and a written REIS confirmation passed by the operator. Every Oracle
 * write is conditional (MSGID, status, marker, CIF MOD_NO, trigger), so a row that changed is not touched.
 */
export const RESET_CONFIRMATION = 'RESET_UNDELIVERED_TRIAL';

export interface LocalCaseRow {
  internal_id: string;
  kyc_ref_no: string;
  reis_system_id: string;
  seq_no: number;
  internal_request_status: string;
  reis_onboarding_status: string | null;
  final_status: string | null;
  last_error_code: string | null;
}

export interface ResetDeps {
  staging: SingleKycTrialRepository;
  /** From the attempt's evidence directory. */
  evidence: { wireSaved: boolean; failure: unknown };
  localCases(): Promise<LocalCaseRow[]>;
  /** Deletes ONE case with the exact undelivered shape; returns whether it is gone. */
  deleteLocalCase(internalId: string): Promise<boolean>;
  /** Protected durable file; throws before any write if it cannot be saved. */
  backup(value: unknown): Promise<void>;
}

export interface ResetPlan {
  row: StagingBackupRow | null;
  trigger: string | null;
  cases: LocalCaseRow[];
  refusals: string[];
}

export async function planReset(deps: ResetDeps): Promise<ResetPlan> {
  const row = await deps.staging.read();
  const trigger = await deps.staging.triggerStatus();
  const cases = await deps.localCases();
  const refusals: string[] = [];
  if (deps.evidence.wireSaved) refusals.push('WIRE_RESPONSE_EXISTS_REIS_ANSWERED');
  if (JSON.stringify(deps.evidence.failure) !== UNDELIVERED_RESPONSE)
    refusals.push('FAILURE_EVIDENCE_NOT_UNDELIVERED');
  if (
    !row ||
    row.processStatus !== 'E' ||
    row.response !== UNDELIVERED_RESPONSE ||
    row.retryCount !== 1 ||
    row.reisFinalStatus !== null
  )
    refusals.push('STAGING_ROW_NOT_UNDELIVERED_E');
  if (trigger !== 'E') refusals.push('TRIGGER_NOT_E');
  const c = cases[0];
  if (
    cases.length !== 1 ||
    c.kyc_ref_no !== TARGET.kycRefNo ||
    c.reis_system_id !== TARGET.expectedCif ||
    Number(c.seq_no) !== TARGET.seqNo ||
    c.internal_request_status !== 'DELIVERY_UNCERTAIN' ||
    c.reis_onboarding_status !== null ||
    c.final_status !== null ||
    c.last_error_code !== 'SINGLE_TRIAL_DELIVERY_UNCERTAIN'
  )
    refusals.push('LOCAL_CASE_NOT_THE_UNDELIVERED_ATTEMPT');
  return { row, trigger, cases, refusals };
}

export async function applyReset(
  deps: ResetDeps,
  opts: { confirmation?: string; reisConfirmation?: string },
): Promise<{ reset: true; msgId: string; caseRemoved: string }> {
  if (opts.confirmation !== RESET_CONFIRMATION)
    throw new SingleTrialRefusedError('CONFIRMATION_REQUIRED');
  if (!opts.reisConfirmation || opts.reisConfirmation.trim().length < 10)
    throw new SingleTrialRefusedError('REIS_CONFIRMATION_REFERENCE_REQUIRED');
  const plan = await planReset(deps);
  if (plan.refusals.length > 0) throw new SingleTrialRefusedError(plan.refusals.join(','));
  const row = plan.row as StagingBackupRow;
  await deps.backup({
    plan,
    reisConfirmation: opts.reisConfirmation,
    at: new Date().toISOString(),
  });
  if (!(await deps.staging.resetUndelivered(row)))
    throw new SingleTrialRefusedError('RESET_ROW_NOT_ACQUIRED');
  if (!(await deps.staging.resetTrigger()))
    throw new SingleTrialRefusedError('ROW_RESET_BUT_TRIGGER_NOT_RESET');
  const caseId = plan.cases[0].internal_id;
  if (!(await deps.deleteLocalCase(caseId)))
    throw new SingleTrialRefusedError('ORACLE_RESET_BUT_LOCAL_CASE_NOT_REMOVED');
  return { reset: true, msgId: row.msgId as string, caseRemoved: caseId };
}
