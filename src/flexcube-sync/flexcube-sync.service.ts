import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { oraCode, oracleErrorCode } from '../flexcube/oracle-error';
import { IKycWorkflow } from '../kyc/kyc.interfaces';
import { KycSubmissionResult } from '../kyc/kyc-submission.result';
import { FlexcubeKycSource, PendingKyc } from '../flexcube/source/flexcube-kyc-source';
import { InvalidSqlBindsError } from '../flexcube/staging/sql-binds';
import {
  StagingKey,
  StagingProcessStatus,
  StagingSubmissionRepository,
} from '../flexcube/staging/staging-submission.repository';

export interface SyncRunSummary {
  found: number;
  sent: number;
  failed: number;
  skipped: number;
}

/** Where in the per-KYC path an error happened (logged with the error code, never the message). */
export type SyncStep = 'insert' | 'claim' | 'load' | 'submit' | 'complete';

/**
 * What kind of failure it was, which decides what happens to the staging row:
 *  - technical: the database or the code failed (Oracle error, bad SQL, lost connection). The KYC
 *    itself is not at fault and nothing was sent, so the row is NEVER turned into E: a row that was
 *    never claimed stays N, a claimed one is released back to N (only while nothing was stored).
 *  - data: the KYC cannot be processed as it is (its detail rows are missing). Row -> E.
 *  - uncertain: the submission step failed unexpectedly and REIS may have been called. Row -> E and
 *    never retried automatically: it needs reconciliation, a blind resend could duplicate it.
 *  - recording: REIS answered but the result could not be stored. The row stays in progress (it is
 *    reported as stuck after 15 minutes); it is neither resent nor overwritten with E.
 */
export type FailureKind = 'technical' | 'data' | 'uncertain' | 'recording';

/** What was done with the staging row after a failure (logged, no identifiers). */
export type FailureAction =
  | 'row_left_new'
  | 'row_released'
  | 'release_failed'
  | 'row_marked_error'
  | 'mark_error_failed'
  | 'row_left_in_progress'
  | 'no_row';

type Outcome = 'sent' | 'failed' | 'skipped';

/** A row claimed for longer than this is reported (flexcube.sync.stuckInProgress), never resent. */
export const STUCK_IN_PROGRESS_MINUTES = 15;

/** Circuit breaker: this many technical failures in a row stop the pass and open the breaker. */
export const BREAKER_THRESHOLD = 3;
export const BREAKER_BASE_COOLDOWN_MS = 5 * 60_000;
export const BREAKER_MAX_COOLDOWN_MS = 60 * 60_000;

/** The pass itself failed (pending / recovery query); carries only technical, non-sensitive facts. */
export class SyncCycleError extends Error {
  constructor(
    readonly runId: string,
    readonly phase: 'pending',
    readonly durationMs: number,
    readonly code: string,
  ) {
    super(`FLEXCUBE sync pass failed in phase ${phase} (${code})`);
    this.name = 'SyncCycleError';
  }
}

export interface SyncServiceOptions {
  /** Injectable clock (ms) for the breaker and the durations. */
  now?: () => number;
  breakerThreshold?: number;
  breakerBaseCooldownMs?: number;
  breakerMaxCooldownMs?: number;
}

export interface SyncStatus {
  lastRunAt: string | null;
  lastSuccessfulRunAt: string | null;
  consecutiveTechnicalFailures: number;
  circuitOpenUntil: string | null;
}

/** Technical failure: Oracle / driver error, invalid SQL binds, or any error outside the KYC data. */
export function classifyFailure(step: SyncStep, error: unknown): FailureKind {
  const database = oracleErrorCode(error) !== undefined || error instanceof InvalidSqlBindsError;
  if (step === 'submit') return 'uncertain'; // REIS may have been called, whatever the error was
  if (step === 'complete') return 'recording';
  if (step === 'load') return database ? 'technical' : 'data';
  return 'technical'; // insert / claim
}

/**
 * One polling pass (agreed architecture: the integration layer reads FLEXCUBE, nothing calls in):
 *
 *   open KYC since the cut-off, no staging row for its MOD_NO
 *     -> staging row N -> claimed W -> read STTM tables -> workflow (REIS)
 *     -> S (REIS answered; CLEAN / REJECT final status written by the workflow)
 *     -> E (the submission failed; RETRY_COUNT + 1). E rows are NOT retried automatically.
 *
 * One KYC never stops the pass, and a TECHNICAL failure never damages a row (see FailureKind).
 * Three technical failures in a row open a circuit breaker: the rest of the pass is skipped and
 * the next passes wait (5 min, doubling up to 60 min) so a systemic fault is not repeated for every
 * KYC. Logs carry only a run id, the step, the failure kind, the Oracle code and counts: never a
 * KYC reference, a name, a payload or a message. The staging RESPONSE of a failure holds only a
 * technical code.
 */
export class FlexcubeSyncService {
  private readonly logger = new Logger(FlexcubeSyncService.name);
  private readonly reportedStuck = new Set<string>();
  private readonly now: () => number;
  private readonly threshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;

  private consecutiveTechnical = 0;
  private breakerOpens = 0;
  private breakerOpenUntil = 0;
  private lastTechnicalCode = '';
  private lastRunAt: number | null = null;
  private lastSuccessfulRunAt: number | null = null;
  private corporateWasSupported: boolean | null = null;

  constructor(
    private readonly source: FlexcubeKycSource,
    private readonly staging: StagingSubmissionRepository,
    private readonly workflow: IKycWorkflow,
    private readonly batchSize: number,
    options: SyncServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.threshold = options.breakerThreshold ?? BREAKER_THRESHOLD;
    this.baseCooldownMs = options.breakerBaseCooldownMs ?? BREAKER_BASE_COOLDOWN_MS;
    this.maxCooldownMs = options.breakerMaxCooldownMs ?? BREAKER_MAX_COOLDOWN_MS;
  }

  /** Technical status for monitoring (no customer data). */
  getStatus(): SyncStatus {
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    return {
      lastRunAt: iso(this.lastRunAt),
      lastSuccessfulRunAt: iso(this.lastSuccessfulRunAt),
      consecutiveTechnicalFailures: this.consecutiveTechnical,
      circuitOpenUntil: this.breakerOpenUntil > this.now() ? iso(this.breakerOpenUntil) : null,
    };
  }

  async runOnce(): Promise<SyncRunSummary> {
    const runId = randomUUID();
    const started = this.now();
    const summary: SyncRunSummary = { found: 0, sent: 0, failed: 0, skipped: 0 };

    if (this.breakerOpenUntil > started) {
      this.logger.warn({
        event: 'flexcube.sync.circuitOpen',
        runId,
        retryInMs: this.breakerOpenUntil - started,
        lastError: this.lastTechnicalCode,
      });
      return summary;
    }
    this.lastRunAt = started;
    let technicalFailures = 0;

    // Our own rows left at N by an earlier failed pass go first (same claim -> load -> submit path).
    const stuck = await this.safely(runId, 'recover', () =>
      this.source.findOwnStuckNew(this.batchSize),
    );
    if (stuck === null) technicalFailures++;
    await this.reportStuckInProgress(runId);
    // The breaker may have opened on the helper queries: do not hammer the database further.
    if (this.breakerOpenUntil > this.now()) return summary;
    let pending: PendingKyc[];
    try {
      await this.refreshCorporateSupport(runId);
      pending = await this.source.findPending(this.batchSize);
    } catch (error) {
      this.recordTechnical(oraCode(error), runId);
      throw new SyncCycleError(runId, 'pending', this.now() - started, oraCode(error));
    }
    const work: { kyc: PendingKyc; recovering: boolean }[] = [
      ...(stuck ?? []).map((kyc) => ({ kyc, recovering: true })),
      ...pending.map((kyc) => ({ kyc, recovering: false })),
    ];
    summary.found = work.length;

    let item = 0;
    for (const { kyc, recovering } of work) {
      if (this.breakerOpenUntil > this.now()) break; // opened during this pass: stop here
      item++;
      const result = await this.processOne(kyc, recovering, runId, item);
      summary[result.outcome]++;
      if (result.technical) technicalFailures++;
    }

    if (technicalFailures === 0) this.lastSuccessfulRunAt = this.now();
    if (summary.found > 0 || technicalFailures > 0) {
      this.logger.log({
        event: 'flexcube.sync.run',
        runId,
        durationMs: this.now() - started,
        ...summary,
        technicalFailures,
        recovered: (stuck ?? []).length,
        lastSuccessfulRunAt: this.getStatus().lastSuccessfulRunAt,
      });
    }
    return summary;
  }

  /** Corporate KYCs are only taken while the key-person type column is proven to exist. */
  private async refreshCorporateSupport(runId: string): Promise<void> {
    const supported = await this.source.refreshCorporateSupport(this.now());
    if (supported !== this.corporateWasSupported) {
      this.corporateWasSupported = supported;
      if (!supported) {
        this.logger.warn({
          event: 'flexcube.sync.corporateDisabled',
          runId,
          reason: 'KEYPERSON_TYPE_COLUMN_NOT_FOUND',
        });
      }
    }
  }

  /** Only logged (counts, once per row): a half-sent submission is never resent automatically. */
  private async reportStuckInProgress(runId: string): Promise<void> {
    const rows = await this.safely(runId, 'stuckCheck', () =>
      this.staging.findStuckInProgress(STUCK_IN_PROGRESS_MINUTES, 50),
    );
    const fresh = (rows ?? []).filter((r) => !this.reportedStuck.has(`${r.kycRefNo}/${r.seqNo}`));
    for (const r of fresh) this.reportedStuck.add(`${r.kycRefNo}/${r.seqNo}`);
    if (fresh.length > 0) {
      this.logger.warn({
        event: 'flexcube.sync.stuckInProgress',
        runId,
        newlyReported: fresh.length,
        total: (rows ?? []).length,
        olderThanMinutes: STUCK_IN_PROGRESS_MINUTES,
      });
    }
  }

  /** A failing helper query is logged with its code, counts as a technical failure, never throws. */
  private async safely<T>(
    runId: string,
    what: string,
    run: () => Promise<T[]>,
  ): Promise<T[] | null> {
    try {
      return await run();
    } catch (error) {
      const code = oraCode(error);
      this.logger.error({ event: `flexcube.sync.${what}Failed`, runId, error: code });
      this.recordTechnical(code, runId);
      return null;
    }
  }

  /** Never throws: a failure is logged and the staging row is protected (see FailureKind). */
  private async processOne(
    kyc: PendingKyc,
    recovering: boolean,
    runId: string,
    item: number,
  ): Promise<{ outcome: Outcome; technical: boolean }> {
    const key: StagingKey = { kycRefNo: kyc.kycRefNo, seqNo: kyc.seqNo };
    if (!Number.isInteger(kyc.seqNo) || kyc.seqNo < 1) {
      this.logger.warn({ event: 'flexcube.sync.invalidSeqNo', runId, item });
      return { outcome: 'skipped', technical: false };
    }
    let step: SyncStep = 'insert';
    let claimed = false;
    try {
      // Another instance may have taken it: insert and claim are both conditional.
      // A recovered row already exists (left at N): it goes straight to the claim.
      if (!recovering && !(await this.staging.insertNew(key, randomUUID()))) {
        return { outcome: 'skipped', technical: false };
      }
      step = 'claim';
      if (!(await this.staging.claim(key))) return { outcome: 'skipped', technical: false };
      claimed = true;
      step = 'load';
      const request = await this.source.load(kyc);
      step = 'submit';
      const result = await this.workflow.submit(request, { seqNo: kyc.seqNo });
      step = 'complete';
      const outcome = await this.complete(key, result);
      this.recordSuccess();
      return { outcome, technical: false };
    } catch (error) {
      const kind = classifyFailure(step, error);
      const action = await this.protectRow(key, step, kind, claimed, error);
      this.logger.error({
        event: 'flexcube.sync.kycFailed',
        runId,
        item,
        step,
        kind,
        action,
        error: oraCode(error),
      });
      const technical = kind === 'technical' || kind === 'recording';
      if (technical) this.recordTechnical(oraCode(error), runId);
      else this.recordSuccess(); // the database path worked: the failure was about this KYC
      return { outcome: 'failed', technical };
    }
  }

  private async complete(key: StagingKey, result: KycSubmissionResult): Promise<Outcome> {
    switch (result.outcome) {
      case 'ONBOARDED':
        await this.staging.complete(key, {
          status: StagingProcessStatus.SUCCESS,
          request: result.reisRequest,
          response: result.reisResponse,
        });
        return 'sent';
      case 'FAILED':
        await this.staging.complete(key, {
          status: StagingProcessStatus.ERROR,
          request: result.reisRequest,
          response: { error: result.code, stage: result.stage },
        });
        return 'failed';
      case 'DUPLICATE':
        await this.staging.complete(key, {
          status: StagingProcessStatus.ERROR,
          response: { error: 'DUPLICATE', reason: result.reason },
        });
        return 'failed';
    }
  }

  /** Decides and performs what happens to the staging row; it never throws. */
  private async protectRow(
    key: StagingKey,
    step: SyncStep,
    kind: FailureKind,
    claimed: boolean,
    error: unknown,
  ): Promise<FailureAction> {
    if (step === 'insert') return 'no_row'; // nothing was created
    switch (kind) {
      case 'technical':
        // Never claimed: the row is still N. Claimed: give the claim back (nothing was sent yet).
        if (!claimed) return 'row_left_new';
        try {
          return (await this.staging.release(key)) ? 'row_released' : 'release_failed';
        } catch {
          return 'release_failed';
        }
      case 'recording':
        return 'row_left_in_progress'; // REIS answered: neither resend nor overwrite
      case 'data':
      case 'uncertain':
        try {
          await this.staging.fail(
            key,
            kind === 'uncertain'
              ? { error: oraCode(error), delivery: 'UNCERTAIN' }
              : { error: oraCode(error) },
          );
          return 'row_marked_error';
        } catch {
          return 'mark_error_failed';
        }
    }
  }

  // ---- circuit breaker ---------------------------------------------------------------------

  private recordSuccess(): void {
    this.consecutiveTechnical = 0;
    this.breakerOpens = 0;
  }

  private recordTechnical(code: string, runId: string): void {
    this.consecutiveTechnical++;
    this.lastTechnicalCode = code;
    if (this.consecutiveTechnical < this.threshold) return;
    if (this.breakerOpenUntil > this.now()) return; // already open
    const cooldown = Math.min(this.baseCooldownMs * 2 ** this.breakerOpens, this.maxCooldownMs);
    this.breakerOpens++;
    this.breakerOpenUntil = this.now() + cooldown;
    this.logger.error({
      event: 'flexcube.sync.circuitOpened',
      runId,
      consecutiveTechnicalFailures: this.consecutiveTechnical,
      cooldownMs: cooldown,
      error: code,
    });
  }
}
