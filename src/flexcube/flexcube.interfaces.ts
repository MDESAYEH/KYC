import { CanonicalKycCustomer } from '../canonical';
import { FlexcubeCustomerRequest } from './dto/flexcube-customer.request';
import { FlexcubeStatusUpdate } from './dto/flexcube-status-update';

/** FLEXCUBE inbound DTO -> canonical model. Contract is provisional. */
export interface IFlexcubeToCanonicalMapper {
  map(request: FlexcubeCustomerRequest): CanonicalKycCustomer;
}
export const FLEXCUBE_TO_CANONICAL_MAPPER = Symbol('IFlexcubeToCanonicalMapper');

/**
 * Writes the final KYC result back to FLEXCUBE. The real mechanism is TBD (open item 7);
 * a mock implementation is used until the FLEXCUBE team provides it.
 */
export interface IFlexcubeStatusUpdater {
  updateStatus(update: FlexcubeStatusUpdate): Promise<void>;
}
export const FLEXCUBE_STATUS_UPDATER = Symbol('IFlexcubeStatusUpdater');
