import { Logger } from '@nestjs/common';
import { FlexcubeStatusUpdate } from '../dto/flexcube-status-update';
import { IFlexcubeStatusUpdater } from '../flexcube.interfaces';
import {
  assertSafeTableName,
  DecisionValues,
  decisionValues,
  FinalStatusVocabulary,
  IFlexcubeSqlExecutor,
  toStagingFinalStatus,
} from './flexcube-staging';

/** No staging row could be updated for the KYC (missing row, or a different final status). */
export class StagingRowNotUpdatedError extends Error {
  constructor(readonly kycRefNo: string) {
    super('No staging row was updated for the KYC (the reference is not repeated here)');
    this.name = 'StagingRowNotUpdatedError';
  }
}

/** The update names no exact submission (SEQ_NO): refused, there is no "latest revision" fallback. */
export class StagingRevisionRequiredError extends Error {
  constructor() {
    super('A staging status update needs the exact submission (SEQ_NO); none was given');
    this.name = 'StagingRevisionRequiredError';
  }
}

/**
 * Writes the final REIS decision to REIS_FINAL_STATUS of the EXACT submission (SEQ_NO) the case was sent as, never
 * of "the latest" one. Idempotent: writing the same status twice succeeds; a different status already
 * stored is never overwritten (0 rows -> StagingRowNotUpdatedError, so the case is FAILED and
 * goes to operator recovery). FLEXCUBE then authorizes, or not, the KYC (Finexta side).
 */
export class StagingFlexcubeStatusUpdater implements IFlexcubeStatusUpdater {
  private readonly logger = new Logger(StagingFlexcubeStatusUpdater.name);
  private readonly exactSql: string;
  private readonly words: DecisionValues;

  constructor(
    private readonly db: IFlexcubeSqlExecutor,
    table: string,
    private readonly vocabulary: FinalStatusVocabulary = 'approved-blocked',
  ) {
    const t = assertSafeTableName(table);
    this.words = decisionValues(vocabulary);
    // A final decision may replace the interim PENDING (only in the vocabulary that writes it); it never
    // replaces another final decision.
    const replaceable = this.words.pending !== null ? ' OR REIS_FINAL_STATUS = :pendingStatus' : '';
    const guard = `AND (REIS_FINAL_STATUS IS NULL OR REIS_FINAL_STATUS = :finalStatus${replaceable})`;
    this.exactSql =
      `UPDATE ${t} SET REIS_FINAL_STATUS = :finalStatus ` +
      `WHERE KYC_REF_NO = :kycRefNo AND SEQ_NO = :seqNo ` +
      guard;
  }

  async updateStatus(update: FlexcubeStatusUpdate): Promise<void> {
    if (!Number.isInteger(update.seqNo)) throw new StagingRevisionRequiredError();
    const status = toStagingFinalStatus(update.finalStatus, this.vocabulary);
    const binds: Record<string, string | number> = {
      finalStatus: status,
      kycRefNo: update.kycRefNo,
      seqNo: update.seqNo,
    };
    if (this.words.pending !== null) binds.pendingStatus = this.words.pending;
    const { rowsAffected } = await this.db.execute(this.exactSql, binds);
    if (rowsAffected !== 1) throw new StagingRowNotUpdatedError(update.kycRefNo);
    this.logger.log({ event: 'flexcube.staging.finalStatus', status });
  }
}
