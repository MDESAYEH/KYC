import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { oraCode } from '../flexcube/oracle-error';
import { IKycWorkflow } from '../kyc/kyc.interfaces';
import { KycSubmissionResult } from '../kyc/kyc-submission.result';
import { FlexcubeKycSource, PendingKyc } from '../flexcube/source/flexcube-kyc-source';
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

type Outcome = 'sent' | 'failed' | 'skipped';

/** A row claimed for longer than this is reported (flexcube.sync.stuckInProgress), never resent. */
export const STUCK_IN_PROGRESS_MINUTES = 15;

/**
 * One polling pass (agreed architecture: the integration layer reads FLEXCUBE, nothing calls in):
 *
 *   open KYC since the cut-off, no staging row for its MOD_NO
 *     -> staging row N -> claimed W -> read STTM tables -> workflow (REIS)
 *     -> S (REIS answered; CLEAN / REJECT final status written by the workflow)
 *     -> E (anything else; RETRY_COUNT + 1). E rows are NOT retried automatically (limit TBD).
 *
 * One KYC never stops the pass: every error after the pending query is handled for that KYC only
 * (logged with its Oracle code, the row marked E when possible) and the next KYC is processed.
 * Only an error in the pending query itself fails the whole pass.
 *
 * The staging RESPONSE of a failure holds only a technical code, never personal data.
 */
export class FlexcubeSyncService {
  private readonly logger = new Logger(FlexcubeSyncService.name);
  private readonly reportedStuck = new Set<string>();

  constructor(
    private readonly source: FlexcubeKycSource,
    private readonly staging: StagingSubmissionRepository,
    private readonly workflow: IKycWorkflow,
    private readonly batchSize: number,
  ) {}

  async runOnce(): Promise<SyncRunSummary> {
    // Our own rows left at N by an earlier failed pass go first (same claim -> load -> submit path).
    const stuck = await this.safely('recover', () => this.source.findOwnStuckNew(this.batchSize));
    await this.reportStuckInProgress();
    const pending = await this.source.findPending(this.batchSize);
    const summary: SyncRunSummary = {
      found: stuck.length + pending.length,
      sent: 0,
      failed: 0,
      skipped: 0,
    };
    for (const kyc of stuck) summary[await this.processOne(kyc, true)]++;
    for (const kyc of pending) summary[await this.processOne(kyc, false)]++;
    if (summary.found > 0) this.logger.log({ event: 'flexcube.sync.run', ...summary });
    return summary;
  }

  /** Only logged (once per process and row): a half-sent submission is never resent automatically. */
  private async reportStuckInProgress(): Promise<void> {
    const rows = await this.safely('stuckCheck', () =>
      this.staging.findStuckInProgress(STUCK_IN_PROGRESS_MINUTES, 50),
    );
    for (const row of rows) {
      const id = `${row.kycRefNo}/${row.seqNo}`;
      if (this.reportedStuck.has(id)) continue;
      this.reportedStuck.add(id);
      this.logger.warn({
        event: 'flexcube.sync.stuckInProgress',
        kycRefNo: row.kycRefNo,
        seqNo: row.seqNo,
      });
    }
  }

  /** A failing helper query is logged with its code and never fails the pass. */
  private async safely<T>(what: string, run: () => Promise<T[]>): Promise<T[]> {
    try {
      return await run();
    } catch (error) {
      this.logger.error({ event: `flexcube.sync.${what}Failed`, error: oraCode(error) });
      return [];
    }
  }

  /** Never throws: a failure is logged and, when a staging row exists, the row is marked E. */
  private async processOne(kyc: PendingKyc, recovering: boolean): Promise<Outcome> {
    const key: StagingKey = { kycRefNo: kyc.kycRefNo, seqNo: kyc.seqNo };
    if (!Number.isInteger(kyc.seqNo) || kyc.seqNo < 1) {
      this.logger.warn({ event: 'flexcube.sync.invalidSeqNo', kycRefNo: kyc.kycRefNo });
      return 'skipped';
    }
    let step: SyncStep = 'insert';
    try {
      // Another instance may have taken it: insert and claim are both conditional.
      // A recovered row already exists (left at N): it goes straight to the claim.
      if (!recovering && !(await this.staging.insertNew(key, randomUUID()))) return 'skipped';
      step = 'claim';
      if (!(await this.staging.claim(key))) return 'skipped';
      step = 'load';
      const request = await this.source.load(kyc);
      step = 'submit';
      const result = await this.workflow.submit(request, { seqNo: kyc.seqNo });
      step = 'complete';
      return await this.complete(key, result);
    } catch (error) {
      return this.handleFailure(key, step, error);
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

  /** Logs the error code (never the message), then tries to mark the row E; neither may throw. */
  private async handleFailure(key: StagingKey, step: SyncStep, error: unknown): Promise<'failed'> {
    const code = oraCode(error);
    this.logger.error({
      event: 'flexcube.sync.kycFailed',
      kycRefNo: key.kycRefNo,
      seqNo: key.seqNo,
      step,
      error: code,
    });
    // At the insert step no row exists, so there is nothing to mark.
    if (step !== 'insert') {
      try {
        await this.staging.fail(key, { error: code });
      } catch (markError) {
        this.logger.error({
          event: 'flexcube.sync.markErrorFailed',
          kycRefNo: key.kycRefNo,
          seqNo: key.seqNo,
          step,
          error: oraCode(markError),
        });
      }
    }
    return 'failed';
  }
}
