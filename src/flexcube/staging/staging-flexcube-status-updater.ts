import { Logger } from '@nestjs/common';
import { FlexcubeStatusUpdate } from '../dto/flexcube-status-update';
import { IFlexcubeStatusUpdater } from '../flexcube.interfaces';
import {
  assertSafeTableName,
  IFlexcubeSqlExecutor,
  StagingFinalStatus,
  toStagingFinalStatus,
} from './flexcube-staging';

/** No staging row could be updated for the KYC (missing row, or a different final status). */
export class StagingRowNotUpdatedError extends Error {
  constructor() {
    super('No staging row was updated for the KYC');
    this.name = 'StagingRowNotUpdatedError';
  }
}

/** The update names no exact submission (SEQ_NO). */
export class StagingRevisionRequiredError extends Error {
  constructor() {
    super('A staging status update needs the exact submission (SEQ_NO)');
    this.name = 'StagingRevisionRequiredError';
  }
}

/**
 * Writes the REIS decision to REIS_FINAL_STATUS of the exact submission (KYC_REF_NO + SEQ_NO).
 * Idempotent: the same status twice succeeds; another final decision already stored is never overwritten.
 */
export class StagingFlexcubeStatusUpdater implements IFlexcubeStatusUpdater {
  private readonly logger = new Logger(StagingFlexcubeStatusUpdater.name);
  private readonly sql: string;

  constructor(
    private readonly db: IFlexcubeSqlExecutor,
    table: string,
  ) {
    this.sql =
      `UPDATE ${assertSafeTableName(table)} SET REIS_FINAL_STATUS = :finalStatus ` +
      `WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo AND (REIS_FINAL_STATUS IS NULL ` +
      `OR REIS_FINAL_STATUS = :finalStatus OR REIS_FINAL_STATUS = :pendingStatus)`;
  }

  async updateStatus(update: FlexcubeStatusUpdate): Promise<void> {
    if (!Number.isInteger(update.seqNo)) throw new StagingRevisionRequiredError();
    const status = toStagingFinalStatus(update.finalStatus);
    const { rowsAffected } = await this.db.execute(this.sql, {
      finalStatus: status,
      pendingStatus: StagingFinalStatus.PENDING,
      kycRefNo: update.kycRefNo,
      seqNo: update.seqNo,
    });
    if (rowsAffected !== 1) throw new StagingRowNotUpdatedError();
    this.logger.log({ event: 'flexcube.staging.finalStatus', status });
  }
}
