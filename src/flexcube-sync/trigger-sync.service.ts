import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { KycRequestStatus } from '../common/kyc-status';
import { oraCode, oracleErrorCode } from '../flexcube/oracle-error';
import {
  CustomerTriggerSource,
  RECHECK_MARKERS,
  TriggerWork,
} from '../flexcube/source/customer-trigger.source';
import { FlexcubeKycSource } from '../flexcube/source/flexcube-kyc-source';
import { InvalidSqlBindsError } from '../flexcube/staging/sql-binds';
import {
  StagingKey,
  StagingProcessStatus,
  StagingSubmissionRepository,
} from '../flexcube/staging/staging-submission.repository';
import { FlexcubeCustomerRequest } from '../flexcube/dto/flexcube-customer.request';
import { IKycWorkflow } from '../kyc/kyc.interfaces';
import { DuplicateReason, KycSubmissionResult } from '../kyc/kyc-submission.result';
import { requireCif } from '../reis/cif-identity';
import { ReisOnboardingStatus } from '../reis/reis-status';

export interface TriggerSyncSummary {
  found: number;
  sent: number;
  retrying: number;
  failed: number;
  skipped: number;
}

export interface TriggerSyncOptions {
  batchSize: number;
  /** Attempts per CIF revision before it is set to E (FLEXCUBE_SYNC_MAX_ATTEMPTS). */
  maxAttempts: number;
  /** Wait between two attempts (FLEXCUBE_SYNC_RETRY_DELAY_MS). */
  retryDelayMs: number;
  /** Wait before a validation failure is checked again (FLEXCUBE_SYNC_RECHECK_DELAY_MS). */
  recheckDelayMs: number;
  /** Only these CIFs are sent; empty = all (FLEXCUBE_SYNC_CIF_ALLOWLIST). */
  cifAllowlist: ReadonlySet<string>;
  now?: () => number;
}

/** A claimed row older than this (well above the REIS timeout) belongs to a worker that died. */
export const STALE_CLAIM_MINUTES = 5;
/** This many technical (database) failures in a row end the pass; the next pass tries again. */
export const MAX_TECHNICAL_FAILURES = 3;

/** REIS already has this revision: the row is done, nothing is sent again. */
const ALREADY_AT_REIS: ReadonlySet<DuplicateReason> = new Set<DuplicateReason>([
  'ALREADY_CLEAN',
  'AWAITING_FINAL_STATUS',
  'ALREADY_REJECTED',
  'ALREADY_FINALIZED',
]);

const RETRYABLE: ReadonlySet<KycRequestStatus> = new Set([
  KycRequestStatus.FAILED_RETRYABLE,
  KycRequestStatus.DELIVERY_UNCERTAIN,
]);

type Outcome = 'sent' | 'retrying' | 'failed' | 'skipped';
type Step = 'insert' | 'claim' | 'load' | 'pick' | 'submit' | 'complete';

/** The KYC details carry a CUSTOMER_NO different from the trigger row's CIF. */
export class CifSourcesDisagreeError extends Error {
  constructor() {
    super('CUSTOMER_NO of the KYC details differs from the trigger row');
    this.name = 'CifSourcesDisagreeError';
  }
}

const isTechnical = (error: unknown) =>
  oracleErrorCode(error) !== undefined || error instanceof InvalidSqlBindsError;

/** A code safe to store and log: an Oracle code or an error class name, never a message. */
const errorCode = (error: unknown) =>
  isTechnical(error) ? oraCode(error) : error instanceof Error ? error.name : 'Error';

/**
 * Sends every new or modified CIF from the Finexta trigger table to REIS and writes the result back:
 *
 *   trigger U -> staging N -> claimed W -> KYC read -> trigger P -> REIS (systemId = CIF) -> staging S
 *   (REIS_FINAL_STATUS written at once for CLEAN / REJECT; PENDING is finished by the REIS callback).
 *
 * Failures:
 *  - REIS not reached, refused the token, or outcome unknown (timeout, 5xx, crash): staging back to N with
 *    RETRY_COUNT + 1, trigger stays P; the retry pass sends it again after the delay, up to maxAttempts,
 *    then staging E and trigger E;
 *  - REIS refused the data (4xx): E, and checked again every recheck delay: sent again only when the request
 *    built from FLEXCUBE differs from the refused one (data corrected), or as a new revision (U);
 *  - the KYC cannot be built (missing / invalid data, never sent): E, and checked again every recheck delay, so
 *    data corrected in FLEXCUBE is sent without a new CIF revision;
 *  - database problem before REIS: the claim is given back, nothing counted.
 * A KYC whose staging table already holds a HIGHER SEQ_NO is never sent (trigger E).
 * Logs carry the KYC reference, SEQ_NO, counts, steps and codes; never a name or a payload.
 */
export class TriggerSyncService {
  private readonly logger = new Logger(TriggerSyncService.name);
  private readonly now: () => number;

  constructor(
    private readonly triggers: CustomerTriggerSource,
    private readonly details: FlexcubeKycSource,
    private readonly staging: StagingSubmissionRepository,
    private readonly workflow: IKycWorkflow,
    private readonly options: TriggerSyncOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async runOnce(): Promise<TriggerSyncSummary> {
    const runId = randomUUID();
    const summary: TriggerSyncSummary = { found: 0, sent: 0, retrying: 0, failed: 0, skipped: 0 };
    const { batchSize, cifAllowlist, retryDelayMs, recheckDelayMs } = this.options;

    const recovered = await this.staging.recoverStale(STALE_CLAIM_MINUTES);
    if (recovered > 0) {
      this.logger.warn({ event: 'flexcube.trigger.staleRecovered', runId, recovered });
    }

    const corporate = await this.details.refreshCorporateSupport(this.now());
    const work = [
      ...(await this.triggers.findReady(batchSize, corporate)),
      ...(await this.triggers.findRetryDue(batchSize, corporate, Math.ceil(retryDelayMs / 1000))),
      ...(await this.triggers.findRecheckDue(
        batchSize,
        corporate,
        Math.ceil(recheckDelayMs / 1000),
      )),
    ].filter((w) => cifAllowlist.size === 0 || cifAllowlist.has(w.customerNo));
    summary.found = work.length;

    let technical = 0;
    for (const item of work) {
      if (technical >= MAX_TECHNICAL_FAILURES) break;
      const result = await this.processOne(item, runId);
      this.logger.log({
        event: 'flexcube.trigger.item',
        runId,
        kycRefNo: item.kycRefNo,
        seqNo: item.seqNo,
        attempt: item.retryCount + 1,
        recheck: item.recheck,
        outcome: result.outcome,
      });
      summary[result.outcome]++;
      technical = result.technical ? technical + 1 : 0;
    }
    if (summary.found > 0) this.logger.log({ event: 'flexcube.trigger.run', runId, ...summary });
    return summary;
  }

  /** Never throws: every failure leaves the staging row and the trigger in a defined state. */
  private async processOne(
    work: TriggerWork,
    runId: string,
  ): Promise<{ outcome: Outcome; technical: boolean }> {
    const key: StagingKey = { kycRefNo: work.kycRefNo, seqNo: work.seqNo };
    if (!Number.isInteger(work.seqNo) || work.seqNo < 1) {
      return this.refuse(work, runId, 'INVALID_CIF_MOD_NO');
    }
    if (work.higherRows > 0) return this.refuse(work, runId, 'HIGHER_SEQ_NO_EXISTS');
    if (work.retryCount >= this.options.maxAttempts) {
      await this.staging.fail(key, { error: 'MAX_ATTEMPTS_REACHED' }).catch(() => false);
      return this.refuse(work, runId, 'MAX_ATTEMPTS_REACHED');
    }

    let step: Step = 'insert';
    let claimed = false;
    let picked = work.picked;
    try {
      if (work.stagingRows === 0 && !(await this.staging.insertNew(key, randomUUID()))) {
        return { outcome: 'skipped', technical: false }; // another instance took it
      }
      step = 'claim';
      const got = work.recheck
        ? await this.staging.reclaimFailed(key, RECHECK_MARKERS)
        : await this.staging.claim(key);
      if (!got) {
        if (work.picked || work.recheck) return { outcome: 'skipped', technical: false };
        if (await this.staging.alreadySent(key)) {
          // U again for a revision REIS already answered: nothing is sent twice. The trigger goes back to P (done)
          // and a PENDING answer stored before REIS_FINAL_STATUS was written gets PENDING now.
          await this.staging.markPendingAnswer(key);
          await this.triggers.markPicked(work);
          this.logger.warn({
            event: 'flexcube.trigger.alreadySent',
            runId,
            kycRefNo: work.kycRefNo,
            seqNo: work.seqNo,
          });
          return { outcome: 'skipped', technical: false };
        }
        // Failed or being processed: the recheck / retry passes handle it.
        return this.refuse(work, runId, 'REVISION_ALREADY_STAGED');
      }
      claimed = true;

      step = 'load';
      const raw = await this.details.load(work);
      if (raw.CUSTOMER_NO != null && requireCif(raw.CUSTOMER_NO) !== work.customerNo) {
        throw new CifSourcesDisagreeError();
      }
      const request = { ...raw, CUSTOMER_NO: work.customerNo };

      if (work.previousRequest !== undefined && (await this.unchanged(work, request))) {
        // REIS refused exactly this request: wait until the data is corrected in FLEXCUBE.
        await this.staging.unclaimFailed(key);
        return { outcome: 'skipped', technical: false };
      }

      if (!picked) {
        step = 'pick';
        if (!(await this.triggers.markPicked(work))) {
          // FCUBS moved the trigger or the CIF changed: next pass decides
          await (work.recheck ? this.staging.unclaimFailed(key) : this.staging.release(key));
          return { outcome: 'skipped', technical: false };
        }
        picked = true;
      }

      step = 'submit';
      const result = await this.workflow.submit(request, { seqNo: work.seqNo });
      step = 'complete';
      return { outcome: await this.record(work, key, result), technical: false };
    } catch (error) {
      const code = errorCode(error);
      this.logger.error({
        event: 'flexcube.trigger.failed',
        runId,
        kycRefNo: work.kycRefNo,
        seqNo: work.seqNo,
        step,
        error: code,
      });
      if (step === 'submit') {
        // REIS may or may not have been reached: another attempt later.
        const outcome = await this.retryOrGiveUp(work, key, {
          response: { error: code, delivery: 'UNCERTAIN' },
        }).catch((): Outcome => 'failed');
        return { outcome, technical: false };
      }
      if (step === 'complete') {
        // REIS answered but the result could not be stored: the row stays W and is recovered as stale.
        return { outcome: 'failed', technical: true };
      }
      if (isTechnical(error)) {
        if (claimed) {
          // Database problem before REIS: give the claim back. A picked trigger needs a counted attempt so
          // that the retry pass finds the row again.
          await (
            picked
              ? this.staging.scheduleRetry(key, { response: { error: code } })
              : work.recheck
                ? this.staging.unclaimFailed(key)
                : this.staging.release(key)
          ).catch(() => false);
        }
        return { outcome: 'failed', technical: true };
      }
      // The KYC itself cannot be sent (missing details, CIF mismatch): E, a corrected CIF comes back as U.
      if (claimed) {
        await this.staging
          .fail(key, { error: code.slice(0, 60), stage: 'VALIDATION' })
          .catch(() => false);
      }
      await this.markError(work);
      return { outcome: 'failed', technical: false };
    }
  }

  /** The request built from today's data is the one REIS already refused. */
  private async unchanged(work: TriggerWork, request: FlexcubeCustomerRequest): Promise<boolean> {
    let previous: unknown;
    try {
      previous = JSON.parse(work.previousRequest as string);
    } catch {
      return false;
    }
    return JSON.stringify(await this.workflow.preview(request)) === JSON.stringify(previous);
  }

  /** Stores the workflow result on the staging row and decides retry / done. */
  private async record(
    work: TriggerWork,
    key: StagingKey,
    result: KycSubmissionResult,
  ): Promise<Outcome> {
    switch (result.outcome) {
      case 'ONBOARDED': {
        const done = {
          status: StagingProcessStatus.SUCCESS,
          request: result.reisRequest,
          response: result.reisResponse,
        } as const;
        if (result.reisOnboardingStatus !== ReisOnboardingStatus.PENDING) {
          await this.staging.complete(key, done);
          return 'sent';
        }
        try {
          await this.staging.complete(key, { ...done, pending: true });
        } catch (error) {
          // The table refuses PENDING (CHECK constraint): store the answer without it, never lose it.
          if (oracleErrorCode(error) === undefined) throw error;
          this.logger.warn({ event: 'flexcube.staging.pendingRefused', error: oraCode(error) });
          await this.staging.complete(key, done);
        }
        return 'sent';
      }
      case 'FAILED': {
        const response = { error: result.code, stage: result.stage, detail: result.message };
        if (RETRYABLE.has(result.persistedStatus)) {
          return this.retryOrGiveUp(work, key, { request: result.reisRequest, response });
        }
        await this.staging.complete(key, {
          status: StagingProcessStatus.ERROR,
          request: result.reisRequest,
          response,
        });
        await this.markError(work);
        return 'failed';
      }
      case 'DUPLICATE': {
        const done = ALREADY_AT_REIS.has(result.reason);
        await this.staging.complete(key, {
          status: done ? StagingProcessStatus.SUCCESS : StagingProcessStatus.ERROR,
          response: { duplicate: result.reason },
        });
        if (done) return 'sent';
        await this.markError(work);
        return 'failed';
      }
    }
  }

  /** Another attempt after the delay, or E when this was the last one. */
  private async retryOrGiveUp(
    work: TriggerWork,
    key: StagingKey,
    attempt: { request?: object; response: object },
  ): Promise<Outcome> {
    if (work.retryCount + 1 < this.options.maxAttempts) {
      await this.staging.scheduleRetry(key, attempt);
      return 'retrying';
    }
    await this.staging.complete(key, {
      status: StagingProcessStatus.ERROR,
      request: attempt.request,
      response: { ...attempt.response, attempts: work.retryCount + 1 },
    });
    await this.markError(work);
    return 'failed';
  }

  private async refuse(
    work: TriggerWork,
    runId: string,
    reason: string,
  ): Promise<{ outcome: Outcome; technical: boolean }> {
    this.logger.warn({
      event: 'flexcube.trigger.refused',
      runId,
      kycRefNo: work.kycRefNo,
      seqNo: work.seqNo,
      reason,
    });
    await this.markError(work);
    return { outcome: 'failed', technical: false };
  }

  private async markError(work: TriggerWork): Promise<void> {
    await this.triggers.markError(work).catch(() => false);
  }
}
