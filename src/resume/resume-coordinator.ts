import { randomUUID } from 'node:crypto';
import { ReisOnboardingRequest } from '../reis/dto';
import { ReisRawResponse } from '../reis/transport/reis-http.transport';
import { SINGLE_KYC_TRIAL as TARGET, trialHash } from '../tools/single-kyc-trial.contract';
import {
  assertResumeApproval,
  planSingleKycResume,
  ReisAbsenceConfirmation,
  ResumeApproval,
  SingleKycResumePlan,
} from '../tools/single-kyc-resume.plan';
import { HistoricalAttempt, ResumeJournal } from './resume-journal';
import { decisionFromWire, OracleResumeState, ResumeOracleAdapter } from './resume-oracle.adapter';

export interface ResumeBundle {
  reviewed: SingleKycResumePlan;
  oracle: OracleResumeState;
  localEvidence: unknown;
  payload: ReisOnboardingRequest;
  history: HistoricalAttempt[];
}
export interface ResumeExecutionApproval extends ResumeApproval {
  pollingAndOtherSendersStopped: boolean;
  backupsVerified: boolean;
  sourceAndPayloadValidated: boolean;
  callbackQuarantineApproved: boolean;
  consumerContractReference: string;
  oracleSqlReviewReference: string;
  rejectMappingApproved: boolean;
}
export function buildResumeBundle(
  oracle: OracleResumeState,
  localEvidence: unknown,
  payload: ReisOnboardingRequest,
  history: HistoricalAttempt[],
  confirmation: ReisAbsenceConfirmation,
  callbackCount: number,
  reserved: boolean,
  now = Date.now(),
): ResumeBundle {
  if (history.some((a) => trialHash(a.evidence) !== a.evidenceSha256))
    throw Error('RESUME_HISTORY_DAMAGED');
  if (payload.systemId !== TARGET.expectedCif) throw Error('RESUME_PAYLOAD_IDENTITY_MISMATCH');
  const local = localEvidence as { cases: Record<string, unknown>[]; callbacks: unknown[] };
  const c = local?.cases?.[0];
  if (
    local?.cases?.length !== 1 ||
    !c ||
    c.kyc_ref_no !== TARGET.kycRefNo ||
    c.customer_no !== TARGET.expectedCif ||
    c.reis_system_id !== TARGET.expectedCif ||
    c.seq_no !== TARGET.seqNo ||
    c.final_status !== null ||
    c.reis_onboarding_status !== null ||
    !['DELIVERY_UNCERTAIN', 'FAILED_PERMANENT', 'FAILED_RETRYABLE'].includes(
      String(c.internal_request_status),
    ) ||
    !Array.isArray(local.callbacks) ||
    local.callbacks.length !== callbackCount
  )
    throw Error('RESUME_LOCAL_EVIDENCE_INELIGIBLE');
  const s = oracle.stage;
  const reviewed = planSingleKycResume(
    {
      cif: TARGET.expectedCif,
      kycRefNo: String(s.KYC_REF_NO),
      seqNo: Number(s.SEQ_NO),
      modNo: oracle.modNo,
      msgId: String(s.MSGID),
      processStatus: String(s.PROCESS_STATUS),
      readyToScan: oracle.readyToScan,
      reisFinalStatus: s.REIS_FINAL_STATUS === null ? null : String(s.REIS_FINAL_STATUS),
      request: typeof s.REQUEST === 'string' ? s.REQUEST : '',
      response: typeof s.RESPONSE === 'string' ? s.RESPONSE : '',
      payloadSha256: trialHash(payload),
      stateSha256: trialHash({ oracle, localEvidence }),
      open: oracle.open,
      higherRevisionExists: oracle.higherRevisionExists,
      callbackCount,
      reservationId: reserved ? 'EXISTING_RESERVATION' : null,
      attempts: history.map((a) => ({ id: a.id, evidenceSha256: a.evidenceSha256 })),
    },
    confirmation,
    now,
  );
  return { reviewed, oracle, localEvidence, payload, history };
}

/** Dependency ports only. No real REIS clients are wired here, in the application, or in a CLI. */
export interface ResumePorts {
  assertExecutionAllowed(): Promise<void>;
  authenticate(): Promise<string>;
  refreshPayload(): Promise<ReisOnboardingRequest>;
  dispatch(payload: ReisOnboardingRequest, token: string): Promise<ReisRawResponse>;
}

export class ResumeCoordinator {
  constructor(
    private readonly journal: ResumeJournal,
    private readonly oracle: ResumeOracleAdapter,
    private readonly ports: ResumePorts,
    private readonly clock: () => number = Date.now,
  ) {}

  private approval(a: ResumeExecutionApproval): void {
    if (
      [
        a.pollingAndOtherSendersStopped,
        a.backupsVerified,
        a.sourceAndPayloadValidated,
        a.callbackQuarantineApproved,
      ].some((v) => v !== true) ||
      !a.consumerContractReference?.trim() ||
      !a.oracleSqlReviewReference?.trim()
    )
      throw Error('RESUME_OPERATIONAL_GATES_NOT_APPROVED');
  }

  /** Internal entrypoint for isolated tests / future reviewed composition. No apply CLI exists. */
  async execute(
    bundle: ResumeBundle,
    approval: ResumeExecutionApproval,
    now = this.clock(),
  ): Promise<{ attemptId: string; finalStatus: string }> {
    bundle = structuredClone(bundle);
    approval = structuredClone(approval);
    this.approval(approval);
    await this.ports.assertExecutionAllowed();
    const currentOracle = await this.oracle.read();
    const currentLocal = this.journal.localEvidence();
    const rebuilt = buildResumeBundle(
      bundle.oracle,
      bundle.localEvidence,
      bundle.payload,
      bundle.history,
      bundle.reviewed.plan.confirmation,
      0,
      false,
      now,
    );
    if (rebuilt.reviewed.planSha256 !== bundle.reviewed.planSha256)
      throw Error('RESUME_BUNDLE_DAMAGED');
    const attemptId = randomUUID();
    this.journal.reserve(
      attemptId,
      bundle.reviewed.planSha256,
      bundle.history,
      { bundle, approval },
      () => {
        const current = buildResumeBundle(
          currentOracle,
          this.journal.localEvidence(),
          bundle.payload,
          bundle.history,
          bundle.reviewed.plan.confirmation,
          this.journal.callbackCount(),
          this.journal.hasReservation(),
          now,
        );
        assertResumeApproval(bundle.reviewed, current.reviewed.plan.snapshot, approval, now);
        if (trialHash(currentLocal) !== trialHash(bundle.localEvidence))
          throw Error('RESUME_LOCAL_STATE_CHANGED');
      },
    );
    let phase = 'BEFORE_AUTHENTICATE';
    try {
      await this.oracle.claim(bundle.oracle, attemptId, bundle.reviewed.planSha256);
      this.journal.append(attemptId, 'ORACLE_CLAIMED', {}, 'ORACLE_CLAIMED');
      await this.ports.assertExecutionAllowed();
      phase = 'AUTHENTICATE';
      const token = await this.ports.authenticate();
      if (typeof token !== 'string' || !token.trim()) throw Error('RESUME_AUTH_TOKEN_MISSING');
      phase = 'AFTER_AUTHENTICATE';
      this.journal.append(attemptId, 'AUTHENTICATED', {}, 'AUTHENTICATED');
      await this.ports.assertExecutionAllowed();
      if (trialHash(await this.ports.refreshPayload()) !== trialHash(bundle.payload))
        throw Error('RESUME_PAYLOAD_CHANGED');
      // Confirmations and approvals may expire while authentication is in progress.
      this.approval(approval);
      assertResumeApproval(bundle.reviewed, bundle.reviewed.plan.snapshot, approval, this.clock());
      await this.oracle.prepareDispatch(attemptId, bundle.payload);
      await this.oracle.withDispatchFence(attemptId, async () => {
        await this.ports.assertExecutionAllowed();
        assertResumeApproval(
          bundle.reviewed,
          bundle.reviewed.plan.snapshot,
          approval,
          this.clock(),
        );
        this.journal.dispatchIntent(attemptId);
        phase = 'ONBOARDING';
        const wire = await this.ports.dispatch(bundle.payload, token);
        // Save exact wire BEFORE parsing or any Oracle result update. Never persist token/auth body.
        this.journal.append(attemptId, 'RESPONSE_CAPTURED', wire, 'RESPONSE_CAPTURED');
      });
      phase = 'WRITEBACK';
      const finalStatus = await this.recoverWriteback(attemptId);
      return { attemptId, finalStatus };
    } catch (error) {
      const wire = this.journal.event(attemptId, 'RESPONSE_CAPTURED') as ReisRawResponse | null;
      let validated = false;
      if (wire)
        try {
          decisionFromWire(wire, approval.rejectMappingApproved);
          validated = true;
        } catch {
          /* Unreadable/non-2xx result remains uncertain. */
        }
      const kind = validated
        ? 'WRITEBACK_PENDING'
        : wire || phase === 'ONBOARDING'
          ? 'DELIVERY_UNCERTAIN'
          : 'FAILED_BEFORE_ONBOARDING';
      this.journal.append(attemptId, kind, { phase, automaticResendAllowed: false });
      // No release, no reset, no retry. Oracle may remain W/P: durable receipts explain its in-doubt state.
      throw error;
    }
  }

  /** Response-only recovery; neither authenticate nor dispatch is reachable from here. */
  async recoverWriteback(attemptId: string): Promise<string> {
    this.journal.assertOwned(attemptId);
    const before = this.journal.event(attemptId, 'RESERVED');
    if (!before) throw Error('RESUME_RESERVED_EVIDENCE_MISSING');
    const evidence = this.journal.attemptEvidence(attemptId) as {
      bundle: ResumeBundle;
      approval: ResumeExecutionApproval;
    };
    const wire = this.journal.event(attemptId, 'RESPONSE_CAPTURED') as ReisRawResponse | null;
    if (!wire || !this.journal.event(attemptId, 'DISPATCH_INTENT'))
      throw Error('RESUME_NO_DURABLE_RESPONSE_NO_RESEND');
    const result = decisionFromWire(wire, evidence.approval.rejectMappingApproved);
    await this.oracle.writeback(attemptId, wire, evidence.approval.rejectMappingApproved);
    this.journal.projectResult(attemptId, evidence.bundle.localEvidence, result.parsed);
    if (!this.journal.event(attemptId, 'COMPLETED'))
      this.journal.append(attemptId, 'COMPLETED', { finalStatus: result.finalStatus }, 'COMPLETED');
    return result.finalStatus;
  }
}
