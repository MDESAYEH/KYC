import { CanonicalCorporateCustomer, CustomerType } from '../canonical';
import {
  InvalidFieldValueError,
  MissingRequiredFieldError,
} from '../canonical/transformation.errors';
import {
  FlexcubeCorporateDto,
  FlexcubeCustomerRequest,
  FlexcubeRelatedPartyDto,
} from './dto/flexcube-customer.request';
import { StrictIsoFlexcubeDateNormalizer } from './flexcube-date-normalizer';
import { YesNoResidentParser } from './flexcube-resident-parser';
import { FlexcubeToCanonicalMapper } from './flexcube-to-canonical.mapper';
import { RELATIONSHIP_CODE_TO_REIS_ID } from './related-party';

// Synthetic data only.
const individualParty = (over: Partial<FlexcubeRelatedPartyDto> = {}): FlexcubeRelatedPartyDto => ({
  KYC_ID: 'P1',
  NAME: 'Synthetic Arabic Name',
  KYC_KEYPERSON_TYPE: 'I',
  RELATIONSHIP: 'CEO',
  DATE_OF_BIRTH: '1980-05-06',
  NATIONALITY: 'T-REL-NAT',
  ADDRESS_COUNTRY: 'T-REL-CIT',
  PLACE_OF_BIRTH: 'Testville',
  HAS_CUSTOM_ROW: true,
  FIRST_NAME: 'Relfirst',
  LAST_NAME: 'Rellast',
  PASSPORT_NUMBER: 'PX1',
  PASSPORT_ISSUE_DATE: '2020-01-02',
  PASSPORT_EXPIRY_DATE: '2030-01-01',
  PLACE_OF_ISSUE: 'Testburg',
  NATIONAL_ID: 'NAT-1',
  ...over,
});

const companyParty = (over: Partial<FlexcubeRelatedPartyDto> = {}): FlexcubeRelatedPartyDto => ({
  KYC_ID: 'C1',
  NAME: 'Sub Co',
  KYC_KEYPERSON_TYPE: 'C',
  RELATIONSHIP: 'OWNER',
  ADDRESS_COUNTRY: 'T-REL-NAT',
  TIN: 'TRD-9',
  HAS_CUSTOM_ROW: false,
  ...over,
});

const request = (
  parties: FlexcubeRelatedPartyDto[],
  kyc = 'KYC-0002',
): FlexcubeCustomerRequest => ({
  KYC_REF_NO: kyc,
  CUSTOMER_TYPE: 'CORPORATE',
  ACCOUNT_MANAGER_LOGIN: 'amgr',
  ACCOUNT_MANAGER_EMAIL: 'amgr@example.test',
  PEP: 'N',
  PRODUCT_CODES: ['T-PROD'],
  DISTRIBUTION_CHANNEL: 'T-CHAN',
  corporate: {
    CRP_BUSINESS_NAME: 'Test trading business',
    PARENT_CMPNY_COUNTRY: 'T-INC',
    OPERATION_COUNTRY: ['T-OP1'],
    LEGAL_ENTITY: 'T-LEGAL',
    ACTIVITY: 'T-ACT',
    ACC_PURPOSE: 'T-APCORP',
    SOURCE_OF_INCOME: 'T-CORP-INC',
    FIN_INFO: 250000,
    RELATED_PARTIES: parties,
  } as FlexcubeCorporateDto,
});

describe('FlexcubeToCanonicalMapper - corporate related parties (key persons)', () => {
  const mapper = new FlexcubeToCanonicalMapper(
    new StrictIsoFlexcubeDateNormalizer(),
    new YesNoResidentParser(),
  );
  const map = (parties: FlexcubeRelatedPartyDto[], kyc?: string) =>
    mapper.map(request(parties, kyc)) as CanonicalCorporateCustomer;
  const failure = (parties: FlexcubeRelatedPartyDto[], kyc?: string): Error => {
    try {
      map(parties, kyc);
    } catch (e) {
      return e as Error;
    }
    throw new Error('expected a validation error');
  };

  it('has no related persons when the company has no key persons', () => {
    expect(map([]).relatedPersons).toBeUndefined();
    expect(
      mapper.map({
        ...request([]),
        corporate: { ...request([]).corporate!, RELATED_PARTIES: undefined },
      } as FlexcubeCustomerRequest),
    ).not.toHaveProperty('relatedPersons');
  });

  it('maps an individual key person (type I -> formId 3 data), systemId = <company>-<KYC_ID>', () => {
    expect(map([individualParty({ KYC_ID: '  P1 ' })]).relatedPersons).toEqual([
      {
        relatedPartyType: CustomerType.INDIVIDUAL,
        parentKycRefNo: 'KYC-0002',
        systemId: 'KYC-0002-P1',
        relationshipId: 3,
        firstName: 'Relfirst',
        lastName: 'Rellast',
        birthDate: '1980-05-06',
        birthPlace: 'Testville',
        nationality: 'T-REL-NAT',
        citizenship: 'T-REL-CIT',
        nid: 'PX1',
        issueDate: '2020-01-02',
        validUntil: '2030-01-01',
        issuePlace: 'Testburg',
        nationalId: 'NAT-1',
      },
    ]);
  });

  it('maps a company key person (type C -> formId 4 data): NAME is business_name, TIN is trade_no', () => {
    expect(map([companyParty()]).relatedPersons).toEqual([
      {
        relatedPartyType: CustomerType.CORPORATE,
        parentKycRefNo: 'KYC-0002',
        systemId: 'KYC-0002-C1',
        relationshipId: 7,
        businessName: 'Sub Co',
        nationality: 'T-REL-NAT',
        tradeNo: 'TRD-9',
      },
    ]);
    expect(
      (map([companyParty({ TIN: undefined })]).relatedPersons![0] as { tradeNo?: string }).tradeNo,
    ).toBeUndefined();
  });

  it('maps every FLEXCUBE RELATIONSHIP code to its REIS id', () => {
    expect(RELATIONSHIP_CODE_TO_REIS_ID).toEqual({
      AUTHORIZED: 1,
      BENEFICIAR: 2,
      CEO: 3,
      CFO: 4,
      COOWNER: 5,
      MANAGER: 6,
      OWNER: 7,
      SHAREHOLDE: 8,
    });
    for (const [code, id] of Object.entries(RELATIONSHIP_CODE_TO_REIS_ID)) {
      expect(map([individualParty({ RELATIONSHIP: code })]).relatedPersons![0].relationshipId).toBe(
        id,
      );
    }
  });

  it.each(['BENEFICIAR', 'COOWNER', 'OWNER', 'SHAREHOLDE'])(
    'allows %s for a company party',
    (code) => {
      expect(map([companyParty({ RELATIONSHIP: code })]).relatedPersons).toHaveLength(1);
    },
  );

  it.each(['CEO', 'CFO', 'MANAGER', 'AUTHORIZED'])(
    'rejects %s for a company party, naming the field only',
    (code) => {
      const e = failure([companyParty({ RELATIONSHIP: code })]);
      expect(e).toBeInstanceOf(InvalidFieldValueError);
      expect(e.message).toContain('RELATED_PARTIES[0].RELATIONSHIP');
      expect(e.message).not.toContain(code);
    },
  );

  it('rejects an unknown, blank or differently-cased relationship code without echoing it', () => {
    for (const code of ['BOSS', 'ceo', undefined]) {
      const e = failure([individualParty({ RELATIONSHIP: code })]);
      expect(e).toBeInstanceOf(
        code === undefined ? MissingRequiredFieldError : InvalidFieldValueError,
      );
      expect(e.message).toContain('RELATED_PARTIES[0].RELATIONSHIP');
      if (code) expect(e.message).not.toContain(code);
    }
    // inherited object keys are not codes
    expect(failure([individualParty({ RELATIONSHIP: 'constructor' })])).toBeInstanceOf(
      InvalidFieldValueError,
    );
  });

  it('rejects a bad key-person type', () => {
    const e = failure([individualParty({ KYC_KEYPERSON_TYPE: 'X' as 'I' })]);
    expect(e).toBeInstanceOf(InvalidFieldValueError);
    expect(e.message).toContain('KYC_KEYPERSON_TYPE');
  });

  it('rejects the whole request when KYC_ID is blank', () => {
    for (const KYC_ID of [undefined, '', '   ']) {
      const e = failure([individualParty(), individualParty({ KYC_ID })]);
      expect(e).toBeInstanceOf(MissingRequiredFieldError);
      expect(e.message).toContain('RELATED_PARTIES[1].KYC_ID');
    }
  });

  it('rejects two related parties of the same company with the same systemId (KYC_ID trimmed)', () => {
    const e = failure([individualParty({ KYC_ID: 'P1' }), companyParty({ KYC_ID: ' P1 ' })]);
    expect(e).toBeInstanceOf(InvalidFieldValueError);
    expect(e.message).toContain('RELATED_PARTIES[1].KYC_ID');
    expect(e.message).not.toContain('KYC-0002-P1');
  });

  it('the same KYC_ID in two different companies is fine (systemId includes the company)', () => {
    expect(map([individualParty()], 'KYC-A').relatedPersons![0].systemId).toBe('KYC-A-P1');
    expect(map([individualParty()], 'KYC-B').relatedPersons![0].systemId).toBe('KYC-B-P1');
  });

  it('rejects an individual whose CUSTOM row is missing (not silently dropped)', () => {
    const e = failure([individualParty({ HAS_CUSTOM_ROW: false })]);
    expect(e).toBeInstanceOf(MissingRequiredFieldError);
    expect(e.message).toContain('STTM_KYC_CORP_KEYPERSONS_CUSTOM');
  });

  it.each([
    'FIRST_NAME',
    'LAST_NAME',
    'DATE_OF_BIRTH',
    'NATIONALITY',
    'ADDRESS_COUNTRY',
    'PASSPORT_NUMBER',
    'PASSPORT_ISSUE_DATE',
    'PASSPORT_EXPIRY_DATE',
  ] as const)('rejects an individual without %s', (field) => {
    const e = failure([individualParty({ [field]: undefined })]);
    expect(e).toBeInstanceOf(MissingRequiredFieldError);
    expect(e.message).toContain(`RELATED_PARTIES[0].${field}`);
  });

  it.each(['PLACE_OF_BIRTH', 'PLACE_OF_ISSUE', 'NATIONAL_ID'] as const)(
    '%s is optional for an individual',
    (field) => {
      expect(map([individualParty({ [field]: undefined })]).relatedPersons).toHaveLength(1);
    },
  );

  it('rejects malformed dates naming the field only', () => {
    const e = failure([individualParty({ PASSPORT_ISSUE_DATE: '02/01/2020' })]);
    expect(e).toBeInstanceOf(InvalidFieldValueError);
    expect(e.message).toContain('RELATED_PARTIES[0].PASSPORT_ISSUE_DATE');
    expect(e.message).not.toContain('02/01/2020');
  });

  it('rejects a company party without NAME or ADDRESS_COUNTRY', () => {
    expect(failure([companyParty({ NAME: undefined })])).toBeInstanceOf(MissingRequiredFieldError);
    expect(failure([companyParty({ ADDRESS_COUNTRY: undefined })])).toBeInstanceOf(
      MissingRequiredFieldError,
    );
  });
});
