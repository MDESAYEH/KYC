import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { IKycWorkflow } from '../kyc/kyc.interfaces';
import { KycSubmissionResult } from '../kyc/kyc-submission.result';
import { FlexcubeKycSource, PendingKyc } from '../flexcube/source/flexcube-kyc-source';
import {
  StagingProcessStatus,
  StagingSubmissionRepository,
} from '../flexcube/staging/staging-submission.repository';

export interface SyncRunSummary {
  found: number;
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * One polling pass (agreed architecture: the integration layer reads FLEXCUBE, nothing calls in):
 *
 *   saved KYC (open (RECORD_STAT = O) since the cut-off, no staging row for its MOD_NO)
 *     -> staging row N -> claimed W -> read STTM tables -> workflow (REIS)
 *     -> S (REIS answered; CLEAN / REJECT final status written by the workflow)
 *     -> E (anything else; RETRY_COUNT + 1). E rows are NOT retried automatically (limit TBD).
 *
 * The staging RESPONSE of a failure holds only a technical code, never personal data.
 */
export class FlexcubeSyncService {
  private readonly logger = new Logger(FlexcubeSyncService.name);

  constructor(
    private readonly source: FlexcubeKycSource,
    private readonly staging: StagingSubmissionRepository,
    private readonly workflow: IKycWorkflow,
    private readonly batchSize: number,
  ) {}

  async runOnce(): Promise<SyncRunSummary> {
    const pending = await this.source.findPending(this.batchSize);
    const summary: SyncRunSummary = { found: pending.length, sent: 0, failed: 0, skipped: 0 };
    for (const kyc of pending) {
      const outcome = await this.processOne(kyc);
      summary[outcome]++;
    }
    if (pending.length > 0) this.logger.log({ event: 'flexcube.sync.run', ...summary });
    return summary;
  }

  private async processOne(kyc: PendingKyc): Promise<'sent' | 'failed' | 'skipped'> {
    const key = { kycRefNo: kyc.kycRefNo, seqNo: kyc.seqNo };
    if (!Number.isInteger(kyc.seqNo) || kyc.seqNo < 1) {
      this.logger.warn({ event: 'flexcube.sync.invalidSeqNo', kycRefNo: kyc.kycRefNo });
      return 'skipped';
    }
    // Another instance may have taken it: insert and claim are both conditional.
    if (!(await this.staging.insertNew(key, randomUUID()))) return 'skipped';
    if (!(await this.staging.claim(key))) return 'skipped';

    let result: KycSubmissionResult;
    try {
      const request = await this.source.load(kyc);
      result = await this.workflow.submit(request, { seqNo: kyc.seqNo });
    } catch (error) {
      this.logger.error({
        event: 'flexcube.sync.unexpectedError',
        kycRefNo: kyc.kycRefNo,
        seqNo: kyc.seqNo,
        error: error instanceof Error ? error.name : 'Error',
      });
      await this.staging.complete(key, {
        status: StagingProcessStatus.ERROR,
        response: { error: error instanceof Error ? error.name : 'UNEXPECTED_ERROR' },
      });
      return 'failed';
    }

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
}
