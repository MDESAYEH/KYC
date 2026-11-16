import { ReisCorporateItems } from './reis-corporate.items';
import { ReisIndividualItems } from './reis-individual.items';
import { ReisRelationEntry } from './reis-relation.request';

/**
 * Body of POST /onboarding/v2/searchOnboardCustomer (confirmed by the working Postman):
 *
 *   TOP LEVEL : systemName, systemId, formId, relations
 *   `items`   : entity_type + all individual/corporate business fields
 *
 * Relations are part of this single request; they are never separate HTTP calls.
 */
export interface ReisOnboardingRequest<
  TItems extends object = object,
  TRelation = ReisRelationEntry,
> {
  systemName: string;
  systemId: string;
  formId: number;
  items: TItems;
  relations: TRelation[];
}

/** formId 1. */
export type ReisIndividualOnboardingRequest = ReisOnboardingRequest<
  ReisIndividualItems,
  ReisRelationEntry
> & { formId: 1 };

/** formId 2. Wire shape derived from V1.2; verify with a real Corporate request in UAT. */
export type ReisCorporateOnboardingRequest = ReisOnboardingRequest<
  ReisCorporateItems,
  ReisRelationEntry
> & { formId: 2 };
