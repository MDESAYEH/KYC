import { CustomerType } from '../canonical';

/** REIS KYC V1.2 form definitions (confirmed). */
export const REIS_FORM = {
  INDIVIDUAL: { formId: 1, entityType: 'PP' },
  CORPORATE: { formId: 2, entityType: 'PM' },
  INDIVIDUAL_RELATION: { formId: 3, entityType: 'PP' },
  CORPORATE_RELATION: { formId: 4, entityType: 'PM' },
} as const;

export function reisFormFor(type: CustomerType) {
  return type === CustomerType.INDIVIDUAL ? REIS_FORM.INDIVIDUAL : REIS_FORM.CORPORATE;
}

/** REIS header names (confirmed). Token goes in x-auth-token, NOT Authorization. */
export const REIS_HEADERS = {
  tenant: 'x-auth-tenant',
  token: 'x-auth-token',
} as const;

/** REIS paths relative to the configured base URL (confirmed). */
export const REIS_PATHS = {
  authenticate: '/xauth/authenticate/',
  searchOnboardCustomer: '/onboarding/v2/searchOnboardCustomer',
} as const;
