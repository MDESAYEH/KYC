import { KycRequestStatus } from '../../common/kyc-status';
import { ReisFinalStatus, ReisOnboardingStatus } from '../reis-status';
import {
  ReisAuthResponse,
  CORPORATE_RELATION_IDS,
  INDIVIDUAL_RELATION_IDS,
  ReisCorporateOnboardingRequest,
  ReisIndividualOnboardingRequest,
  ReisIndividualRelationEntry,
  ReisRelationshipId,
} from './index';

describe('REIS statuses', () => {
  it('keeps onboarding and final statuses distinct', () => {
    expect(Object.values(ReisOnboardingStatus)).toEqual(['CLEAN', 'PENDING', 'REJECT']);
    expect(Object.values(ReisFinalStatus)).toEqual(['CUSTOMER', 'BLOCKED']);
    expect(Object.values(KycRequestStatus)).not.toContain('CUSTOMER');
  });
});

describe('REIS DTO contracts (V1.4, envelope + items)', () => {
  it('auth response uses `token`', () => {
    const r: ReisAuthResponse = { token: 'abc' };
    expect(Object.keys(r)).toEqual(['token']);
  });

  it('individual request: envelope on top, entity_type and business fields inside items', () => {
    const req: ReisIndividualOnboardingRequest = {
      systemName: 'Flexcube',
      systemId: 'K1',
      formId: 1,
      items: {
        entity_type: 'PP',
        first_name: 'A',
        last_name: 'B',
        cus_birth_date: '1990-01-31',
        account_manager_login: 'm',
        account_manager_email: 'm@example.test',
        pep: false,
        relation_pep: false,
        nationality_customer: 'x',
        nationality: 'x',
        citizenship_customer: 'x',
        citizenship: 'x',
        profession: 'x',
        account_purpose_individual: 'x',
        resident: '1',
        distribution_channel: 'x',
        product: ['x'],
        source_income_individual: 'x',
        m_income: 1500.5,
      },
      relations: [],
    };
    expect(Object.keys(req).sort()).toEqual([
      'formId',
      'items',
      'relations',
      'systemId',
      'systemName',
    ]);
    expect(req.items.entity_type).toBe('PP');
    expect(req).not.toHaveProperty('entity_type');
    expect(typeof req.items.m_income).toBe('number');
    expect(typeof req.items.source_income_individual).toBe('string');
  });

  it('corporate request: formId 2, entity_type PM inside items, operation_country is an array', () => {
    const req: ReisCorporateOnboardingRequest = {
      systemName: 'Flexcube',
      systemId: 'K2',
      formId: 2,
      items: {
        entity_type: 'PM',
        business_name: 'Trading',
        account_manager_login: 'm',
        account_manager_email: 'm@example.test',
        pep: false,
        incorp_country: 'x',
        nationality: 'x',
        operation_country: ['x', 'y'],
        legal_entity: 'x',
        activity: 'x',
        account_purpose_organization: 'x',
        source_income_organization: 'x',
        distribution_channel: 'x',
        product: ['x'],
        fin_info: 250000,
      },
      relations: [],
    };
    expect(req.items.entity_type).toBe('PM');
    expect(Array.isArray(req.items.operation_country)).toBe(true);
    expect(typeof req.items.fin_info).toBe('number');
    expect(typeof req.items.source_income_organization).toBe('string');
  });

  it('individual relation entry (V1.4): entity_type only inside items', () => {
    const rel: ReisIndividualRelationEntry = {
      formId: 3,
      items: {
        entity_type: 'PP',
        first_name: 'A',
        last_name: 'B',
        cus_birth_date: '1990-01-31',
        nationality: 'x',
        citizenship: 'x',
        nid: 'P1',
        issue_date: '2020-01-02',
        valid_until: '2030-01-01',
      },
      relationshipId: ReisRelationshipId.CEO,
      systemName: 'Flexcube',
      systemId: 'REL-1',
    };
    expect(rel).not.toHaveProperty('entity_type');
    expect(rel.items.entity_type).toBe('PP');
  });

  it('relationship ids match the V1.4 appendix (relationships org customer)', () => {
    expect([
      ReisRelationshipId.AUTHORIZED,
      ReisRelationshipId.BENEFICIAR,
      ReisRelationshipId.CEO,
      ReisRelationshipId.CFO,
      ReisRelationshipId.COOWNER,
      ReisRelationshipId.MANAGER,
      ReisRelationshipId.OWNER,
      ReisRelationshipId.SHAREHOLDE,
    ]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...INDIVIDUAL_RELATION_IDS].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...CORPORATE_RELATION_IDS].sort()).toEqual([2, 5, 7, 8]);
  });
});
