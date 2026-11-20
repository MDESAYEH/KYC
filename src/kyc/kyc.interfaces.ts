import { FlexcubeCustomerRequest } from '../flexcube/dto/flexcube-customer.request';
import { KycSubmissionResult } from './kyc-submission.result';

export interface SubmitOptions {
  /** Staging SEQ_NO of the submission (= STTM_CUSTOMER.MOD_NO). A higher one than stored is an amendment. */
  seqNo: number;
  /** Recheck after REIS refused the data: a FAILED_PERMANENT case of this revision may be sent again. */
  afterRejection?: boolean;
}

/**
 * Takes one FLEXCUBE request through mapper -> transformer -> persistence -> REIS onboarding. Returns a typed
 * result for the expected outcomes and throws only for unexpected infrastructure errors.
 */
export interface IKycWorkflow {
  submit(request: FlexcubeCustomerRequest, options: SubmitOptions): Promise<KycSubmissionResult>;
  /** The REIS request the submission would send (mapping + transformation only, nothing stored or sent). */
  preview(request: FlexcubeCustomerRequest): Promise<object>;
}
