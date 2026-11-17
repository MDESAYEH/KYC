import { CanonicalKycCustomer } from '../canonical';
import { InvalidFieldValueError } from '../canonical/transformation.errors';
import { ICanonicalToReisTransformer } from './reis.interfaces';
import { requireCif } from './cif-identity';

/**
 * Offline preparation only. Not registered in Nest and not an onboarding-client input.
 * Reuses the existing field mappings while keeping the original KYC reference intact.
 * CUSTOMER_NO provenance and lifecycle are NOT verified by a successful preview.
 */
export class CifOnboardingPreview {
  constructor(private readonly fields: ICanonicalToReisTransformer) {}

  async preview(customer: CanonicalKycCustomer) {
    const systemId = requireCif(customer.customerNo);
    const baseline = await this.fields.transform(customer);
    if (baseline.relations.some((relation) => relation.systemId === systemId)) {
      throw new InvalidFieldValueError('relation.systemId', 'collides with the primary CIF');
    return {
      submissionAllowed: false as const,
      sourceVerified: false as const,
      request: { ...baseline, systemId },
    };
  }
}
