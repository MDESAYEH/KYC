import { ReisFinalStatus } from '../../reis/reis-status';

/** What the status updater receives. */
export interface FlexcubeStatusUpdate {
  kycRefNo: string;
  customerNo: string | null;
  finalStatus: ReisFinalStatus;
  reisCustomerId?: number;
  /**
   * The exact submission (staging SEQ_NO) the decision belongs to: REQUIRED. Only that revision is updated; there
   * is no "latest revision" fallback (a delayed decision of revision 2 must never reach revision 3).
   */
  seqNo: number;
  /** Internal idempotency key so a real updater can safely ignore duplicates. */
  idempotencyKey: string;
}
