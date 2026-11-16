/**
 * REIS V1.4 relationship ids (AIIB_KYC_Appendix.xlsx, sheet "relationships org customer").
 * Relationships apply to ORGANIZATION customers only (DFS V1.8 §2.3.2).
 */
export enum ReisRelationshipId {
  AUTHORIZED = 1,
  BENEFICIAR = 2,
  CEO = 3,
  CFO = 4,
  COOWNER = 5,
  MANAGER = 6,
  OWNER = 7,
  SHAREHOLDE = 8,
}

/** formId 3 (Individual Relation) accepts every relationship id 1-8 (V1.4). */
export const INDIVIDUAL_RELATION_IDS: ReadonlySet<ReisRelationshipId> = new Set([
  ReisRelationshipId.AUTHORIZED,
  ReisRelationshipId.BENEFICIAR,
  ReisRelationshipId.CEO,
  ReisRelationshipId.CFO,
  ReisRelationshipId.COOWNER,
  ReisRelationshipId.MANAGER,
  ReisRelationshipId.OWNER,
  ReisRelationshipId.SHAREHOLDE,
]);

/** formId 4 (Organization Relation) accepts only 2, 5, 7, 8 (V1.4). */
export const CORPORATE_RELATION_IDS: ReadonlySet<ReisRelationshipId> = new Set([
  ReisRelationshipId.BENEFICIAR,
  ReisRelationshipId.COOWNER,
  ReisRelationshipId.OWNER,
  ReisRelationshipId.SHAREHOLDE,
]);

/** `items` of an individual relation (formId 3), V1.5. */
export interface ReisIndividualRelationItems {
  entity_type: 'PP';
  first_name: string;
  last_name: string;
  /** YYYY-MM-DD */
  cus_birth_date: string;
  nationality: string;
  citizenship: string;
  /** Mandatory (V1.5): ID document number (passport number). */
  nid: string;
  /** Mandatory (V1.5), YYYY-MM-DD */
  issue_date: string;
  /** Mandatory (V1.5), YYYY-MM-DD */
  valid_until: string;
  // optional
  birth_place?: string;
  /** ID document TYPE code (only "PASS" is agreed). */
  tin?: string;
  /** Optional (V1.5): national ID number. */
  national_id?: string;
  issue_place?: string;
}

/** `items` of an organization relation (formId 4), V1.4. */
export interface ReisCorporateRelationItems {
  entity_type: 'PM';
  business_name: string;
  nationality: string;
  // optional
  trade_no?: string;
}

/**
 * Relation entry inside `relations` (V1.4 Postman shape: no entity_type on the entry itself).
 * `systemId` is the related party's OWN identifier, never the parent customer's.
 */
export interface ReisIndividualRelationEntry {
  formId: 3;
  items: ReisIndividualRelationItems;
  relationshipId: ReisRelationshipId;
  systemName: string;
  systemId: string;
}

export interface ReisCorporateRelationEntry {
  formId: 4;
  items: ReisCorporateRelationItems;
  relationshipId: ReisRelationshipId;
  systemName: string;
  systemId: string;
}

export type ReisRelationEntry = ReisIndividualRelationEntry | ReisCorporateRelationEntry;
