import { CustomerType } from './customer-type';

/**
 * Related parties of an ORGANIZATION customer (DFS V1.8: relationships do not apply to
 * individual customers). They are captured inside the corporate KYC (STTM_KYC_CORP_KEYPERSONS)
 * and sent with their full data in `relations` (bank decision 03/11/2026).
 * `relationshipId` is already a REIS id (1-8); FLEXCUBE code -> id translation happens upstream.
 */
interface CanonicalRelationBase {
  /** KYC_REF_NO of the parent (corporate) customer; must match the customer being sent. */
  parentKycRefNo: string;
  /** The related party's OWN identifier, sent as the relation's systemId. Source TBD with Finexta/Reis. */
  systemId: string;
  relationshipId: number;
}

/** Related party that is an individual (REIS formId 3). */
export interface CanonicalIndividualRelation extends CanonicalRelationBase {
  readonly relatedPartyType: CustomerType.INDIVIDUAL;
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD */
  birthDate: string;
  birthPlace?: string;
  documentTypeRaw?: string;
  /** Mandatory (REIS V1.5): ID document number. */
  nid: string;
  /** Mandatory (REIS V1.5), YYYY-MM-DD. */
  issueDate: string;
  /** Mandatory (REIS V1.5), YYYY-MM-DD. */
  validUntil: string;
  /** Optional (REIS V1.5): national ID number. */
  nationalId?: string;
  issuePlace?: string;
  /** Raw FLEXCUBE value. */
  nationality: string;
  /** Raw FLEXCUBE value. */
  citizenship: string;
}

/** Related party that is an organization (REIS formId 4). */
export interface CanonicalCorporateRelation extends CanonicalRelationBase {
  readonly relatedPartyType: CustomerType.CORPORATE;
  businessName: string;
  tradeNo?: string;
  /** Raw FLEXCUBE value. */
  nationality: string;
}

export type CanonicalRelatedPerson = CanonicalIndividualRelation | CanonicalCorporateRelation;
