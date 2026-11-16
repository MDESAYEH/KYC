import { CustomerType } from '../canonical';
import { REIS_FORM, REIS_HEADERS, REIS_PATHS, reisFormFor } from './reis.constants';

describe('REIS constants (confirmed values)', () => {
  it('defines form ids and entity types', () => {
    expect(REIS_FORM.INDIVIDUAL).toEqual({ formId: 1, entityType: 'PP' });
    expect(REIS_FORM.CORPORATE).toEqual({ formId: 2, entityType: 'PM' });
    expect(REIS_FORM.INDIVIDUAL_RELATION).toEqual({ formId: 3, entityType: 'PP' });
    expect(REIS_FORM.CORPORATE_RELATION).toEqual({ formId: 4, entityType: 'PM' });
  });

  it('selects the form by customer type', () => {
    expect(reisFormFor(CustomerType.INDIVIDUAL).formId).toBe(1);
    expect(reisFormFor(CustomerType.CORPORATE).formId).toBe(2);
  });

  it('uses x-auth-token (not Authorization) and the confirmed paths', () => {
    expect(REIS_HEADERS.token).toBe('x-auth-token');
    expect(REIS_HEADERS.tenant).toBe('x-auth-tenant');
    expect(REIS_PATHS.authenticate).toBe('/xauth/authenticate/');
    expect(REIS_PATHS.searchOnboardCustomer).toBe('/onboarding/v2/searchOnboardCustomer');
  });
});
