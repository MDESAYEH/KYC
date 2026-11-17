import { FakeFlexcubeDb } from '../../test/support/fake-flexcube-db';
import { CORPORATE_ROW, INDIVIDUAL_ROW } from '../../test/support/sync-fixtures';
import { CanonicalKycCustomer } from '../canonical';
import { FlexcubeToCanonicalMapper } from '../flexcube/flexcube-to-canonical.mapper';
import { StrictIsoFlexcubeDateNormalizer } from '../flexcube/flexcube-date-normalizer';
import { YesNoResidentParser } from '../flexcube/flexcube-resident-parser';
import { FlexcubeKycSource } from '../flexcube/source/flexcube-kyc-source';
import { ReferenceMappingService } from '../mapping/reference-mapping.service';
import { seedReferenceMappings } from '../mapping/seed/agreed-reference-mappings';
import { SingleSelectionSourceOfIncomeStrategy } from '../mapping/single-source-of-income.strategy';
import { TypeOrmReferenceMappingRepository } from '../persistence/typeorm-reference-mapping.repository';
import { createTestDataSource } from '../../test/support/test-database';
import { CanonicalToReisTransformer } from './canonical-to-reis.transformer';
import { CifIdentityError, requireCif } from './cif-identity';
import { CifOnboardingPreview } from './cif-onboarding-preview';
import { ReisConfig } from './reis.config';

describe('offline CIF payload preview (synthetic data, no source mapping claim)', () => {
  let ds: Awaited<ReturnType<typeof createTestDataSource>>;
  let preview: CifOnboardingPreview;
  let db: FakeFlexcubeDb;
  const mapper = new FlexcubeToCanonicalMapper(
    new StrictIsoFlexcubeDateNormalizer(),
    new YesNoResidentParser(),
  );
  const customer = async (
    type: 'INDIVIDUAL' | 'CORPORATE',
    ref = 'KYC-ORIGINAL',
    cif = '000045',
  ): Promise<CanonicalKycCustomer> => {
    db.details.set(ref, type === 'INDIVIDUAL' ? INDIVIDUAL_ROW : CORPORATE_ROW);
    db.products.set(ref, ['SALR']);
    db.countries.set(ref, ['LY']);
    const raw = await new FlexcubeKycSource(db, 'STAGE', '2026-11-16').load({
      kycRefNo: ref,
      seqNo: 1,
      customerType: type,
    });
    // The source intentionally does NOT populate CUSTOMER_NO. This fixture is not a proposed SQL mapping.
    expect(raw.CUSTOMER_NO).toBeUndefined();
    return mapper.map({ ...raw, CUSTOMER_NO: cif });
  };
  beforeAll(async () => {
    ds = await createTestDataSource();
    const repo = new TypeOrmReferenceMappingRepository(ds);
    await seedReferenceMappings(repo);
    const refs = new ReferenceMappingService(repo);
    preview = new CifOnboardingPreview(
      new CanonicalToReisTransformer(refs, new SingleSelectionSourceOfIncomeStrategy(refs), {
        systemName: 'ConfiguredSystem',
      } as ReisConfig),
    );
  });
  beforeEach(() => {
    db = new FakeFlexcubeDb();
  });
  afterAll(async () => {
    await ds.destroy();
  });

  it.each(['INDIVIDUAL', 'CORPORATE'] as const)(
    '%s uses only CIF and preserves the original KYC',
    async (type) => {
      const c = await customer(type);
      const snapshot = JSON.stringify(c);
      const result = await preview.preview(c);
      expect(result).toMatchObject({
        submissionAllowed: false,
        sourceVerified: false,
        request: {
          systemName: 'ConfiguredSystem',
          systemId: '000045',
          formId: type === 'INDIVIDUAL' ? 1 : 2,
        },
      });
      expect(result.request.systemId).not.toBe(c.kycRefNo);
      expect(JSON.stringify(c)).toBe(snapshot);
      expect(db.statements.every((sql) => sql.trim().startsWith('SELECT'))).toBe(true);
      expect(await ds.query('SELECT COUNT(*) AS n FROM kyc_case')).toEqual([{ n: 0 }]);
    },
  );

  it.each([null, undefined, '', '   '])(
    'missing CIF (%s) never falls back to a KYC reference',
    async (value) => {
      const c = await customer('INDIVIDUAL');
      c.customerNo = value as string | null;
      await expect(preview.preview(c)).rejects.toMatchObject({
        code: 'MISSING_CIF',
        field: 'CUSTOMER_NO',
      });
    },
  );
  it.each([12345, ['0001', '0002'], {}])(
    'rejects non-string/ambiguous values (%j) without exposing them',
    (value) => {
      let error: unknown;
      try {
        requireCif(value);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(CifIdentityError);
      expect(error).toMatchObject({ code: 'INVALID_CIF', field: 'CUSTOMER_NO' });
      expect((error as Error).message).not.toContain(JSON.stringify(value));
    },
  );
  it('does not invent an officially unspecified CIF pattern', () => {
    expect(requireCif('  000045  ')).toBe('000045');
    expect(requireCif('BANK-CIF-A')).toBe('BANK-CIF-A');
  });
  it('different KYC references and repeated previews of the same CIF retain one customer identity', async () => {
    const a = await customer('INDIVIDUAL', 'KYC-A');
    const b = await customer('INDIVIDUAL', 'KYC-B');
    expect((await preview.preview(a)).request.systemId).toBe(
      (await preview.preview(b)).request.systemId,
    );
    expect((await preview.preview(a)).request.systemId).toBe('000045');
    expect(a.kycRefNo).toBe('KYC-A');
    expect(b.kycRefNo).toBe('KYC-B');
    // Equality is not permission to send either KYC or proof that the source relation is valid.
  });
  it('preserves related-party identities, but rejects a collision with the primary CIF', async () => {
    const c = await customer('CORPORATE');
    if (c.customerType !== 'CORPORATE') throw Error('fixture type');
    c.relatedPersons = [
      {
        parentKycRefNo: c.kycRefNo,
        systemId: `${c.kycRefNo}-RELATED-1`,
        relatedPartyType: 'CORPORATE' as never,
        relationshipId: 7,
        businessName: 'Synthetic Related Company',
        nationality: 'LY',
      },
    ];
    expect((await preview.preview(c)).request.relations[0].systemId).toBe('KYC-ORIGINAL-RELATED-1');
    c.customerNo = c.relatedPersons[0].systemId;
    await expect(preview.preview(c)).rejects.toMatchObject({ field: 'relation.systemId' });
  });
});
