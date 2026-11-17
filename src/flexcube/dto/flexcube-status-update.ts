import { ReisFinalStatus } from '../../reis/reis-status';

/** What the status updater receives. The FLEXCUBE-side mechanism (table/API) is TBD. */
export interface FlexcubeStatusUpdate {
  kycRefNo: string;
  customerNo: string | null;
  finalStatus: ReisFinalStatus;
  reisCustomerId?: number;
  /**
   * The exact submission (staging SEQ_NO) the decision belongs to. When given, only that revision is
   * updated; when absent the latest SEQ_NO of the KYC is (historical behavior).
   */
  seqNo?: number;
  /** Internal idempotency key so a real updater can safely ignore duplicates. */
  idempotencyKey: string;
}
