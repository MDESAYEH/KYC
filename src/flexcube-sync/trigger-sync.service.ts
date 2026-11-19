import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { oraCode, oracleErrorCode } from '../flexcube/oracle-error';
import { CustomerTriggerSource, ReadyCustomer } from '../flexcube/source/customer-trigger.source';
import { FlexcubeKycSource } from '../flexcube/source/flexcube-kyc-source';
import { InvalidSqlBindsError } from '../flexcube/staging/sql-binds';
import {
  StagingKey,
  StagingProcessStatus,
  StagingSubmissionRepository,
} from '../flexcube/staging/staging-submission.repository';
import { IKycWorkflow } from '../kyc/kyc.interfaces';
import { DuplicateReason, KycSubmissionResult } from '../kyc/kyc-submission.result';
import { requireCif } from '../reis/cif-identity';

export interface TriggerSyncSummary {
  found: number;
  sent: number;
  failed: number;
  skipped: number;
}

export interface TriggerSyncOptions {
  /** Only these CIFs are taken (controlled rollout). Empty = every U row (needs syncAllCifs). */
  cifAllowlist: ReadonlySet<string>;
  /** Rows an operator reconciled (FLEXCUBE_SYNC_UNCERTAIN_ACK): they no longer stop sending. */
  acknowledgedUncertain?: StagingKey[];
  now?: () => number;
}

/** A row claimed for longer than this (well above the REIS timeout) means a pass died after the claim. */
export const TRIGGER_DELIVERY_RISK_MINUTES = 5;
/** This many technical failures in a row stop the pass (the next pass tries again). */
export const TRIGGER_MAX_TECHNICAL_FAILURES = 3;

const UNCERTAIN_DUPLICATES: ReadonlySet<DuplicateReason> = new Set<DuplicateReason>([
  'DELIVERY_UNCERTAIN',
  'IN_PROGRESS_OR_UNCERTAIN',
]);

type Outcome = 'sent' | 'failed' | 'skipped';

/** The KYC details carry a CUSTOMER_NO different from the trigger row's CIF. */
export class CifSourcesDisagreeError extends Error {
  constructor() {
    super('CUSTOMER_NO of the KYC details differs from the trigger row');
    this.name = 'CifSourcesDisagreeError';
  }
}
type Step = 'insert' | 'claim' | 'load' | 'pick' | 'submit' | 'complete';

const isTechnical = (error: unknown) =>
  oracleErrorCode(error) !== undefined || error instanceof InvalidSqlBindsError;

/**
 * Automatic sending from the Finexta trigger table (agreed 19/11/2026):
 *
 *   STTM_CUSTOMER_CUSTOM.READY_TO_SCAN = U (FCUBS, after a CIF is created / modified and authorized)
 *     -> staging row (KYC_REF_NO, SEQ_NO = STTM_CUSTOMER.MOD_NO) N -> claimed W -> KYC details read
 *     -> trigger U -> P (picked) -> REIS (systemId = CIF) -> S, with REIS_FINAL_STATUS written at once for
 *        CLEAN / REJECT (BLOCKED); PENDING is finished by the REIS callback on the same revision
 *     -> on any failure the staging row is E (or released to N when nothing was sent) and the trigger E.
 *
 * Safety (same rules as the single-KYC trial):
 *  - nothing is sent while any delivery is uncertain (send guard), and an uncertain result stops the pass;
 *  - nothing is resent automatically: an E row or E trigger needs a person;
 *  - a KYC whose staging table already has a HIGHER SEQ_NO is not sent (FLEXCUBE's account check reads the
 *    highest SEQ_NO, our result would be invisible) and its trigger is set to E;
 *  - a CIF revision that is already staged and not untouched N is not sent again (trigger E);
 *  - the trigger goes U -> P only after the staging row is claimed and the KYC was read, and only while the CIF
 *    is still at the same MOD_NO; a technical failure before that leaves U, so the next pass retries;
 *  - the first runs are limited to an allow-list of CIFs.
 * Logs carry counts, steps and Oracle codes only, never a CIF, a name or a payload.
 */
export class TriggerSyncService {
  private readonly logger = new Logger(TriggerSyncService.name);
  private readonly acknowledged: ReadonlySet<string>;
  private readonly now: () => number;
  private haltedInProcess = false;
  private lastRunAt: number | null = null;
  private lastSuccessfulRunAt: number | null = null;
  private sendingHalted = false;

  constructor(
    private readonly triggers: CustomerTriggerSource,
    private readonly details: FlexcubeKycSource,
    private readonly staging: StagingSubmissionRepository,
    private readonly workflow: IKycWorkflow,
    private readonly batchSize: number,
    private readonly options: TriggerSyncOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.acknowledged = new Set(
      (options.acknowledgedUncertain ?? []).map((k) => `${k.kycRefNo}/${k.seqNo}`),
    );
  }

  getStatus() {
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    return {
      lastRunAt: iso(this.lastRunAt),
      lastSuccessfulRunAt: iso(this.lastSuccessfulRunAt),
      sendingHalted: this.sendingHalted,
    };
  }

  async runOnce(): Promise<TriggerSyncSummary> {
    const runId = randomUUID();
    const summary: TriggerSyncSummary = { found: 0, sent: 0, failed: 0, skipped: 0 };
    this.lastRunAt = this.now();
    if (await this.deliveryUnresolved(runId)) return summary;

    const corporate = await this.details.refreshCorporateSupport(this.now());
    const ready = (await this.triggers.findReady(this.batchSize, corporate)).filter(
      (c) => this.options.cifAllowlist.size === 0 || this.options.cifAllowlist.has(c.customerNo),
    );
    summary.found = ready.length;

    let technical = 0;
    for (const customer of ready) {
      if (this.haltedInProcess || technical >= TRIGGER_MAX_TECHNICAL_FAILURES) break;
      const result = await this.processOne(customer, runId);
      summary[result.outcome]++;
      technical = result.technical ? technical + 1 : 0;
    }
    if (technical === 0) this.lastSuccessfulRunAt = this.now();
    if (summary.found > 0) this.logger.log({ event: 'flexcube.trigger.run', runId, ...summary });
    return summary;
  }

  /** Never throws: a failure is logged, the staging row and the trigger are left in a safe state. */
  private async processOne(
    customer: ReadyCustomer,
    runId: string,
  ): Promise<{ outcome: Outcome; technical: boolean }> {
    const key: StagingKey = { kycRefNo: customer.kycRefNo, seqNo: customer.seqNo };
    if (!Number.isInteger(customer.seqNo) || customer.seqNo < 1) {
      return this.refuse(customer, runId, 'INVALID_CIF_MOD_NO');
    }
    if (customer.higherRows > 0) return this.refuse(customer, runId, 'HIGHER_SEQ_NO_EXISTS');

    let step: Step = 'insert';
    let claimed = false;
    let picked = false;
    try {
      if (customer.stagingRows === 0 && !(await this.staging.insertNew(key, randomUUID()))) {
        return { outcome: 'skipped', technical: false }; // another instance took it
      }
      step = 'claim';
      if (!(await this.staging.claim(key))) {
        // The revision is already staged and not an untouched N row (sent, failed or in progress).
        return this.refuse(customer, runId, 'REVISION_ALREADY_STAGED');
      }
      claimed = true;
      step = 'load';
      const raw = await this.details.load({ ...key, customerType: customer.customerType });
      if (raw.CUSTOMER_NO != null && requireCif(raw.CUSTOMER_NO) !== customer.customerNo) {
        throw new CifSourcesDisagreeError();
      }
      const request = { ...raw, CUSTOMER_NO: customer.customerNo };
      step = 'pick';
      if (!(await this.triggers.markPicked(customer))) {
        await this.staging.release(key); // FCUBS moved the trigger or the CIF changed: next pass decides
        return { outcome: 'skipped', technical: false };
      }
      picked = true;
      step = 'submit';
      const result = await this.workflow.submit(request, { seqNo: customer.seqNo });
      step = 'complete';
      const outcome = await this.complete(key, result, runId);
      if (outcome !== 'sent') await this.markError(customer);
      return { outcome, technical: false };
    } catch (error) {
      // Only an error class name or an Oracle code is stored, never a message (it could hold customer data).
      const code = isTechnical(error)
        ? oraCode(error)
        : error instanceof Error
          ? error.name
          : 'Error';
      this.logger.error({ event: 'flexcube.trigger.failed', runId, step, error: code });
      if (step === 'submit') {
        // REIS may have been called: E, never resent, sending stops until reconciled.
        this.halt(runId);
        await this.staging
          .fail(key, { error: oraCode(error), delivery: 'UNCERTAIN' })
          .catch(() => false);
        await this.markError(customer);
        return { outcome: 'failed', technical: false };
      }
      if (step === 'complete') {
        // REIS answered but the result could not be stored: leave W (send guard stops sending).
        this.halt(runId);
        return { outcome: 'failed', technical: true };
      }
      if (isTechnical(error)) {
        // Database / driver problem before REIS: give the claim back, trigger stays U (or P -> E if picked).
        if (claimed && !picked) await this.staging.release(key).catch(() => false);
        if (picked) await this.markError(customer);
        return { outcome: 'failed', technical: true };
      }
      // The KYC data itself cannot be processed (missing details, CIF mismatch): E, a person corrects it.
      if (claimed) await this.staging.fail(key, { error: code.slice(0, 60) }).catch(() => false);
      await this.markError(customer);
      return { outcome: 'failed', technical: false };
    }
  }

  private async complete(
    key: StagingKey,
    result: KycSubmissionResult,
    runId: string,
  ): Promise<Outcome> {
    switch (result.outcome) {
      case 'ONBOARDED':
        await this.staging.complete(key, {
          status: StagingProcessStatus.SUCCESS,
          request: result.reisRequest,
          response: result.reisResponse,
        });
        return 'sent';
      case 'FAILED': {
        const uncertain = result.requestMayHaveReachedReis;
        if (uncertain) this.halt(runId);
        await this.staging.complete(key, {
          status: StagingProcessStatus.ERROR,
          request: result.reisRequest,
          response: {
            error: result.code,
            stage: result.stage,
            ...(uncertain ? { delivery: 'UNCERTAIN' } : {}),
          },
        });
        return 'failed';
      }
      case 'DUPLICATE': {
        const uncertain = UNCERTAIN_DUPLICATES.has(result.reason);
        if (uncertain) this.halt(runId);
        await this.staging.complete(key, {
          status: StagingProcessStatus.ERROR,
          response: {
            error: 'DUPLICATE',
            reason: result.reason,
            ...(uncertain ? { delivery: 'UNCERTAIN' } : {}),
          },
        });
        return 'failed';
      }
    }
  }

  private async refuse(
    customer: ReadyCustomer,
    runId: string,
    reason: string,
  ): Promise<{ outcome: Outcome; technical: boolean }> {
    this.logger.warn({ event: 'flexcube.trigger.refused', runId, reason });
    await this.markError(customer);
    return { outcome: 'skipped', technical: false };
  }

  private async markError(customer: ReadyCustomer): Promise<void> {
    await this.triggers.markError(customer).catch(() => false);
  }

  private halt(runId: string): void {
    if (!this.haltedInProcess)
      this.logger.error({ event: 'flexcube.trigger.haltingAfterUncertainDelivery', runId });
    this.haltedInProcess = true;
    this.sendingHalted = true;
  }

  /** Nothing is sent while a delivery is unresolved, or when that cannot be checked. */
  private async deliveryUnresolved(runId: string): Promise<boolean> {
    if (this.haltedInProcess) return true;
    let risky: StagingKey[];
    try {
      risky = await this.staging.findDeliveryRisk(TRIGGER_DELIVERY_RISK_MINUTES, 50);
    } catch (error) {
      this.sendingHalted = true;
      this.logger.error({
        event: 'flexcube.trigger.sendingHalted',
        runId,
        reason: 'CHECK_FAILED',
        error: oraCode(error),
      });
      return true;
    }
    const open = risky.filter((k) => !this.acknowledged.has(`${k.kycRefNo}/${k.seqNo}`));
    this.sendingHalted = open.length > 0;
    if (open.length > 0) {
      this.logger.error({
        event: 'flexcube.trigger.sendingHalted',
        runId,
        reason: 'DELIVERY_UNCERTAIN',
        unresolvedRows: open.length,
      });
    }
    return open.length > 0;
  }
}
