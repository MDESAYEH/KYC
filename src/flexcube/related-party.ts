import { ReisRelationshipId } from '../reis/dto';

/**
 * Corporate key persons (STTM_KYC_CORP_KEYPERSONS + STTM_KYC_CORP_KEYPERSONS_CUSTOM) -> REIS
 * related parties. Two small, swappable pieces live here: the FLEXCUBE RELATIONSHIP code table
 * and the related-party systemId rule.
 */

/** STTM_KYC_CORP_KEYPERSONS.KYC_KEYPERSON_TYPE: I = individual (formId 3), C = company (formId 4). */
export const KEYPERSON_TYPES = ['I', 'C'] as const;
export type KeypersonType = (typeof KEYPERSON_TYPES)[number];

/**
 * FLEXCUBE RELATIONSHIP code -> REIS relationshipId (agreed 11/2026). Codes are the FLEXCUBE
 * values as stored (truncated: BENEFICIAR, SHAREHOLDE). Anything else is rejected, never guessed.
 */
export const RELATIONSHIP_CODE_TO_REIS_ID: Readonly<Record<string, ReisRelationshipId>> = {
  AUTHORIZED: ReisRelationshipId.AUTHORIZED,
  BENEFICIAR: ReisRelationshipId.BENEFICIAR,
  CEO: ReisRelationshipId.CEO,
  CFO: ReisRelationshipId.CFO,
  COOWNER: ReisRelationshipId.COOWNER,
  MANAGER: ReisRelationshipId.MANAGER,
  OWNER: ReisRelationshipId.OWNER,
  SHAREHOLDE: ReisRelationshipId.SHAREHOLDE,
};

/** Builds the REIS systemId of a related party from the company KYC_REF_NO and the key person KYC_ID. */
export type RelatedPartySystemIdStrategy = (companyKycRefNo: string, kycId: string) => string;

/**
 * Default rule: `${companyKycRefNo}-${KYC_ID}`, both trimmed. KYC_ID is free user input (unique
 * only within one company), so it is never used alone. The caller guarantees a non-blank KYC_ID.
 */
export const companyKycRefNoDashKycId: RelatedPartySystemIdStrategy = (companyKycRefNo, kycId) =>
  `${companyKycRefNo.trim()}-${kycId.trim()}`;
