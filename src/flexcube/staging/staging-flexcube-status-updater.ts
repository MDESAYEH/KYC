import { Logger } from '@nestjs/common';
import { FlexcubeStatusUpdate } from '../dto/flexcube-status-update';
import { IFlexcubeStatusUpdater } from '../flexcube.interfaces';
import {
  assertSafeTableName,
  IFlexcubeSqlExecutor,
  toStagingFinalStatus,
} from './flexcube-staging';

/** No staging row could be updated for the KYC (missing row, or a different final status). */
export class StagingRowNotUpdatedError extends Error {
  constructor(readonly kycRefNo: string) {
    super(`No staging row updated for KYC ${kycRefNo}`);
    this.name = 'StagingRowNotUpdatedError';
  }
}

/**
 * Writes the final REIS decision to REIS_FINAL_STATUS of the latest submission (highest SEQ_NO)
 * of the KYC. Idempotent: writing the same status twice succeeds; a different status already
 * stored is never overwritten (0 rows -> StagingRowNotUpdatedError, so the case is FAILED and
 * goes to operator recovery). FLEXCUBE then authorizes, or not, the KYC (Finexta side).
 */
export class StagingFlexcubeStatusUpdater implements IFlexcubeStatusUpdater {
  private readonly logger = new Logger(StagingFlexcubeStatusUpdater.name);
  private readonly sql: string;

  constructor(
    private readonly db: IFlexcubeSqlExecutor,
    table: string,
  ) {
    const t = assertSafeTableName(table);
    this.sql =
      `UPDATE ${t} SET REIS_FINAL_STATUS = :status ` +
      `WHERE KYC_REF_NO = :kycRefNo ` +
      `AND SEQ_NO = (SELECT MAX(SEQ_NO) FROM ${t} WHERE KYC_REF_NO = :kycRefNo) ` +
      `AND (REIS_FINAL_STATUS IS NULL OR REIS_FINAL_STATUS = :status)`;
  }

  async updateStatus(update: FlexcubeStatusUpdate): Promise<void> {
    const status = toStagingFinalStatus(update.finalStatus);
    const { rowsAffected } = await this.db.execute(this.sql, {
      status,
      kycRefNo: update.kycRefNo,
    });
    if (rowsAffected !== 1) throw new StagingRowNotUpdatedError(update.kycRefNo);
    this.logger.log({ event: 'flexcube.staging.finalStatus', kycRefNo: update.kycRefNo, status });
  }
}
