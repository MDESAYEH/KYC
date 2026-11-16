import { Equals, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ReisFinalStatus } from '../../reis/reis-status';

/** The only ServiceType in the current REIS sample. Final callback schema approval is pending. */
export const CUSTOMER_STATUS_SERVICE_TYPE = 'CUSTOMER_STATUS';

/**
 * REIS -> bank POST /customerStatus payload (current sample):
 *   { "status": "BLOCKED", "systemId": "2378287", "customerId": 217489,
 *     "systemName": "Flexcube", "ServiceType": "CUSTOMER_STATUS" }
 *
 * CONFIRMED: status is CUSTOMER or BLOCKED only; systemId echoes our KYC_REF_NO.
 * PROVISIONAL (schema not finally approved): customerId optional/nullable, systemName and
 * ServiceType optional, ServiceType validated against the sample value when present. systemId is
 * strictly a string (no coercion). Unknown extra fields are ignored and never stored.
 */
export class CustomerStatusDto {
  @IsEnum(ReisFinalStatus) status: ReisFinalStatus;
  /** Echo of the systemId we sent (= KYC_REF_NO). */
  @IsString() @IsNotEmpty() systemId: string;
  /** REIS customer id (NOT the FLEXCUBE CUSTOMER_NO). */
  @IsOptional() @IsInt() customerId?: number | null;
  @IsOptional() @IsString() systemName?: string;
  @IsOptional() @Equals(CUSTOMER_STATUS_SERVICE_TYPE) ServiceType?: string;
}
