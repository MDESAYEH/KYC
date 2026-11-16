import { ReisFinalStatus } from '../../reis/reis-status';

/** What the status updater receives. The FLEXCUBE-side mechanism (table/API) is TBD. */
export interface FlexcubeStatusUpdate {
  kycRefNo: string;
  customerNo: string | null;
  finalStatus: ReisFinalStatus;
  reisCustomerId?: number;
  /** Internal idempotency key so a real updater can safely ignore duplicates. */
  idempotencyKey: string;
}
