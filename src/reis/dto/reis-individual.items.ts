/**
 * Business fields of an Individual onboarding request (REIS KYC V1.4, formId 1). These travel
 * INSIDE `items` of the onboarding envelope - `entity_type` included (confirmed by the working
 * Postman). systemName / systemId / formId / relations live on the envelope, not here.
 * Coded fields are strings (REIS codes after mapping); dates are YYYY-MM-DD; m_income is numeric.
 */
export interface ReisIndividualItems {
  entity_type: 'PP';
  first_name: string;
  last_name: string;
  /** YYYY-MM-DD */
  cus_birth_date: string;
  account_manager_login: string;
  account_manager_email: string;
  pep: boolean;
  relation_pep: boolean;
  nationality_customer: string;
  /** Same value as nationality_customer. */
  nationality: string;
  citizenship_customer: string;
  /** Same value as citizenship_customer. */
  citizenship: string;
  profession: string;
  account_purpose_individual: string;
  /** "1" = resident, "2" = non-resident. */
  resident: '1' | '2';
  distribution_channel: string;
  /** Always an array, even for a single product (V1.4). */
  product: string[];
  /** String per V1.2. */
  source_income_individual: string;
  /** Numeric per V1.2. */
  m_income: number;
  // optional
  birth_place?: string;
  /** ID document TYPE code - only an approved (mapped) REIS code may be sent. */
  tin?: string;
  /** ID document number. */
  nid?: string;
  /** YYYY-MM-DD */
  expiry_date?: string;
}
