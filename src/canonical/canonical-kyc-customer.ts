import { CanonicalRelatedPerson } from './canonical-related-person';
import { CustomerType } from './customer-type';

/**
 * Canonical (internal) KYC model between FLEXCUBE DTOs and REIS DTOs, so neither side is
 * coupled to the other.
 *
 * Reference-data fields (nationality, profession, product, ...) hold the FLEXCUBE-side value
 * UNTRANSLATED; translation to REIS values happens in the canonical -> REIS transformer through
 * IReferenceMappingService. Dates are already normalized to YYYY-MM-DD (REIS format) and numbers
 * are real numbers. REIS-only duplicates (nationality_customer, citizenship_customer, corporate
 * nationality) are NOT stored here: the transformer derives them.
 */
export interface CanonicalKycBase {
  readonly customerType: CustomerType;
  /** FLEXCUBE KYC_REF_NO. Current correlation value, sent to REIS as systemId. */
  kycRefNo: string;
  /** FLEXCUBE CUSTOMER_NO. Null until the customer is created in FLEXCUBE. */
  customerNo: string | null;
  accountManagerLogin: string;
  accountManagerEmail: string;
  /** FLEXCUBE Y/N converted to boolean. */
  pep: boolean;
  /** Raw FLEXCUBE PRODUCT_CODE values (ACCOUNT_CLASS is reference only). REIS product is an array. */
  productCodes: string[];
  distributionChannel: string;
}

export interface CanonicalIndividualCustomer extends CanonicalKycBase {
  readonly customerType: CustomerType.INDIVIDUAL;
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD. Source: STTM_KYC_RETAIL.BIRTH_DATE (mandatory). */
  birthDate: string;
  birthPlace?: string;
  /**
   * Raw FLEXCUBE free-text document field. REIS "tin" is an ID document TYPE code, so this is
   * never sent as-is: it must resolve through the DOCUMENT_TYPE mapping (approved list TBD).
   */
  documentTypeRaw?: string;
  /** ID document number (REIS nid). Kept separate from the document type. */
  nid?: string;
  /** YYYY-MM-DD (issue_date was removed from REIS V1.3/V1.4 and is not carried). */
  expiryDate?: string;
  relationPep: boolean;
  /** Raw FLEXCUBE value; REIS nationality_customer and nationality are both derived from it. */
  nationality: string;
  /** Raw FLEXCUBE value; REIS citizenship_customer and citizenship are both derived from it. */
  citizenship: string;
  profession: string;
  accountPurpose: string;
  /** Interpreted resident flag (REIS resident "1" = true, "2" = false). */
  isResident: boolean;
  /** FLEXCUBE FUND_SOURCE (single value per mapping V2_5), carried as a one-element list. */
  selectedIncomeSources: string[];
  /** Numeric (REIS m_income is numeric). */
  monthlyIncome: number;
}

export interface CanonicalCorporateCustomer extends CanonicalKycBase {
  readonly customerType: CustomerType.CORPORATE;
  /** FLEXCUBE STTM_KYC_CORPORATE_CUSTOM.CRP_BUSINESS_NAME (confirmed mapping to REIS business_name). */
  businessName: string;
  tradeNo?: string;
  /** Raw FLEXCUBE PARENT_CMPNY_COUNTRY; REIS incorp_country, and nationality, derive from it. */
  incorporationCountry: string;
  /** Raw country values; REIS operation_country is an ARRAY. */
  operationCountries: string[];
  legalEntity: string;
  activity: string;
  /** Corporate account purpose (values such as 203/204 still need Bank verification). */
  accountPurpose: string;
  /** Single raw FLEXCUBE source-of-income value. */
  sourceOfIncome: string;
  /** Numeric (REIS fin_info is numeric). */
  financialInfo: number;
  /** Related parties (key persons); sent in the same REIS call. Absent = none. */
  relatedPersons?: CanonicalRelatedPerson[];
}

export type CanonicalKycCustomer = CanonicalIndividualCustomer | CanonicalCorporateCustomer;
