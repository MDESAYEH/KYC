import { seededMappings } from '../../test/support/in-memory-reference-mappings';
import {
  CanonicalCorporateCustomer,
  CanonicalIndividualCustomer,
  CanonicalIndividualRelation,
  CanonicalCorporateRelation,
  CustomerType,
} from '../canonical';
import {
  InvalidFieldValueError,
  MissingRequiredFieldError,
  SourceOfIncomeRuleNotConfiguredError,
} from '../canonical/transformation.errors';
import { FlexcubeCustomerRequest } from '../flexcube/dto/flexcube-customer.request';
import { StrictIsoFlexcubeDateNormalizer } from '../flexcube/flexcube-date-normalizer';
import { YesNoResidentParser } from '../flexcube/flexcube-resident-parser';
import { FlexcubeToCanonicalMapper } from '../flexcube/flexcube-to-canonical.mapper';
import { ReferenceMappingType } from '../mapping/reference-mapping';
import { UnmappedReferenceValueError } from '../mapping/reference-mapping';
import { SingleSelectionSourceOfIncomeStrategy } from '../mapping/single-source-of-income.strategy';
import { CanonicalToReisTransformer } from './canonical-to-reis.transformer';
import { COUNTRY_MAPPING_TYPE, DEFAULT_COUNTRY_MAPPING_TYPES } from './country-mapping';
import { ReisCorporateOnboardingRequest, ReisIndividualOnboardingRequest } from './dto';
import { ReisConfig } from './reis.config';

// Synthetic data only; mappings come from the test-only seed (T-* -> R-*), not Bank data.
const individual = (
  over: Partial<CanonicalIndividualCustomer> = {},
): CanonicalIndividualCustomer => ({
  customerType: CustomerType.INDIVIDUAL,
  kycRefNo: 'KYC-0001',
  customerNo: null,
  accountManagerLogin: 'amgr',
  accountManagerEmail: 'amgr@example.test',
  pep: false,
  productCodes: ['T-PROD'],
  distributionChannel: 'T-CHAN',
  firstName: 'Testfirst',
  lastName: 'Testlast',
  birthDate: '1990-01-31',
  relationPep: true,
  nationality: 'T-NAT',
  citizenship: 'T-CIT',
  profession: 'T-PROF',
  accountPurpose: 'T-APIND',
  isResident: true,
  selectedIncomeSources: ['T-SALARY'],
  monthlyIncome: 1500.5,
  ...over,
});

const corporate = (over: Partial<CanonicalCorporateCustomer> = {}): CanonicalCorporateCustomer => ({
  customerType: CustomerType.CORPORATE,
  kycRefNo: 'KYC-0002',
  customerNo: null,
  accountManagerLogin: 'amgr',
  accountManagerEmail: 'amgr@example.test',
  pep: true,
  productCodes: ['T-PROD'],
  distributionChannel: 'T-CHAN',
  businessName: 'Test trading business',
  incorporationCountry: 'T-INC',
  operationCountries: ['T-OP1', 'T-OP2'],
  legalEntity: 'T-LEGAL',
  activity: 'T-ACT',
  accountPurpose: 'T-APCORP',
  sourceOfIncome: 'T-CORP-INC',
  financialInfo: 250000,
  ...over,
});

describe('CanonicalToReisTransformer', () => {
  let transformer: CanonicalToReisTransformer;
  let mappings: Awaited<ReturnType<typeof seededMappings>>;

  const build = async (systemName = 'Flexcube') => {
    mappings = await seededMappings();
    const config = { systemName } as ReisConfig;
    return new CanonicalToReisTransformer(
      mappings.service,
      new SingleSelectionSourceOfIncomeStrategy(mappings.service),
      config,
    );
  };
  beforeEach(async () => {
    transformer = await build();
  });

  const ind = async (over?: Partial<CanonicalIndividualCustomer>) =>
    (await transformer.transform(individual(over))) as ReisIndividualOnboardingRequest;
  const corp = async (over?: Partial<CanonicalCorporateCustomer>) =>
    (await transformer.transform(corporate(over))) as ReisCorporateOnboardingRequest;

  describe('Latin-only names (REIS sanctions screening matches the same script only)', () => {
    const BAD: [string, string][] = [
      ['Arabic', 'محمد'],
      ['accented', 'José'],
      ['mixed script', 'Ali محمد'],
      ['digits', 'Ali2'],
      ['symbol', 'Ali & Co'],
    ];
    const GOOD = ['Mary-Anne', "O'Brien Jr.", '  Ali Hassan  ', 'Test trading business'];

    const rejectsWithoutValue = async (
      run: () => Promise<unknown>,
      field: string,
      value: string,
    ) => {
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidFieldValueError);
      expect((err as Error).message).toContain(field);
      expect((err as Error).message).not.toContain(value);
    };

    it.each(BAD)(
      'customer first_name / last_name reject %s names (field name only)',
      async (_n, v) => {
        await rejectsWithoutValue(() => ind({ firstName: v }), 'FIRST_NAME', v);
        await rejectsWithoutValue(() => ind({ lastName: v }), 'LAST_NAME', v);
      },
    );

    it.each(BAD)('corporate business_name rejects %s names (field name only)', async (_n, v) => {
      await rejectsWithoutValue(() => corp({ businessName: v }), 'CRP_BUSINESS_NAME', v);
    });

    it('accepts valid Latin names for the customer, sent unchanged', async () => {
      for (const v of GOOD) {
        const i = await ind({ firstName: v, lastName: v });
        expect(i.items).toMatchObject({ first_name: v, last_name: v });
        expect((await corp({ businessName: v })).items.business_name).toBe(v);
      }
    });
  });

  describe('Individual envelope', () => {
    it('builds the confirmed structure: envelope on top, entity_type and fields inside items', async () => {
      expect(await ind()).toEqual({
        systemName: 'Flexcube',
        systemId: 'KYC-0001',
        formId: 1,
        items: {
          entity_type: 'PP',
          first_name: 'Testfirst',
          last_name: 'Testlast',
          cus_birth_date: '1990-01-31',
          account_manager_login: 'amgr',
          account_manager_email: 'amgr@example.test',
          pep: false,
          relation_pep: true,
          nationality_customer: 'R-NAT',
          nationality: 'R-NAT',
          citizenship_customer: 'R-CIT',
          citizenship: 'R-CIT',
          profession: 'R-PROF',
          account_purpose_individual: 'R-APIND',
          resident: '1',
          distribution_channel: 'R-CHAN',
          product: ['R-PROD'],
          source_income_individual: 'R-SALARY',
          m_income: 1500.5,
        },
        relations: [],
      });
    });

    it('uses KYC_REF_NO as systemId, formId 1, and keeps entity_type out of the top level', async () => {
      const r = await ind({ kycRefNo: 'KYC-XYZ' });
      expect(r.systemId).toBe('KYC-XYZ');
      expect(r.formId).toBe(1);
      expect(r.items.entity_type).toBe('PP');
      expect(r).not.toHaveProperty('entity_type');
      expect(Object.keys(r).sort()).toEqual([
        'formId',
        'items',
        'relations',
        'systemId',
        'systemName',
      ]);
    });

    it('uses the configured systemName', async () => {
      const custom = await build('OtherSystem');
      const r = await custom.transform(individual());
      expect(r.systemName).toBe('OtherSystem');
    });

    it('carries first and last name unchanged', async () => {
      const r = await ind({ firstName: 'Ana Maria', lastName: "O'Test" });
      expect(r.items).toMatchObject({ first_name: 'Ana Maria', last_name: "O'Test" });
    });

    it('derives nationality from nationality_customer and citizenship from citizenship_customer', async () => {
      const r = await ind();
      expect(r.items.nationality).toBe(r.items.nationality_customer);
      expect(r.items.citizenship).toBe(r.items.citizenship_customer);
      expect(r.items.nationality_customer).toBe('R-NAT');
      expect(r.items.citizenship_customer).toBe('R-CIT');
    });

    it('converts the resident flag to REIS "1" / "2"', async () => {
      expect((await ind({ isResident: true })).items.resident).toBe('1');
      expect((await ind({ isResident: false })).items.resident).toBe('2');
    });

    it('translates PRODUCT_CODE, account purpose, profession and channel through reference mappings', async () => {
      const r = await ind();
      expect(r.items).toMatchObject({
        product: ['R-PROD'],
        account_purpose_individual: 'R-APIND',
        profession: 'R-PROF',
        distribution_channel: 'R-CHAN',
      });
    });

    it('keeps booleans and numbers typed (pep, m_income)', async () => {
      const r = await ind({ pep: true, monthlyIncome: 0 });
      expect(r.items.pep).toBe(true);
      expect(r.items.m_income).toBe(0);
    });

    it('omits optional fields when not provided', async () => {
      const { items } = await ind();
      for (const k of ['birth_place', 'tin', 'nid', 'issue_date', 'expiry_date']) {
        // issue_date is never sent (removed from REIS V1.3/V1.4).
        expect(items).not.toHaveProperty(k);
      }
    });

    it('includes optional fields when provided; tin goes through DOCUMENT_TYPE, nid stays the raw number', async () => {
      const { items } = await ind({
        birthPlace: 'Testville',
        documentTypeRaw: 'T-DOC',
        nid: '0012345',
        expiryDate: '2030-02-01',
      });
      expect(items).toMatchObject({
        birth_place: 'Testville',
        tin: 'R-DOC',
        nid: '0012345',
        expiry_date: '2030-02-01',
      });
      expect(items).not.toHaveProperty('issue_date');
    });

    it('defaults tin to PASS when a document number is given without a type (mapping V2_5)', async () => {
      const { items } = await ind({ nid: '999' });
      expect(items.nid).toBe('999');
      expect(items.tin).toBe('PASS');
    });
  });

  describe('Corporate envelope', () => {
    it('builds the structure derived from V1.2: formId 2, entity_type PM inside items', async () => {
      expect(await corp()).toEqual({
        systemName: 'Flexcube',
        systemId: 'KYC-0002',
        formId: 2,
        items: {
          entity_type: 'PM',
          business_name: 'Test trading business',
          account_manager_login: 'amgr',
          account_manager_email: 'amgr@example.test',
          pep: true,
          incorp_country: 'R-INC',
          nationality: 'R-INC',
          operation_country: ['R-OP1', 'R-OP2'],
          legal_entity: 'R-LEGAL',
          activity: 'R-ACT',
          account_purpose_organization: 'R-APCORP',
          source_income_organization: 'R-CORP-INC',
          distribution_channel: 'R-CHAN',
          product: ['R-PROD'],
          fin_info: 250000,
        },
        relations: [],
      });
    });

    it('derives corporate nationality from the mapped country of incorporation', async () => {
      const r = await corp();
      expect(r.items.nationality).toBe(r.items.incorp_country);
    });

    it('does not map business_name (CRP_BUSINESS_NAME passes through)', async () => {
      expect((await corp({ businessName: 'Anything goes here' })).items.business_name).toBe(
        'Anything goes here',
      );
    });

    it('keeps operation_country an array, in order, one mapped value per input', async () => {
      const r = await corp({ operationCountries: ['T-OP2', 'T-OP1', 'T-OP2'] });
      expect(r.items.operation_country).toEqual(['R-OP2', 'R-OP1', 'R-OP2']);
      expect((await corp({ operationCountries: ['T-OP1'] })).items.operation_country).toEqual([
        'R-OP1',
      ]);
    });

    it('fails when an operation country is unmapped or the list is empty', async () => {
      await expect(corp({ operationCountries: ['T-OP1', 'T-NOPE'] })).rejects.toBeInstanceOf(
        UnmappedReferenceValueError,
      );
      await expect(corp({ operationCountries: [] })).rejects.toBeInstanceOf(
        MissingRequiredFieldError,
      );
    });

    it('keeps trade_no optional', async () => {
      expect((await corp()).items).not.toHaveProperty('trade_no');
      expect((await corp({ tradeNo: 'TR-1' })).items.trade_no).toBe('TR-1');
    });
  });

  describe('relations', () => {
    const indRel = (
      over: Partial<CanonicalIndividualRelation> = {},
    ): CanonicalIndividualRelation => ({
      relatedPartyType: CustomerType.INDIVIDUAL,
      parentKycRefNo: 'KYC-0002',
      systemId: 'REL-IND-1',
      relationshipId: 3,
      firstName: 'Relfirst',
      lastName: 'Rellast',
      birthDate: '1991-02-03',
      nationality: 'T-REL-NAT',
      citizenship: 'T-REL-CIT',
      nid: 'P-REL-1',
      issueDate: '2020-01-02',
      validUntil: '2030-01-01',
      ...over,
    });
    const corpRel = (
      over: Partial<CanonicalCorporateRelation> = {},
    ): CanonicalCorporateRelation => ({
      relatedPartyType: CustomerType.CORPORATE,
      parentKycRefNo: 'KYC-0002',
      systemId: 'REL-CORP-1',
      relationshipId: 7,
      businessName: 'Sub Co',
      nationality: 'T-REL-NAT',
      ...over,
    });

    it('produces an empty relations array when none are provided', async () => {
      expect((await ind()).relations).toEqual([]);
      expect((await corp()).relations).toEqual([]);
      expect((await transformer.transform(individual(), [])).relations).toEqual([]);
    });

    it('rejects relations for an individual customer (DFS V1.8: organizations only)', async () => {
      await expect(
        transformer.transform(individual(), [indRel({ parentKycRefNo: 'KYC-0001' })]),
      ).rejects.toThrow(/organization customers only/);
    });

    it('serializes an individual relation in the V1.4 shape (no entity_type on the entry, own systemId)', async () => {
      const r = await transformer.transform(corporate(), [indRel()]);
      expect(r.relations).toEqual([
        {
          formId: 3,
          items: {
            entity_type: 'PP',
            first_name: 'Relfirst',
            last_name: 'Rellast',
            cus_birth_date: '1991-02-03',
            nationality: 'R-REL-NAT',
            citizenship: 'R-REL-CIT',
            nid: 'P-REL-1',
            tin: 'PASS',
            issue_date: '2020-01-02',
            valid_until: '2030-01-01',
          },
          relationshipId: 3,
          systemName: 'Flexcube',
          systemId: 'REL-IND-1',
        },
      ]);
    });

    it('includes optional individual relation fields and maps its document type', async () => {
      const r = await transformer.transform(corporate(), [
        indRel({
          birthPlace: 'Testville',
          documentTypeRaw: 'T-DOC',
          nid: '55',
          nationalId: 'NAT-9',
          issuePlace: 'Testburg',
        }),
      ]);
      expect(r.relations[0].items).toEqual({
        entity_type: 'PP',
        first_name: 'Relfirst',
        last_name: 'Rellast',
        cus_birth_date: '1991-02-03',
        nationality: 'R-REL-NAT',
        citizenship: 'R-REL-CIT',
        birth_place: 'Testville',
        tin: 'R-DOC',
        nid: '55',
        national_id: 'NAT-9',
        issue_date: '2020-01-02',
        valid_until: '2030-01-01',
        issue_place: 'Testburg',
      });
    });

    it('defaults a relation tin to PASS when only the passport number is given', async () => {
      const r = await transformer.transform(corporate(), [indRel({ nid: 'P1' })]);
      expect(r.relations[0].items).toMatchObject({ tin: 'PASS', nid: 'P1' });
    });

    describe('Latin-only names in relations', () => {
      const BAD: [string, string][] = [
        ['Arabic', 'محمد'],
        ['accented', 'José'],
        ['mixed script', 'Ali محمد'],
        ['digits', 'Ali2'],
        ['symbol', 'Ali & Co'],
      ];
      it.each(BAD)('individual relation first_name / last_name reject %s names', async (_n, v) => {
        for (const [key, field] of [
          ['firstName', 'relation.first_name'],
          ['lastName', 'relation.last_name'],
        ] as const) {
          const err = await transformer
            .transform(corporate(), [indRel({ [key]: v })])
            .catch((e: unknown) => e);
          expect(err).toBeInstanceOf(InvalidFieldValueError);
          expect((err as Error).message).toContain(field);
          expect((err as Error).message).not.toContain(v);
        }
      });

      it.each(BAD)('corporate relation business_name rejects %s names', async (_n, v) => {
        const err = await transformer
          .transform(corporate(), [corpRel({ businessName: v })])
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InvalidFieldValueError);
        expect((err as Error).message).toContain('relation.business_name');
        expect((err as Error).message).not.toContain(v);
      });

      it('accepts valid Latin names in both relation kinds', async () => {
        const r = await transformer.transform(corporate(), [
          indRel({ firstName: "O'Brien", lastName: 'Smith-Jones Jr.' }),
          corpRel({ businessName: 'Sub Co. Ltd' }),
        ]);
        expect(r.relations[0].items).toMatchObject({
          first_name: "O'Brien",
          last_name: 'Smith-Jones Jr.',
        });
        expect(r.relations[1].items).toMatchObject({ business_name: 'Sub Co. Ltd' });
      });
    });

    describe('formId 3 mandatory fields (REIS V1.5)', () => {
      it.each([
        ['nid', 'relation.nid'],
        ['issueDate', 'relation.issue_date'],
        ['validUntil', 'relation.valid_until'],
      ] as const)('rejects a missing %s before any mapping lookup', async (key, field) => {
        for (const value of [undefined, '', '   ']) {
          const err = await transformer
            .transform(corporate(), [
              indRel({
                [key]: value,
                nationality: 'T-NOT-MAPPED',
              } as Partial<CanonicalIndividualRelation>),
            ])
            .catch((e: unknown) => e);
          expect(err).toBeInstanceOf(MissingRequiredFieldError);
          expect((err as MissingRequiredFieldError).field).toBe(field);
        }
      });

      it('rejects issue_date / valid_until that are not YYYY-MM-DD, naming the field only', async () => {
        const err = await transformer
          .transform(corporate(), [indRel({ issueDate: '02/01/2020' })])
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InvalidFieldValueError);
        expect((err as Error).message).toContain('issue_date');
        expect((err as Error).message).not.toContain('02/01/2020');
        await expect(
          transformer.transform(corporate(), [indRel({ validUntil: '2030-02-30' })]),
        ).rejects.toBeInstanceOf(InvalidFieldValueError);
      });

      it('national_id is optional and passed through when given', async () => {
        const without = await transformer.transform(corporate(), [indRel()]);
        expect(without.relations[0].items).not.toHaveProperty('national_id');
        const withIt = await transformer.transform(corporate(), [indRel({ nationalId: 'N-1' })]);
        expect(withIt.relations[0].items).toMatchObject({ national_id: 'N-1' });
      });
    });

    it('serializes corporate relations in order, each with its own systemId', async () => {
      const r = await transformer.transform(corporate(), [
        corpRel(),
        corpRel({ relationshipId: 8, tradeNo: 'T1', systemId: 'REL-CORP-2' }),
      ]);
      expect(r.relations).toEqual([
        {
          formId: 4,
          items: { entity_type: 'PM', business_name: 'Sub Co', nationality: 'R-REL-NAT' },
          relationshipId: 7,
          systemName: 'Flexcube',
          systemId: 'REL-CORP-1',
        },
        {
          formId: 4,
          items: {
            entity_type: 'PM',
            business_name: 'Sub Co',
            nationality: 'R-REL-NAT',
            trade_no: 'T1',
          },
          relationshipId: 8,
          systemName: 'Flexcube',
          systemId: 'REL-CORP-2',
        },
      ]);
    });

    it('rejects two relations that share a systemId, naming the field only', async () => {
      const err = await transformer
        .transform(corporate(), [indRel(), corpRel({ systemId: 'REL-IND-1' })])
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidFieldValueError);
      expect((err as Error).message).toContain('relation.systemId');
      expect((err as Error).message).not.toContain('REL-IND-1');
    });

    it('uses the relatedPersons carried by a corporate canonical customer by default', async () => {
      const r = await transformer.transform({ ...corporate(), relatedPersons: [indRel()] });
      expect(r.relations).toHaveLength(1);
      expect(r.relations[0]).toMatchObject({ formId: 3, systemId: 'REL-IND-1' });
    });

    it('never reuses the customer systemId for a relation', async () => {
      await expect(
        transformer.transform(corporate(), [indRel({ systemId: 'KYC-0002' })]),
      ).rejects.toThrow(/related party identifier/);
      await expect(
        transformer.transform(corporate(), [indRel({ systemId: ' ' })]),
      ).rejects.toBeInstanceOf(MissingRequiredFieldError);
    });

    it('rejects relations that do not belong to the customer, bad dates and unmapped values', async () => {
      await expect(
        transformer.transform(corporate(), [indRel({ parentKycRefNo: 'OTHER' })]),
      ).rejects.toBeInstanceOf(InvalidFieldValueError);
      await expect(
        transformer.transform(corporate(), [indRel({ birthDate: '03/02/1991' })]),
      ).rejects.toBeInstanceOf(InvalidFieldValueError);
      await expect(
        transformer.transform(corporate(), [indRel({ nationality: 'T-NOPE' })]),
      ).rejects.toBeInstanceOf(UnmappedReferenceValueError);
      await expect(
        transformer.transform(corporate(), [indRel({ documentTypeRaw: 'free text' })]),
      ).rejects.toBeInstanceOf(UnmappedReferenceValueError);
    });

    describe('relationshipId per form (REIS V1.4)', () => {
      it.each([1, 2, 3, 4, 5, 6, 7, 8])(
        'formId 3 (Individual Relation) accepts id %i',
        async (id) => {
          const r = await transformer.transform(corporate(), [indRel({ relationshipId: id })]);
          expect(r.relations[0]).toMatchObject({ formId: 3, relationshipId: id });
        },
      );

      it.each([2, 5, 7, 8])('formId 4 (Organization Relation) accepts id %i', async (id) => {
        const r = await transformer.transform(corporate(), [corpRel({ relationshipId: id })]);
        expect(r.relations[0]).toMatchObject({ formId: 4, relationshipId: id });
      });

      it.each([1, 3, 4, 6])(
        'formId 4 (Organization Relation) rejects the individual-only id %i',
        async (id) => {
          await expect(
            transformer.transform(corporate(), [corpRel({ relationshipId: id })]),
          ).rejects.toThrow(/relationshipId/);
        },
      );

      it.each([0, 9, 15, 99, -1, 1.5, NaN, '2' as unknown as number, null as unknown as number])(
        'rejects the undocumented id %p on both forms',
        async (id) => {
          await expect(
            transformer.transform(corporate(), [indRel({ relationshipId: id })]),
          ).rejects.toBeInstanceOf(InvalidFieldValueError);
          await expect(
            transformer.transform(corporate(), [corpRel({ relationshipId: id })]),
          ).rejects.toBeInstanceOf(InvalidFieldValueError);
        },
      );
    });
  });

  describe('country mapping (REIS country-code requirement CONFIRMED; shared NATIONALITY list PROVISIONAL)', () => {
    it('uses the NATIONALITY list for every country field by default', async () => {
      expect(Object.values(DEFAULT_COUNTRY_MAPPING_TYPES)).toEqual([
        ReferenceMappingType.NATIONALITY,
        ReferenceMappingType.NATIONALITY,
        ReferenceMappingType.NATIONALITY,
        ReferenceMappingType.NATIONALITY,
      ]);
      expect(COUNTRY_MAPPING_TYPE).toBe(ReferenceMappingType.NATIONALITY);
      expect(Object.keys(DEFAULT_COUNTRY_MAPPING_TYPES).sort()).toEqual([
        'CITIZENSHIP',
        'INCORPORATION_COUNTRY',
        'NATIONALITY',
        'OPERATION_COUNTRY',
      ]);
    });

    it('can be split per field without duplicating mapping data or touching the transformer', async () => {
      const m = await seededMappings();
      // Test-only split: citizenship and operation countries get their own (here: borrowed) lists.
      await m.repo.upsert({
        mappingType: ReferenceMappingType.ACTIVITY,
        flexcubeValue: 'T-CIT',
        reisValue: 'R-CIT-SPLIT',
      });
      await m.repo.upsert({
        mappingType: ReferenceMappingType.LEGAL_ENTITY,
        flexcubeValue: 'T-OP1',
        reisValue: 'R-OP1-SPLIT',
      });
      const split = new CanonicalToReisTransformer(
        m.service,
        new SingleSelectionSourceOfIncomeStrategy(m.service),
        { systemName: 'Flexcube' } as ReisConfig,
        {
          ...DEFAULT_COUNTRY_MAPPING_TYPES,
          CITIZENSHIP: ReferenceMappingType.ACTIVITY,
          OPERATION_COUNTRY: ReferenceMappingType.LEGAL_ENTITY,
        },
      );
      const ind = await split.transform(individual());
      expect(ind.items).toMatchObject({
        nationality: 'R-NAT', // still the NATIONALITY list
        citizenship: 'R-CIT-SPLIT', // now resolved from its own list
      });
      const corp = await split.transform(corporate({ operationCountries: ['T-OP1'] }));
      expect(corp.items).toMatchObject({
        incorp_country: 'R-INC', // unchanged
        operation_country: ['R-OP1-SPLIT'],
      });
    });
  });

  describe('failures happen before any payload is produced', () => {
    it.each([
      [ReferenceMappingType.NATIONALITY, { nationality: 'T-NOPE' }],
      [ReferenceMappingType.NATIONALITY, { citizenship: 'T-NOPE' }],
      [ReferenceMappingType.PROFESSION, { profession: 'T-NOPE' }],
      [ReferenceMappingType.ACCOUNT_PURPOSE_INDIVIDUAL, { accountPurpose: 'T-NOPE' }],
      [ReferenceMappingType.PRODUCT, { productCodes: ['T-PROD', 'T-NOPE'] }],
      [ReferenceMappingType.DISTRIBUTION_CHANNEL, { distributionChannel: 'T-NOPE' }],
      [ReferenceMappingType.DOCUMENT_TYPE, { documentTypeRaw: 'passport maybe' }],
      [ReferenceMappingType.SOURCE_OF_INCOME, { selectedIncomeSources: ['T-NOPE'] }],
    ])('unmapped individual %s value throws UnmappedReferenceValueError', async (type, over) => {
      const err = await transformer.transform(individual(over)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnmappedReferenceValueError);
      expect(err).toMatchObject({ mappingType: type });
    });

    it.each([
      [{ incorporationCountry: 'T-NOPE' }],
      [{ legalEntity: 'T-NOPE' }],
      [{ activity: 'T-NOPE' }],
      [{ accountPurpose: 'T-NOPE' }],
      [{ sourceOfIncome: 'T-NOPE' }],
      [{ productCodes: ['T-NOPE'] }],
      [{ distributionChannel: 'T-NOPE' }],
    ])('unmapped corporate value %p throws UnmappedReferenceValueError', async (over) => {
      await expect(transformer.transform(corporate(over))).rejects.toBeInstanceOf(
        UnmappedReferenceValueError,
      );
    });

    it('does not invent a meaning for Corporate Account Purpose 203 / 204', async () => {
      for (const code of ['203', '204']) {
        const err = await transformer
          .transform(corporate({ accountPurpose: code }))
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UnmappedReferenceValueError);
        expect(err).toMatchObject({
          mappingType: ReferenceMappingType.ACCOUNT_PURPOSE_CORPORATE,
          flexcubeValue: code,
        });
      }
    });

    it('does not pass an unapproved document type through, and respects deactivation', async () => {
      await expect(
        transformer.transform(individual({ documentTypeRaw: 'R-DOC' })),
      ).rejects.toBeInstanceOf(UnmappedReferenceValueError);
      await mappings.repo.setActive(ReferenceMappingType.DOCUMENT_TYPE, 'T-DOC', false);
      await expect(
        transformer.transform(individual({ documentTypeRaw: 'T-DOC' })),
      ).rejects.toBeInstanceOf(UnmappedReferenceValueError);
    });

    it('does not guess when several income sources are selected', async () => {
      for (const sel of [
        ['T-SALARY', 'T-RENTAL'],
        ['T-RENTAL', 'T-SALARY'],
      ]) {
        await expect(
          transformer.transform(individual({ selectedIncomeSources: sel })),
        ).rejects.toBeInstanceOf(SourceOfIncomeRuleNotConfiguredError);
      }
    });

    it('requires at least one income source', async () => {
      await expect(
        transformer.transform(individual({ selectedIncomeSources: [] })),
      ).rejects.toBeInstanceOf(MissingRequiredFieldError);
    });

    it.each([NaN, Infinity, -Infinity, '1500' as unknown as number, null as unknown as number])(
      'rejects invalid numeric value %p',
      async (bad) => {
        await expect(
          transformer.transform(individual({ monthlyIncome: bad })),
        ).rejects.toBeInstanceOf(InvalidFieldValueError);
        await expect(
          transformer.transform(corporate({ financialInfo: bad })),
        ).rejects.toBeInstanceOf(InvalidFieldValueError);
      },
    );

    it.each(['31/01/1990', '1990-1-5', '1990-02-30', ''])(
      'rejects outbound birth date %p',
      async (bad) => {
        await expect(transformer.transform(individual({ birthDate: bad }))).rejects.toBeInstanceOf(
          InvalidFieldValueError,
        );
      },
    );

    it('rejects an invalid outbound expiry date', async () => {
      await expect(
        transformer.transform(individual({ expiryDate: 'soon' })),
      ).rejects.toBeInstanceOf(InvalidFieldValueError);
    });

    it('rejects missing required pass-through values', async () => {
      for (const over of [
        { kycRefNo: '' },
        { firstName: ' ' },
        { lastName: '' },
        { accountManagerEmail: '' },
      ]) {
        await expect(transformer.transform(individual(over))).rejects.toBeInstanceOf(
          MissingRequiredFieldError,
        );
      }
      await expect(transformer.transform(corporate({ businessName: '' }))).rejects.toBeInstanceOf(
        MissingRequiredFieldError,
      );
    });
  });

  describe('end to end: FLEXCUBE -> canonical -> REIS', () => {
    const mapper = new FlexcubeToCanonicalMapper(
      new StrictIsoFlexcubeDateNormalizer(),
      new YesNoResidentParser(),
    );

    it('turns a FLEXCUBE individual request into the REIS envelope (KYC_REF_NO -> systemId)', async () => {
      const request: FlexcubeCustomerRequest = {
        KYC_REF_NO: 'KYC-E2E-1',
        CUSTOMER_TYPE: 'INDIVIDUAL',
        ACCOUNT_MANAGER_LOGIN: 'amgr',
        ACCOUNT_MANAGER_EMAIL: 'amgr@example.test',
        PEP: 'Y',
        PRODUCT_CODES: ['T-PROD'],
        DISTRIBUTION_CHANNEL: 'T-CHAN',
        individual: {
          FIRST_NAME: 'Testfirst',
          LAST_NAME: 'Testlast',
          BIRTH_DATE: '1990-01-31',
          TIN: 'T-DOC',
          NID: '12345',
          RELATION_PEP: 'N',
          NATIONALITY: 'T-NAT',
          CITIZENSHIP: 'T-CIT',
          PROFESSION: 'T-PROF',
          ACC_PURPOSE: 'T-APIND',
          RESIDENT: 'N',
          FUND_SOURCE: 'T-SALARY',
          MONTHLY_INCOME: 1500.5,
        },
      };
      const r = await transformer.transform(mapper.map(request));
      expect(r).toMatchObject({
        systemName: 'Flexcube',
        systemId: 'KYC-E2E-1',
        formId: 1,
        relations: [],
      });
      expect(r.items).toMatchObject({
        entity_type: 'PP',
        pep: true,
        relation_pep: false,
        resident: '2',
        tin: 'R-DOC',
        nid: '12345',
        account_purpose_individual: 'R-APIND',
        product: ['R-PROD'],
        source_income_individual: 'R-SALARY',
      });
    });

    it('turns a FLEXCUBE corporate request into the REIS envelope', async () => {
      const request: FlexcubeCustomerRequest = {
        KYC_REF_NO: 'KYC-E2E-2',
        CUSTOMER_TYPE: 'CORPORATE',
        ACCOUNT_MANAGER_LOGIN: 'amgr',
        ACCOUNT_MANAGER_EMAIL: 'amgr@example.test',
        PEP: 'N',
        PRODUCT_CODES: ['T-PROD'],
        DISTRIBUTION_CHANNEL: 'T-CHAN',
        corporate: {
          CRP_BUSINESS_NAME: 'Test business nature',
          PARENT_CMPNY_COUNTRY: 'T-INC',
          OPERATION_COUNTRY: ['T-OP1'],
          LEGAL_ENTITY: 'T-LEGAL',
          ACTIVITY: 'T-ACT',
          ACC_PURPOSE: 'T-APCORP',
          SOURCE_OF_INCOME: 'T-CORP-INC',
          FIN_INFO: 1000,
        },
      };
      const r = await transformer.transform(mapper.map(request));
      expect(r).toMatchObject({ systemId: 'KYC-E2E-2', formId: 2, relations: [] });
      expect(r.items).toMatchObject({
        entity_type: 'PM',
        business_name: 'Test business nature',
        incorp_country: 'R-INC',
        nationality: 'R-INC',
        operation_country: ['R-OP1'],
        fin_info: 1000,
      });
    });

    it('a missing mapping stops the whole transformation (no partial payload)', async () => {
      const request = {
        KYC_REF_NO: 'KYC-E2E-3',
        CUSTOMER_TYPE: 'CORPORATE',
        ACCOUNT_MANAGER_LOGIN: 'amgr',
        ACCOUNT_MANAGER_EMAIL: 'amgr@example.test',
        PEP: 'N',
        PRODUCT_CODES: ['T-PROD'],
        DISTRIBUTION_CHANNEL: 'T-CHAN',
        corporate: {
          CRP_BUSINESS_NAME: 'x',
          PARENT_CMPNY_COUNTRY: 'T-INC',
          OPERATION_COUNTRY: ['T-OP1'],
          LEGAL_ENTITY: 'T-LEGAL',
          ACTIVITY: 'T-ACT',
          ACC_PURPOSE: '203',
          SOURCE_OF_INCOME: 'T-CORP-INC',
          FIN_INFO: 1,
        },
      } as FlexcubeCustomerRequest;
      let result: unknown;
      const err = await transformer.transform(mapper.map(request)).then(
        (r) => ((result = r), undefined),
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(UnmappedReferenceValueError);
      expect(result).toBeUndefined();
    });
  });
});
