import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FlexcubeCustomerRequest } from './flexcube-customer.request';

const check = (o: unknown) => validate(plainToInstance(FlexcubeCustomerRequest, o));

const base = {
  KYC_REF_NO: 'KYC0001',
  ACCOUNT_MANAGER_LOGIN: 'amgr',
  ACCOUNT_MANAGER_EMAIL: 'amgr@example.test',
  PEP: 'N',
  PRODUCT_CODES: ['P1'],
  DISTRIBUTION_CHANNEL: 'DC1',
};

const individual = {
  FIRST_NAME: 'A',
  LAST_NAME: 'B',
  BIRTH_DATE: '1990-01-31',
  RELATION_PEP: 'N',
  NATIONALITY: 'x',
  CITIZENSHIP: 'x',
  PROFESSION: 'x',
  ACC_PURPOSE: 'x',
  RESIDENT: 'x',
  FUND_SOURCE: 'SALARY',
  MONTHLY_INCOME: '100',
};

const corporate = {
  CRP_BUSINESS_NAME: 'Trading',
  PARENT_CMPNY_COUNTRY: 'x',
  OPERATION_COUNTRY: ['x'],
  LEGAL_ENTITY: 'x',
  ACTIVITY: 'x',
  ACC_PURPOSE: 'x',
  SOURCE_OF_INCOME: 'x',
  FIN_INFO: 5000,
};

describe('FlexcubeCustomerRequest (provisional)', () => {
  it('accepts a valid individual with CUSTOMER_NO absent', async () => {
    expect(await check({ ...base, CUSTOMER_TYPE: 'INDIVIDUAL', individual })).toHaveLength(0);
  });

  it('accepts a valid corporate', async () => {
    expect(await check({ ...base, CUSTOMER_TYPE: 'CORPORATE', corporate })).toHaveLength(0);
  });

  it('requires KYC_REF_NO', async () => {
    const errs = await check({ ...base, KYC_REF_NO: '', CUSTOMER_TYPE: 'INDIVIDUAL', individual });
    expect(errs.map((e) => e.property)).toContain('KYC_REF_NO');
  });

  it('requires the individual block for INDIVIDUAL', async () => {
    const errs = await check({ ...base, CUSTOMER_TYPE: 'INDIVIDUAL' });
    expect(errs.map((e) => e.property)).toContain('individual');
  });

  it('requires BIRTH_DATE and FIRST_NAME for individuals', async () => {
    const bad = { ...individual, BIRTH_DATE: '', FIRST_NAME: '' };
    const errs = await check({ ...base, CUSTOMER_TYPE: 'INDIVIDUAL', individual: bad });
    const props = errs[0].children?.map((c) => c.property).sort();
    expect(props).toEqual(['BIRTH_DATE', 'FIRST_NAME']);
  });

  it('does not assume the FLEXCUBE date wire format (normalized later)', async () => {
    const dmy = { ...individual, BIRTH_DATE: '31-JAN-1990' };
    expect(await check({ ...base, CUSTOMER_TYPE: 'INDIVIDUAL', individual: dmy })).toHaveLength(0);
  });

  it('coerces numeric strings and rejects non-numeric income / fin_info', async () => {
    const obj = plainToInstance(FlexcubeCustomerRequest, {
      ...base,
      CUSTOMER_TYPE: 'INDIVIDUAL',
      individual: { ...individual, MONTHLY_INCOME: '1500.5' },
    });
    expect(obj.individual?.MONTHLY_INCOME).toBe(1500.5);
    const bad = { ...corporate, FIN_INFO: 'lots' };
    const errs = await check({ ...base, CUSTOMER_TYPE: 'CORPORATE', corporate: bad });
    expect(errs[0].children?.map((c) => c.property)).toEqual(['FIN_INFO']);
  });

  it.each(['', '   ', null, undefined, NaN, 'abc'])(
    'never turns %p into 0 for MONTHLY_INCOME or FIN_INFO',
    async (bad) => {
      const ind = plainToInstance(FlexcubeCustomerRequest, {
        ...base,
        CUSTOMER_TYPE: 'INDIVIDUAL',
        individual: { ...individual, MONTHLY_INCOME: bad },
      });
      expect(ind.individual?.MONTHLY_INCOME).not.toBe(0);
      const indErrs = await validate(ind);
      expect(indErrs[0].children?.map((c) => c.property)).toEqual(['MONTHLY_INCOME']);

      const corp = plainToInstance(FlexcubeCustomerRequest, {
        ...base,
        CUSTOMER_TYPE: 'CORPORATE',
        corporate: { ...corporate, FIN_INFO: bad },
      });
      expect(corp.corporate?.FIN_INFO).not.toBe(0);
      const corpErrs = await validate(corp);
      expect(corpErrs[0].children?.map((c) => c.property)).toEqual(['FIN_INFO']);
    },
  );

  it('accepts numeric strings like "1500.50" and a real zero', async () => {
    const obj = plainToInstance(FlexcubeCustomerRequest, {
      ...base,
      CUSTOMER_TYPE: 'INDIVIDUAL',
      individual: { ...individual, MONTHLY_INCOME: '1500.50' },
    });
    expect(obj.individual?.MONTHLY_INCOME).toBe(1500.5);
    expect(await validate(obj)).toHaveLength(0);
    const zero = plainToInstance(FlexcubeCustomerRequest, {
      ...base,
      CUSTOMER_TYPE: 'INDIVIDUAL',
      individual: { ...individual, MONTHLY_INCOME: 0 },
    });
    expect(await validate(zero)).toHaveLength(0);
  });

  it('rejects non Y/N PEP', async () => {
    const errs = await check({ ...base, PEP: 'yes', CUSTOMER_TYPE: 'CORPORATE', corporate });
    expect(errs.map((e) => e.property)).toContain('PEP');
  });
});
