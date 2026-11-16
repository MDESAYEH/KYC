import { FlexcubeCustomerRequest } from '../flexcube/dto/flexcube-customer.request';
import { KycSubmissionResult } from './kyc-submission.result';

/**
 * Orchestration entry point. `submit` takes the provisional FLEXCUBE request through
 * mapper -> transformer -> persistence -> REIS onboarding. It returns a typed result for the
 * expected outcomes (onboarded CLEAN/PENDING/REJECT, duplicate, classified failure) and throws
 * only for unexpected infrastructure errors. The /customerStatus handling arrives in a later step.
 */
export interface SubmitOptions {
  /**
   * FLEXCUBE submission sequence (staging SEQ_NO, default 1). A higher SEQ_NO than the stored one
   * is an amendment: it is sent to REIS again (same systemId) once the previous one is closed.
   */
  seqNo?: number;
}

export interface IKycWorkflow {
  submit(request: FlexcubeCustomerRequest, options?: SubmitOptions): Promise<KycSubmissionResult>;
}
export const KYC_WORKFLOW = Symbol('IKycWorkflow');
