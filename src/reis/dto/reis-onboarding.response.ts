import { ReisOnboardingStatus } from '../reis-status';

/**
 * Validated result of searchOnboardCustomer. Only fields evidenced by the V1.2 documentation
 * and the working Postman collection are modelled (status, reisId, riskCalculationId,
 * errorMessage) plus `instruction` from the FLEXCUBE integration document. Wire types for the
 * ids are kept as received (string or number). Undocumented fields are dropped, not modelled.
 *
 * A response carrying a non-blank errorMessage is NOT returned as this type: the client
 * raises ReisApplicationError instead.
 */
export interface ReisOnboardingResponse {
  status: ReisOnboardingStatus;
  riskCalculationId?: string | number | null;
  reisId?: string | number | null;
  instruction?: string | null;
  errorMessage?: string | null;
}
