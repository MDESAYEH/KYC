import { CustomerType } from '../src/canonical';
import { FlexcubeCustomerRequest } from '../src/flexcube/dto/flexcube-customer.request';
import { StrictIsoFlexcubeDateNormalizer } from '../src/flexcube/flexcube-date-normalizer';
import { YesNoResidentParser } from '../src/flexcube/flexcube-resident-parser';
import { FlexcubeToCanonicalMapper } from '../src/flexcube/flexcube-to-canonical.mapper';
import { ReferenceMappingService } from '../src/mapping/reference-mapping.service';
import { seedReferenceMappings } from '../src/mapping/seed/agreed-reference-mappings';
import { SingleSelectionSourceOfIncomeStrategy } from '../src/mapping/single-source-of-income.strategy';
import { TypeOrmReferenceMappingRepository } from '../src/persistence/typeorm-reference-mapping.repository';
import { CanonicalToReisTransformer } from '../src/reis/canonical-to-reis.transformer';
import { ReisConfig } from '../src/reis/reis.config';
import reference from './fixtures/reis-postman-v1.4-bodies.json';
import { createTestDataSource } from './support/test-database';

/**
 * Independent reference: the expected payloads are Vneuron's own Postman V1.4 request bodies
 * (test/fixtures, extracted without URL or credentials), NOT values computed by our code.
 * Each FLEXCUBE-side input is built from the Postman values; our full pipeline
 * (mapper -> seeded mappings -> transformer) must reproduce Vneuron's body exactly.
 */
// Fixture JSON is untyped test data: field access is checked by the toEqual below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Body = { systemName: string; systemId: string; formId: number; items: Record<string, Json> };
const body = (code: keyof typeof reference.requests) => reference.requests[code].body as Body;
const yn = (b: boolean) => (b ? 'Y' : 'N');

const fromIndividual = (b: Body): FlexcubeCustomerRequest => {
  const i = b.items;
  return {
    KYC_REF_NO: b.systemId,
    CUSTOMER_TYPE: 'INDIVIDUAL',
    ACCOUNT_MANAGER_LOGIN: i.account_manager_login,
    ACCOUNT_MANAGER_EMAIL: i.account_manager_email,
    PEP: yn(i.pep),
    PRODUCT_CODES: i.product,
    DISTRIBUTION_CHANNEL: i.distribution_channel,
    individual: {
      FIRST_NAME: i.first_name,
      LAST_NAME: i.last_name,
      BIRTH_DATE: i.cus_birth_date,
      BIRTH_PLACE: i.birth_place,
      NID: i.nid,
      EXPIRY_DATE: i.expiry_date,
      RELATION_PEP: yn(i.relation_pep),
      NATIONALITY: i.nationality_customer,
      CITIZENSHIP: i.citizenship_customer,
      PROFESSION: i.profession,
      ACC_PURPOSE: i.account_purpose_individual,
      RESIDENT: i.resident === '1' ? 'Y' : 'N',
      FUND_SOURCE: i.source_income_individual,
      MONTHLY_INCOME: i.m_income,
    },
  };
};

const fromCorporate = (b: Body): FlexcubeCustomerRequest => {
  const i = b.items;
  return {
    KYC_REF_NO: b.systemId,
    CUSTOMER_TYPE: 'CORPORATE',
    ACCOUNT_MANAGER_LOGIN: i.account_manager_login,
    ACCOUNT_MANAGER_EMAIL: i.account_manager_email,
    PEP: yn(i.pep),
    PRODUCT_CODES: i.product,
    DISTRIBUTION_CHANNEL: i.distribution_channel,
    corporate: {
      CRP_BUSINESS_NAME: i.business_name,
      TRADE_NO: i.trade_no,
      PARENT_CMPNY_COUNTRY: i.incorp_country,
      OPERATION_COUNTRY: i.operation_country,
      LEGAL_ENTITY: i.legal_entity,
      ACTIVITY: i.activity,
      ACC_PURPOSE: i.account_purpose_organization,
      SOURCE_OF_INCOME: i.source_income_organization,
      FIN_INFO: i.fin_info,
    },
  };
};

describe('payloads match the Vneuron Postman V1.4 reference bodies exactly', () => {
  let transformer: CanonicalToReisTransformer;
  const mapper = new FlexcubeToCanonicalMapper(
    new StrictIsoFlexcubeDateNormalizer(),
    new YesNoResidentParser(),
  );

  beforeAll(async () => {
    const repo = new TypeOrmReferenceMappingRepository(await createTestDataSource());
    await seedReferenceMappings(repo);
    const service = new ReferenceMappingService(repo);
    transformer = new CanonicalToReisTransformer(
      service,
      new SingleSelectionSourceOfIncomeStrategy(service),
      { systemName: 'Flexcube' } as ReisConfig,
    );
  });

  it('the reference file carries no credentials or URLs', () => {
    const text = JSON.stringify(reference);
    expect(text).not.toMatch(/password|user_name|https?:\/\//i);
  });

  it.each([
    ['SC-002', fromIndividual],
    ['SC-009', fromCorporate],
    ['SC-011', fromCorporate],
  ] as const)('%s', async (code, toFlexcube) => {
    const expected = body(code);
    const actual = await transformer.transform(mapper.map(toFlexcube(expected)));
    // Vneuron omits an empty "relations" array; we always send [] (accepted by Reis in UAT).
    expect(actual.relations).toEqual([]);
    expect({ ...actual, relations: undefined }).toEqual({ ...expected, relations: undefined });
  });

  it('SC-013: organization with an individual (CEO) and an organization (OWNER) relation', async () => {
    const expected = reference.requests['SC-013'].body as Body & {
      relations: {
        formId: number;
        items: Record<string, Json>;
        relationshipId: number;
        systemId: string;
      }[];
    };
    // The Vneuron QA sample names contain digits (e.g. "...-QA1"); names must now be Latin letters
    // only, so the digits are stripped from the sample before it is used as input and expectation.
    for (const rel of expected.relations) {
      for (const k of ['first_name', 'last_name', 'business_name']) {
        const v = rel.items[k];
        if (typeof v === 'string') rel.items[k] = v.replace(/\d/g, '');
      }
    }
    const [ceo, owner] = expected.relations;
    const actual = await transformer.transform(mapper.map(fromCorporate(expected)), [
      {
        relatedPartyType: CustomerType.INDIVIDUAL,
        parentKycRefNo: expected.systemId,
        systemId: ceo.systemId,
        relationshipId: ceo.relationshipId,
        firstName: ceo.items.first_name,
        lastName: ceo.items.last_name,
        birthDate: ceo.items.cus_birth_date,
        birthPlace: ceo.items.birth_place,
        nid: ceo.items.nid,
        // V1.5 made issue_date mandatory; the V1.4 Postman body has none, so a synthetic one is added.
        issueDate: '2020-01-01',
        validUntil: ceo.items.valid_until,
        issuePlace: ceo.items.issue_place,
        nationality: ceo.items.nationality,
        citizenship: ceo.items.citizenship,
      },
      {
        relatedPartyType: CustomerType.CORPORATE,
        parentKycRefNo: expected.systemId,
        systemId: owner.systemId,
        relationshipId: owner.relationshipId,
        businessName: owner.items.business_name,
        tradeNo: owner.items.trade_no,
        nationality: owner.items.nationality,
      },
    ]);
    // Only difference to the V1.4 body: the V1.5 mandatory issue_date (synthetic above).
    const expectedV15 = JSON.parse(JSON.stringify(expected)) as typeof expected;
    expectedV15.relations[0].items.issue_date = '2020-01-01';
    expect(actual).toEqual(expectedV15);
  });
});
