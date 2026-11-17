import { Injectable } from '@nestjs/common';
import { KycRequestStatus } from '../common/kyc-status';
import { FlexcubeCustomerRequest } from '../flexcube/dto/flexcube-customer.request';
import { CifIdentityError, requireCif } from '../reis/cif-identity';
import { IKycWorkflow } from './kyc.interfaces';
import { SubmissionFailed } from './kyc-submission.result';

/**
 * Fail-closed application entry point while CIF provenance/cutover are unresolved.
 * No injected database, REIS client, legacy workflow, or config switch can bypass the hold.
 * Callbacks for existing submissions remain available through their separate module.
 */
@Injectable()
export class CifSubmissionHoldWorkflow implements IKycWorkflow {
  async submit(request: FlexcubeCustomerRequest): Promise<SubmissionFailed> {
    try {
      requireCif(request?.CUSTOMER_NO);
    } catch (error) {
      if (!(error instanceof CifIdentityError)) throw error;
      return this.refused(error.code);
    }
    return this.refused('CIF_CUTOVER_NOT_APPROVED');
  }

  private refused(code: CifIdentityError['code']): SubmissionFailed {
    return {
      outcome: 'FAILED',
      stage: 'VALIDATION',
      code,
      requestMayHaveReachedReis: false,
      persistedStatus: KycRequestStatus.VALIDATION_FAILED,
      kycCase: null,
    };
  }
}
