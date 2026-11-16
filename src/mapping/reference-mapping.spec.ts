import { ReferenceMappingType, UnmappedReferenceValueError } from './reference-mapping';

describe('reference mapping types', () => {
  it('UnmappedReferenceValueError names the type and value', () => {
    const e = new UnmappedReferenceValueError(ReferenceMappingType.DOCUMENT_TYPE, 'free text');
    expect(e.message).toContain('DOCUMENT_TYPE');
    expect(e.message).toContain('free text');
    expect(e).toBeInstanceOf(Error);
  });

  it('declares every agreed mapping type', () => {
    expect(Object.values(ReferenceMappingType).sort()).toEqual(
      [
        'ACCOUNT_PURPOSE_CORPORATE',
        'ACCOUNT_PURPOSE_INDIVIDUAL',
        'ACTIVITY',
        'DISTRIBUTION_CHANNEL',
        'DOCUMENT_TYPE',
        'LEGAL_ENTITY',
        'NATIONALITY',
        'PRODUCT',
        'PROFESSION',
        'SOURCE_OF_INCOME',
      ].sort(),
    );
  });
});
