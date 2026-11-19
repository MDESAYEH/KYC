import { CanonicalKycCustomer } from '../canonical';
import { FlexcubeCustomerRequest } from '../flexcube/dto/flexcube-customer.request';
import {
  IFlexcubeStatusUpdater,
  IFlexcubeToCanonicalMapper,
} from '../flexcube/flexcube.interfaces';
import { IKycCaseRepository } from '../persistence/persistence.interfaces';
import { CifIdentityError, requireCif } from '../reis/cif-identity';
import { CifOnboardingPreview } from '../reis/cif-onboarding-preview';
import { ReisOnboardingRequest } from '../reis/dto';
import { ICanonicalToReisTransformer, IReisOnboardingClient } from '../reis/reis.interfaces';
import { KycWorkflow } from './kyc.workflow';

/**
 * The submission workflow with the agreed identity: REIS systemId = the FLEXCUBE CIF (CUSTOMER_NO), as in the
 * single-KYC trial that came back CLEAN on 19/11/2026. Same steps, idempotency and failure handling as
 * KycWorkflow; only the identity differs:
 *  - the request must carry CUSTOMER_NO (the trigger-table poller sets it from STTM_CUSTOMER_CUSTOM);
 *  - the REIS request is the field mapping with systemId replaced by the CIF (CifOnboardingPreview), which also
 *    refuses a related party whose systemId would collide with the CIF;
 *  - the local case is created with reis_system_id = CIF, so the REIS callback (systemId = CIF) finds it.
 * KYC_REF_NO stays the internal key (case, staging row KYC_REF_NO + SEQ_NO).
 */
export class CifKycWorkflow extends KycWorkflow {
  private readonly preview: CifOnboardingPreview;

  constructor(
    mapper: IFlexcubeToCanonicalMapper,
    transformer: ICanonicalToReisTransformer,
    cases: IKycCaseRepository,
    reis: IReisOnboardingClient,
    flexcube: IFlexcubeStatusUpdater,
  ) {
    super(mapper, transformer, cases, reis, flexcube);
    this.preview = new CifOnboardingPreview(transformer);
  }

  protected override async toReisRequest(
    canonical: CanonicalKycCustomer,
  ): Promise<ReisOnboardingRequest> {
    return (await this.preview.preview(canonical)).request as ReisOnboardingRequest;
  }

  protected override identityOf(request: FlexcubeCustomerRequest): string | null {
    try {
      return requireCif(request?.CUSTOMER_NO);
    } catch (error) {
      if (error instanceof CifIdentityError) return null;
      throw error;
    }
  }
}
