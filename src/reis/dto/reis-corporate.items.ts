/**
 * Business fields of a Corporate onboarding request (REIS KYC V1.2, formId 2), carried inside
 * `items` of the onboarding envelope. The field definitions are confirmed by V1.2; the wire
 * serialization is DERIVED from that contract and the Individual Postman example and still
 * needs UAT verification with a real Corporate request.
 */
export interface ReisCorporateItems {
  entity_type: 'PM';
  business_name: string;
  account_manager_login: string;
  account_manager_email: string;
  pep: boolean;
  incorp_country: string;
  /** Same value as incorp_country (V1.2). */
  nationality: string;
  /** REIS array semantics: a list of country codes. */
  operation_country: string[];
  legal_entity: string;
  activity: string;
  account_purpose_organization: string;
  /** String per V1.2. */
  source_income_organization: string;
  distribution_channel: string;
  /** Always an array, even for a single product (V1.4). */
  product: string[];
  /** Numeric per V1.2. */
  fin_info: number;
  // optional
  trade_no?: string;
}
