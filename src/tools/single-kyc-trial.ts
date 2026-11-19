import { randomUUID } from 'node:crypto';
import { FlexcubeCustomerRequest } from '../flexcube/dto/flexcube-customer.request';
import { IFlexcubeToCanonicalMapper } from '../flexcube/flexcube.interfaces';
import { IKycCaseRepository } from '../persistence/persistence.interfaces';
import { CifOnboardingPreview } from '../reis/cif-onboarding-preview';
import { IReisOnboardingClient } from '../reis/reis.interfaces';
import { ReisRawResponse } from '../reis/transport/reis-http.transport';
import { KycRequestStatus } from '../common/kyc-status';
import { requireCif } from '../reis/cif-identity';
import { parseJsonBody, parseOnboardingResponse } from '../reis/reis-response.parser';
import { SingleKycTrialRepository } from './single-kyc-trial.repository';
import {
  SINGLE_KYC_TRIAL as TARGET,
  SingleTrialApproval,
  SingleTrialRefusedError,
  assertTrialApproval,
  trialHash,
} from './single-kyc-trial.contract';

export interface SingleTrialDeps {
  staging: SingleKycTrialRepository;
  sourceSqlSha256: string;
  /** Approved SELECT, exact target binds, ONE CIF_VALUE row; no built-in source assumption. */
  readCif(): Promise<Record<string, unknown>[]>;
  load(): Promise<FlexcubeCustomerRequest>;
  mapper: IFlexcubeToCanonicalMapper;
  preview: CifOnboardingPreview;
  hasLocalIdentity(): Promise<boolean>;
}
export interface SingleTrialSendDeps extends SingleTrialDeps {
  /** Operator stop control, checked before claim and again immediately before the HTTP client. */
  assertExecutionAllowed(): Promise<void>;
  cases: IKycCaseRepository;
  reis: IReisOnboardingClient;
  wireResponse(): ReisRawResponse | undefined;
  /** Protected durable files; throws before any write/send if the backup cannot be saved. */
  evidence(phase: 'before' | 'after' | 'failure', value: unknown): Promise<void>;
}

async function payload(deps: SingleTrialDeps) {
  const master = await deps.staging.master();
  const rows = await deps.readCif();
  if (rows.length !== 1) throw new SingleTrialRefusedError('CIF_SOURCE_MISSING_OR_AMBIGUOUS');
  const cif = requireCif(rows[0].CIF_VALUE);
  if (cif !== TARGET.expectedCif)
    throw new SingleTrialRefusedError('CIF_DOES_NOT_MATCH_REPORTED_VALUE');
  const raw = await deps.load();
  if (
    raw.KYC_REF_NO !== TARGET.kycRefNo ||
    raw.CUSTOMER_TYPE !== (master.KYC_CUST_TYPE === 'R' ? 'INDIVIDUAL' : 'CORPORATE')
  )
    throw new SingleTrialRefusedError('SOURCE_TARGET_MISMATCH');
  if (raw.CUSTOMER_NO != null && requireCif(raw.CUSTOMER_NO) !== cif)
    throw new SingleTrialRefusedError('CIF_SOURCES_DISAGREE');
  const canonical = deps.mapper.map({ ...raw, CUSTOMER_NO: cif });
  const preview = await deps.preview.preview(canonical);
  return { master, canonical, request: preview.request };
}

export async function planSingleKycTrial(deps: SingleTrialDeps) {
  const { master, canonical, request } = await payload(deps);
  const original = await deps.staging.read();
  deps.staging.assertNeverSent(original);
  await deps.staging.assertNoHigherRevision();
  if (await deps.hasLocalIdentity())
    throw new SingleTrialRefusedError('LOCAL_OR_LEGACY_IDENTITY_EXISTS');
  const plan = {
    target: TARGET,
    master,
    original,
    request,
    sourceSqlSha256: deps.sourceSqlSha256,
    claimSqlSha256: deps.staging.claimSqlSha256,
  };
  return {
    version: 1 as const,
    plan,
    planSha256: trialHash(plan),
    customerType: canonical.customerType,
  };
}
export type SingleTrialPlan = Awaited<ReturnType<typeof planSingleKycTrial>>;

/** Not a poll pass. At most one claim and one onboarding, and never a retry/requeue. */
export async function sendSingleKycTrial(
  deps: SingleTrialSendDeps,
  reviewed: SingleTrialPlan,
  approval: SingleTrialApproval | undefined,
  confirmation: string | undefined,
  now = Date.now(),
) {
  if (reviewed.version !== 1 || trialHash(reviewed.plan) !== reviewed.planSha256)
    throw new SingleTrialRefusedError('REVIEWED_PLAN_DAMAGED');
  // Approval is checked before connecting to dependencies when the submitted hashes do not match.
  assertTrialApproval(
    approval,
    reviewed.planSha256,
    deps.sourceSqlSha256,
    deps.staging.claimSqlSha256,
    confirmation,
    now,
  );
  const current = await planSingleKycTrial(deps);
  if (current.planSha256 !== reviewed.planSha256)
    throw new SingleTrialRefusedError('PREFLIGHT_STATE_CHANGED');
  await deps.evidence('before', current);
  await deps.assertExecutionAllowed();
  const original = current.plan.original;
  const msgId = original?.msgId ?? randomUUID();
  if (!original && !(await deps.staging.staging.insertNew(deps.staging.key(), msgId)))
    throw new SingleTrialRefusedError('CONCURRENT_STAGING_INSERT');
  // Our own row that failed technically before REIS (ORA-01745) is the same CIF version: reuse it.
  if (original?.processStatus === 'E' && !(await deps.staging.restoreNeverSent(original)))
    throw new SingleTrialRefusedError('RESTORE_NOT_ACQUIRED');
  if (!(await deps.staging.claim(msgId))) throw new SingleTrialRefusedError('CLAIM_NOT_ACQUIRED');
  // The detail loader reads several tables. Detect visible changes before intent or REIS calls.
  const latest = await payload(deps);
  if (trialHash(latest.request) !== trialHash(current.plan.request))
    throw new SingleTrialRefusedError('PAYLOAD_CHANGED_AFTER_CLAIM');
  // Trigger U -> P only now that our row is durable and claimed; if FCUBS changed it, give the claim back.
  if (!(await deps.staging.markPicked())) {
    await deps.staging.release(msgId);
    throw new SingleTrialRefusedError('TRIGGER_NOT_READY_OR_CIF_CHANGED');
  }
  const kycCase = await deps.cases.create({
    kycRefNo: TARGET.kycRefNo,
    seqNo: TARGET.seqNo,
    customerNo: latest.canonical.customerNo,
    reisSystemId: latest.request.systemId,
    customerType: latest.canonical.customerType,
  });
  await deps.staging.storeIntent(msgId, latest.request);
  await deps.cases.updateInternalStatus(kycCase.internalId, KycRequestStatus.SUBMITTED_TO_REIS);
  await deps.assertExecutionAllowed();
  let response;
  try {
    response = await deps.reis.onboard(latest.request, { correlationId: kycCase.internalId });
  } catch {
    const wire = deps.wireResponse();
    await deps.evidence('failure', { wire: wire ?? null, delivery: 'UNCERTAIN' });
    await deps.cases.recordDeliveryUncertain(kycCase.internalId, {
      code: 'SINGLE_TRIAL_DELIVERY_UNCERTAIN',
      message: 'Single trial requires operational reconciliation; do not resend',
    });
    await deps.staging.complete(msgId, { wire: wire ?? null, delivery: 'UNCERTAIN' }, false);
    // Finexta: the API sets E when processing failed. Best effort: the staging row already says why.
    await deps.staging.markTriggerError().catch(() => false);
    throw new SingleTrialRefusedError('DELIVERY_UNCERTAIN_NO_RESEND');
  }
  const wire = deps.wireResponse();
  // An actual HTTP response is mandatory: no fabricated response/status can be substituted.
  if (!wire || wire.status < 200 || wire.status >= 300)
    throw new SingleTrialRefusedError('REAL_WIRE_RESPONSE_REQUIRED');
  // Derive the recorded decision again from the captured wire body, never from an operator's input.
  response = parseOnboardingResponse(parseJsonBody(wire.body, 'searchOnboardCustomer'));
  await deps.cases.recordOnboardingResult(kycCase.internalId, {
    reisOnboardingStatus: response.status,
    riskCalculationId:
      response.riskCalculationId == null ? null : String(response.riskCalculationId),
    reisId: response.reisId == null ? null : String(response.reisId),
    instruction: response.instruction,
    errorMessage: response.errorMessage,
  });
  // If any recording step fails, leave W / existing evidence; never send again or fabricate success.
  await deps.staging.complete(msgId, { wire, validatedResponse: response }, true);
  let status: 'CLEAN' | 'PENDING' | 'BLOCKED' | null = null;
  if (response.status === 'CLEAN') status = 'CLEAN';
  else if (response.status === 'PENDING') status = 'PENDING';
  else if (response.status === 'REJECT' && approval.rejectToBlockedApproved === true)
    status = 'BLOCKED';
  if (status) await deps.staging.writeWireStatus(status, msgId);
  const after = await deps.staging.read();
  if (
    !after ||
    after.msgId !== msgId ||
    after.seqNo !== TARGET.seqNo ||
    after.processStatus !== 'S' ||
    after.reisFinalStatus !== status
  )
    throw new SingleTrialRefusedError('READBACK_MISMATCH_NO_RESEND');
  await deps.evidence('after', { after, response, wire });
  return {
    sent: 1,
    statusRecorded: status,
    requiresReisCallback: response.status === 'PENDING',
    requiresRejectMapping: response.status === 'REJECT' && status === null,
  };
}
