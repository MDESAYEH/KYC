import { FlexcubeCustomerRequest } from '../flexcube/dto/flexcube-customer.request';
import { KycSubmissionResult } from './kyc-submission.result';

export interface SubmitOptions {
  /** Staging SEQ_NO of the submission (= STTM_CUSTOMER.MOD_NO). A higher one than stored is an amendment. */
  seqNo: number;
}

/**
 * Takes one FLEXCUBE request through mapper -> transformer -> persistence -> REIS onboarding. Returns a typed
 * result for the expected outcomes and throws only for unexpected infrastructure errors.
 */
export interface IKycWorkflow {
  submit(request: FlexcubeCustomerRequest, options: SubmitOptions): Promise<KycSubmissionResult>;
  /** The REIS request the submission would send (mapping + transformation only, nothing stored or sent). */
  preview(request: FlexcubeCustomerRequest): Promise<object>;
  /** REIS' onboarding answer kept on the local case of this revision, or null. */
  storedAnswer(kycRefNo: string, seqNo: number): Promise<object | null>;
}
