import { CustomerType } from '../../canonical';
import { CanonicalToReisTransformer } from '../../reis/canonical-to-reis.transformer';
import { ReisConfig } from '../../reis/reis.config';
import { TypeOrmReferenceMappingRepository } from '../../persistence/typeorm-reference-mapping.repository';
import { createTestDataSource } from '../../../test/support/test-database';
import { ReferenceMappingType, UnmappedReferenceValueError } from '../reference-mapping';
import { ReferenceMappingService } from '../reference-mapping.service';
import { SingleSelectionSourceOfIncomeStrategy } from '../single-source-of-income.strategy';
import { agreedReferenceMappings, seedReferenceMappings } from './agreed-reference-mappings';

describe('agreed reference mappings (AIIB_KYC_Appendix, Reis V1.4)', () => {
  const count = (t: ReferenceMappingType) =>
    agreedReferenceMappings().filter((m) => m.mappingType === t).length;

  it('contains every agreed list with the expected size', () => {
    expect(count(ReferenceMappingType.NATIONALITY)).toBe(247);
    expect(count(ReferenceMappingType.PRODUCT)).toBe(117);
    expect(count(ReferenceMappingType.PROFESSION)).toBe(7);
    expect(count(ReferenceMappingType.ACCOUNT_PURPOSE_INDIVIDUAL)).toBe(7);
    expect(count(ReferenceMappingType.ACCOUNT_PURPOSE_CORPORATE)).toBe(5);
    expect(count(ReferenceMappingType.ACTIVITY)).toBe(5);
    expect(count(ReferenceMappingType.LEGAL_ENTITY)).toBe(8);
    expect(count(ReferenceMappingType.DISTRIBUTION_CHANNEL)).toBe(7);
    expect(count(ReferenceMappingType.SOURCE_OF_INCOME)).toBe(10);
    expect(count(ReferenceMappingType.DOCUMENT_TYPE)).toBe(1);
  });

  it('is an identity mapping (FLEXCUBE stores the agreed Reis codes)', () => {
    for (const m of agreedReferenceMappings()) expect(m.reisValue).toBe(m.flexcubeValue);
  });

  it('includes the 14 countries added in UAT1 and excludes the deactivated codes', () => {
    const countries = agreedReferenceMappings()
      .filter((m) => m.mappingType === ReferenceMappingType.NATIONALITY)
      .map((m) => m.flexcubeValue);
    for (const c of [
      'BF',
      'BL',
      'BQ',
      'CW',
      'EH',
      'JE',
      'NF',
      'NR',
      'NU',
      'RE',
      'SS',
      'SX',
      'VC',
      'VG',
    ]) {
      expect(countries).toContain(c);
    }
    for (const c of ['DBZ', 'IL', 'EU', 'GBP', 'IK', 'RSA', 'AN'])
      expect(countries).not.toContain(c);
  });

  describe('seeded into the real repository', () => {
    let transformer: CanonicalToReisTransformer;
    let service: ReferenceMappingService;

    beforeAll(async () => {
      const repo = new TypeOrmReferenceMappingRepository(await createTestDataSource());
      const first = await seedReferenceMappings(repo);
      const again = await seedReferenceMappings(repo); // idempotent
      expect(again.total).toBe(first.total);
      expect((await repo.list()).length).toBe(first.total);
      service = new ReferenceMappingService(repo);
      transformer = new CanonicalToReisTransformer(
        service,
        new SingleSelectionSourceOfIncomeStrategy(service),
        { systemName: 'Flexcube' } as ReisConfig,
      );
    });

    it('transforms a Postman V1.4-like individual (SC-002 values)', async () => {
      const r = await transformer.transform({
        customerType: CustomerType.INDIVIDUAL,
        kycRefNo: 'KYC-SEED-1',
        customerNo: null,
        accountManagerLogin: 'account_manager',
        accountManagerEmail: 'KYC@aiib.ly',
        pep: false,
        productCodes: ['SALR'],
        distributionChannel: '00',
        firstName: 'Test',
        lastName: 'Customer',
        birthDate: '1985-03-15',
        relationPep: false,
        nationality: 'LY',
        citizenship: 'LY',
        profession: 'PRSE',
        accountPurpose: 'JOBS',
        isResident: true,
        selectedIncomeSources: ['BUSN'],
        monthlyIncome: 3000,
        nid: 'P10000001',
      });
      expect(r.items).toMatchObject({
        nationality_customer: 'LY',
        profession: 'PRSE',
        account_purpose_individual: 'JOBS',
        distribution_channel: '00',
        product: ['SALR'],
        source_income_individual: 'BUSN',
        tin: 'PASS',
      });
    });

    it('transforms a Postman V1.4-like organization (SC-011 values)', async () => {
      const r = await transformer.transform({
        customerType: CustomerType.CORPORATE,
        kycRefNo: 'KYC-SEED-2',
        customerNo: null,
        accountManagerLogin: 'account_manager',
        accountManagerEmail: 'KYC@aiib.ly',
        pep: false,
        productCodes: ['FX01', 'LC01'],
        distributionChannel: '04',
        businessName: 'Test Co',
        incorporationCountry: 'DZ',
        operationCountries: ['DZ', 'LB'],
        legalEntity: 'NNPFT',
        activity: 'NOPO',
        accountPurpose: 'NOPO',
        sourceOfIncome: 'CENB',
        financialInfo: 500000,
      });
      expect(r.items).toMatchObject({
        incorp_country: 'DZ',
        operation_country: ['DZ', 'LB'],
        legal_entity: 'NNPFT',
        source_income_organization: 'CENB',
        product: ['FX01', 'LC01'],
      });
    });

    it('rejects old V1.2 / FLEXCUBE-only values before any REIS call', async () => {
      for (const [type, value] of [
        [ReferenceMappingType.PROFESSION, 'EMPL'],
        [ReferenceMappingType.ACCOUNT_PURPOSE_INDIVIDUAL, 'CURSTF'],
        [ReferenceMappingType.DISTRIBUTION_CHANNEL, '1'],
        [ReferenceMappingType.DOCUMENT_TYPE, 'PAS'],
        [ReferenceMappingType.ACCOUNT_PURPOSE_CORPORATE, '203'],
        [ReferenceMappingType.NATIONALITY, 'EU'],
      ] as const) {
        await expect(service.resolve(type, value)).rejects.toBeInstanceOf(
          UnmappedReferenceValueError,
        );
      }
    });
  });
});
