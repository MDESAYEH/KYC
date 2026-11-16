import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CustomerStatusDto } from './customer-status.dto';

const check = (o: unknown) => validate(plainToInstance(CustomerStatusDto, o));

describe('CustomerStatusDto', () => {
  const sample = {
    status: 'BLOCKED',
    systemId: '2378287',
    customerId: 217489,
    systemName: 'Flexcube',
    ServiceType: 'CUSTOMER_STATUS',
  };

  it('accepts the confirmed REIS example', async () => {
    expect(await check(sample)).toHaveLength(0);
  });

  it('accepts CUSTOMER', async () => {
    expect(await check({ ...sample, status: 'CUSTOMER' })).toHaveLength(0);
  });

  it.each(['CLEAN', 'PENDING', 'blocked', ''])('rejects status %p', async (status) => {
    expect((await check({ ...sample, status })).length).toBeGreaterThan(0);
  });

  it('requires status and systemId but not customerId', async () => {
    const errs = await check({});
    expect(errs.map((e) => e.property).sort()).toEqual(['status', 'systemId']);
    expect(await check({ status: 'CUSTOMER', systemId: 'S1' })).toHaveLength(0);
    expect(await check({ status: 'CUSTOMER', systemId: 'S1', customerId: null })).toHaveLength(0);
  });

  it.each([1.5, '5', true, {}])('rejects a non-integer customerId %p', async (customerId) => {
    expect((await check({ ...sample, customerId })).map((e) => e.property)).toEqual(['customerId']);
  });

  it('validates ServiceType against the sample value only when present', async () => {
    expect(await check({ status: 'BLOCKED', systemId: 'S1' })).toHaveLength(0);
    expect(
      (await check({ ...sample, ServiceType: 'SOMETHING_ELSE' })).map((e) => e.property),
    ).toEqual(['ServiceType']);
  });

  it('does not coerce a numeric systemId', async () => {
    expect((await check({ ...sample, systemId: 2378287 })).map((e) => e.property)).toEqual([
      'systemId',
    ]);
  });
});
