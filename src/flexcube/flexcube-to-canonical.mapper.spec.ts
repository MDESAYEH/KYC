import { CustomerType } from '../canonical';
import {
  InvalidFieldValueError,
  MissingRequiredFieldError,
} from '../canonical/transformation.errors';
import {
  FlexcubeCorporateDto,
  FlexcubeCustomerRequest,
  FlexcubeIndividualDto,
} from './dto/flexcube-customer.request';
import {
  IFlexcubeDateNormalizer,
  StrictIsoFlexcubeDateNormalizer,
} from './flexcube-date-normalizer';
import { IFlexcubeResidentParser, YesNoResidentParser } from './flexcube-resident-parser';
import { FlexcubeToCanonicalMapper } from './flexcube-to-canonical.mapper';

// Synthetic data only.
const individualDto = (over: Partial<FlexcubeIndividualDto> = {}): FlexcubeIndividualDto => ({
  FIRST_NAME: 'Testfirst',
  LAST_NAME: 'Testlast',
  BIRTH_DATE: '1990-01-31',
  RELATION_PEP: 'N',
  NATIONALITY: 'T-NAT',
  CITIZENSHIP: 'T-CIT',
  PROFESSION: 'T-PROF',
  ACC_PURPOSE: 'T-APIND',
  RESIDENT: 'Y',
  FUND_SOURCE: 'T-SALARY',
  MONTHLY_INCOME: 1500.5,
  ...over,
});

const corporateDto = (over: Partial<FlexcubeCorporateDto> = {}): FlexcubeCorporateDto => ({
  CRP_BUSINESS_NAME: 'Test trading business',
  PARENT_CMPNY_COUNTRY: 'T-INC',
  OPERATION_COUNTRY: ['T-OP1', 'T-OP2'],
  LEGAL_ENTITY: 'T-LEGAL',
  ACTIVITY: 'T-ACT',
  ACC_PURPOSE: 'T-APCORP',
  SOURCE_OF_INCOME: 'T-CORP-INC',
  FIN_INFO: 250000,
  ...over,
});

const individualRequest = (
  over: Partial<FlexcubeCustomerRequest> = {},
  ind: Partial<FlexcubeIndividualDto> = {},
): FlexcubeCustomerRequest => ({
  KYC_REF_NO: 'KYC-0001',
  CUSTOMER_TYPE: 'INDIVIDUAL',
  ACCOUNT_MANAGER_LOGIN: 'amgr',
  ACCOUNT_MANAGER_EMAIL: 'amgr@example.test',
  PEP: 'N',
  PRODUCT_CODES: ['T-PROD'],
  DISTRIBUTION_CHANNEL: 'T-CHAN',
  individual: individualDto(ind),
  ...over,
});

const corporateRequest = (
  over: Partial<FlexcubeCustomerRequest> = {},
  corp: Partial<FlexcubeCorporateDto> = {},
): FlexcubeCustomerRequest => ({
  KYC_REF_NO: 'KYC-0002',
  CUSTOMER_TYPE: 'CORPORATE',
  ACCOUNT_MANAGER_LOGIN: 'amgr',
  ACCOUNT_MANAGER_EMAIL: 'amgr@example.test',
  PEP: 'Y',
  PRODUCT_CODES: ['T-PROD'],
  DISTRIBUTION_CHANNEL: 'T-CHAN',
  corporate: corporateDto(corp),
  ...over,
});

const mapperWith = (
  dates: IFlexcubeDateNormalizer = new StrictIsoFlexcubeDateNormalizer(),
  resident: IFlexcubeResidentParser = new YesNoResidentParser(),
) => new FlexcubeToCanonicalMapper(dates, resident);

describe('FlexcubeToCanonicalMapper', () => {
  const mapper = mapperWith();

  describe('individual', () => {
    it('maps the confirmed fields and renames FLEXCUBE names to canonical names', () => {
      const c = mapper.map(individualRequest());
      expect(c).toEqual({
        customerType: CustomerType.INDIVIDUAL,
        kycRefNo: 'KYC-0001',
        customerNo: null,
        accountManagerLogin: 'amgr',
        accountManagerEmail: 'amgr@example.test',
        pep: false,
        productCodes: ['T-PROD'], // raw FLEXCUBE value, translated later
        distributionChannel: 'T-CHAN',
        firstName: 'Testfirst',
        lastName: 'Testlast',
        birthDate: '1990-01-31',
        relationPep: false,
        nationality: 'T-NAT',
        citizenship: 'T-CIT',
        profession: 'T-PROF',
        accountPurpose: 'T-APIND', // FLEXCUBE ACC_PURPOSE -> canonical accountPurpose
        isResident: true,
        selectedIncomeSources: ['T-SALARY'],
        monthlyIncome: 1500.5,
      });
    });

    it('keeps CUSTOMER_NO nullable and preserves it when present', () => {
      expect(mapper.map(individualRequest()).customerNo).toBeNull();
      expect(mapper.map(individualRequest({ CUSTOMER_NO: '' })).customerNo).toBeNull();
      expect(mapper.map(individualRequest({ CUSTOMER_NO: '   ' })).customerNo).toBeNull();
      expect(mapper.map(individualRequest({ CUSTOMER_NO: 'C-77' })).customerNo).toBe('C-77');
    });

    it('does not need REIS-style duplicate fields from FLEXCUBE', () => {
      const c = mapper.map(individualRequest());
      expect(c).not.toHaveProperty('nationalityCustomer');
      expect(c).not.toHaveProperty('citizenshipCustomer');
    });

    it('converts Y/N to booleans and rejects anything else', () => {
      const yes = mapper.map(individualRequest({ PEP: 'Y' }, { RELATION_PEP: 'Y' }));
      expect(yes).toMatchObject({ pep: true, relationPep: true });
      for (const bad of ['y', 'n', 'Yes', '', 'true', undefined, null]) {
        expect(() => mapper.map(individualRequest({ PEP: bad as string }))).toThrow(
          InvalidFieldValueError,
        );
      }
      expect(() => mapper.map(individualRequest({}, { RELATION_PEP: 'maybe' }))).toThrow(
        InvalidFieldValueError,
      );
    });

    it('interprets resident through the injected parser (provisional Y/N default)', () => {
      expect(mapper.map(individualRequest({}, { RESIDENT: 'N' }))).toMatchObject({
        isResident: false,
      });
      expect(() => mapper.map(individualRequest({}, { RESIDENT: 'resident' }))).toThrow(
        InvalidFieldValueError,
      );
      const custom = mapperWith(undefined, { parse: (raw) => raw === 'RES' });
      expect(custom.map(individualRequest({}, { RESIDENT: 'RES' }))).toMatchObject({
        isResident: true,
      });
      expect(custom.map(individualRequest({}, { RESIDENT: 'NONRES' }))).toMatchObject({
        isResident: false,
      });
    });

    it('normalizes dates through the injected normalizer (not hard-wired to ISO)', () => {
      const dmy: IFlexcubeDateNormalizer = {
        normalize: (raw) => raw.split('/').reverse().join('-'),
      };
      const c = mapperWith(dmy).map(
        individualRequest({}, { BIRTH_DATE: '31/01/1990', EXPIRY_DATE: '01/02/2030' }),
      );
      expect(c).toMatchObject({
        birthDate: '1990-01-31',
        expiryDate: '2030-02-01',
      });
    });

    it('fails on a date the normalizer cannot handle', () => {
      for (const bad of ['31/01/1990', '1990-02-30', 'garbage']) {
        expect(() => mapper.map(individualRequest({}, { BIRTH_DATE: bad }))).toThrow(
          InvalidFieldValueError,
        );
      }
      expect(() => mapper.map(individualRequest({}, { EXPIRY_DATE: 'nope' }))).toThrow(
        InvalidFieldValueError,
      );
    });

    it('requires BIRTH_DATE, names and the other mandatory fields', () => {
      expect(() => mapper.map(individualRequest({}, { BIRTH_DATE: '' }))).toThrow(
        MissingRequiredFieldError,
      );
      expect(() => mapper.map(individualRequest({}, { FIRST_NAME: '  ' }))).toThrow(
        MissingRequiredFieldError,
      );
      expect(() =>
        mapper.map(individualRequest({}, { LAST_NAME: undefined as unknown as string })),
      ).toThrow(MissingRequiredFieldError);
      expect(() => mapper.map(individualRequest({ KYC_REF_NO: '' }))).toThrow(
        MissingRequiredFieldError,
      );
      expect(() => mapper.map(individualRequest({ PRODUCT_CODES: [' '] }))).toThrow(
        MissingRequiredFieldError,
      );
      expect(() => mapper.map(individualRequest({ individual: undefined }))).toThrow(
        MissingRequiredFieldError,
      );
      for (const f of [
        'NATIONALITY',
        'CITIZENSHIP',
        'PROFESSION',
        'ACC_PURPOSE',
        'RESIDENT',
      ] as const) {
        expect(() => mapper.map(individualRequest({}, { [f]: '' }))).toThrow(
          MissingRequiredFieldError,
        );
      }
    });

    it('rejects invalid numbers instead of turning them into 0', () => {
      for (const bad of ['', ' ', null, undefined, NaN, Infinity, 'abc', '1e3', true]) {
        expect(() =>
          mapper.map(individualRequest({}, { MONTHLY_INCOME: bad as unknown as number })),
        ).toThrow(InvalidFieldValueError);
      }
      expect(
        mapper.map(individualRequest({}, { MONTHLY_INCOME: '1500.50' as unknown as number })),
      ).toMatchObject({
        monthlyIncome: 1500.5,
      });
      expect(mapper.map(individualRequest({}, { MONTHLY_INCOME: 0 }))).toMatchObject({
        monthlyIncome: 0,
      });
    });

    it('keeps optional fields optional: absent or blank means not provided', () => {
      const c = mapper.map(individualRequest({}, { BIRTH_PLACE: '', TIN: ' ', NID: undefined }));
      for (const k of ['birthPlace', 'documentTypeRaw', 'nid', 'issueDate', 'expiryDate']) {
        expect(c).not.toHaveProperty(k);
      }
    });

    it('carries optional fields through unchanged and keeps TIN (type) separate from NID (number)', () => {
      const c = mapper.map(
        individualRequest(
          {},
          {
            BIRTH_PLACE: 'Testville',
            TIN: 'free text ',
            NID: ' 0012345 ',
            EXPIRY_DATE: '2030-02-01',
          },
        ),
      );
      expect(c).toMatchObject({
        birthPlace: 'Testville',
        documentTypeRaw: 'free text ', // unvalidated raw text; only the DOCUMENT_TYPE mapping may approve it
        nid: ' 0012345 ',
        expiryDate: '2030-02-01',
      });
    });

    it('carries the single FUND_SOURCE value as the selected income source', () => {
      expect(mapper.map(individualRequest({}, { FUND_SOURCE: 'SALARY' }))).toMatchObject({
        selectedIncomeSources: ['SALARY'],
      });
      for (const bad of ['', ' ', undefined]) {
        expect(() =>
          mapper.map(individualRequest({}, { FUND_SOURCE: bad as unknown as string })),
        ).toThrow(MissingRequiredFieldError);
      }
    });

    it('keeps every product code in order and rejects an empty or blank list', () => {
      expect(mapper.map(individualRequest({ PRODUCT_CODES: ['T-PROD', 'T-PROD2'] }))).toMatchObject(
        { productCodes: ['T-PROD', 'T-PROD2'] },
      );
      for (const bad of [[], undefined, ['T-PROD', ' ']]) {
        expect(() =>
          mapper.map(individualRequest({ PRODUCT_CODES: bad as unknown as string[] })),
        ).toThrow(MissingRequiredFieldError);
      }
    });

    it('rejects an unknown customer type', () => {
      expect(() => mapper.map(individualRequest({ CUSTOMER_TYPE: 'TRUST' as never }))).toThrow(
        InvalidFieldValueError,
      );
    });
  });

  describe('corporate', () => {
    it('maps CRP_BUSINESS_NAME -> businessName and PARENT_CMPNY_COUNTRY -> incorporationCountry (raw)', () => {
      const c = mapper.map(corporateRequest());
      expect(c).toEqual({
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
      });
    });

    it('preserves the operation countries as a list and requires at least one', () => {
      expect(mapper.map(corporateRequest({}, { OPERATION_COUNTRY: ['A'] }))).toMatchObject({
        operationCountries: ['A'],
      });
      expect(() => mapper.map(corporateRequest({}, { OPERATION_COUNTRY: [] }))).toThrow(
        MissingRequiredFieldError,
      );
      expect(() => mapper.map(corporateRequest({}, { OPERATION_COUNTRY: ['A', ' '] }))).toThrow(
        MissingRequiredFieldError,
      );
      expect(() =>
        mapper.map(corporateRequest({}, { OPERATION_COUNTRY: 'A' as unknown as string[] })),
      ).toThrow(MissingRequiredFieldError);
    });

    it('keeps TRADE_NO optional', () => {
      expect(mapper.map(corporateRequest())).not.toHaveProperty('tradeNo');
      expect(mapper.map(corporateRequest({}, { TRADE_NO: 'TR-1' }))).toMatchObject({
        tradeNo: 'TR-1',
      });
      expect(mapper.map(corporateRequest({}, { TRADE_NO: '' }))).not.toHaveProperty('tradeNo');
    });

    it('requires the corporate block and fields, and a valid FIN_INFO', () => {
      expect(() => mapper.map(corporateRequest({ corporate: undefined }))).toThrow(
        MissingRequiredFieldError,
      );
      expect(() => mapper.map(corporateRequest({}, { CRP_BUSINESS_NAME: '' }))).toThrow(
        MissingRequiredFieldError,
      );
      expect(() => mapper.map(corporateRequest({}, { PARENT_CMPNY_COUNTRY: '' }))).toThrow(
        MissingRequiredFieldError,
      );
      for (const bad of ['', '  ', null, undefined, NaN, 'lots']) {
        expect(() =>
          mapper.map(corporateRequest({}, { FIN_INFO: bad as unknown as number })),
        ).toThrow(InvalidFieldValueError);
      }
    });
  });
});
