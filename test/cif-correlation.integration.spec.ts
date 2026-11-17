import { CustomerType } from '../src/canonical';
import { TypeOrmKycCaseRepository } from '../src/persistence/typeorm-kyc-case.repository';
import { TypeOrmWebhookEventRepository } from '../src/persistence/typeorm-webhook-event.repository';
import { DuplicateKycCaseError } from '../src/persistence/persistence.errors';
import { ReisFinalStatus, ReisOnboardingStatus } from '../src/reis/reis-status';
import { CustomerStatusService } from '../src/webhook/customer-status.service';
import { createTestDataSource } from './support/test-database';

/** Synthetic future-CIF cases, created explicitly in isolated SQLite, never migrated from real data. */
describe('CIF callback correlation boundaries', () => {
  let ds: Awaited<ReturnType<typeof createTestDataSource>>;
  let repo: TypeOrmKycCaseRepository;
  const updateStatus = jest.fn(async () => undefined);
  const pending = async (ref = 'KYC-INTERNAL', cif = '000045') => {
    const c = await repo.create({
      kycRefNo: ref,
      customerNo: cif,
      reisSystemId: cif,
      customerType: CustomerType.INDIVIDUAL,
    });
    return repo.recordOnboardingResult(c.internalId, {
      reisOnboardingStatus: ReisOnboardingStatus.PENDING,
    });
  };
  beforeEach(async () => {
    ds = await createTestDataSource();
    repo = new TypeOrmKycCaseRepository(ds);
    updateStatus.mockClear();
  });
  afterEach(async () => {
    await ds.destroy();
  });

  it('resolves CIF to the original KYC reference, keeping REIS customerId separate', async () => {
    await pending();
    const service = new CustomerStatusService(
      { authorize: async () => true },
      repo,
      new TypeOrmWebhookEventRepository(ds),
      { updateStatus },
    );
    // Security is a local test stub; this does not approve the real callback authentication contract.
    const result = await service.handle({
      body: { systemId: '000045', status: 'CUSTOMER', customerId: 99 },
      headers: {},
    });
    expect(result.result).toBe('APPLIED');
    expect(updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        kycRefNo: 'KYC-INTERNAL',
        customerNo: '000045',
        reisCustomerId: 99,
      }),
    );
    expect(await repo.findByReisSystemId('000045')).toMatchObject({
      kycRefNo: 'KYC-INTERNAL',
      customerNo: '000045',
      reisSystemId: '000045',
      reisCustomerId: 99,
    });
  });
  it('does not reinterpret an old KYC-reference callback as a CIF', async () => {
    await pending();
    expect((await repo.applyFinalStatus('KYC-INTERNAL', ReisFinalStatus.CUSTOMER)).outcome).toBe(
      'UNKNOWN_CASE',
    );
    expect((await repo.findByKycRefNo('KYC-INTERNAL'))?.finalStatus).toBeNull();
  });
  it('fails closed on two distinct KYC records with the same CIF; no schema relaxation', async () => {
    await pending();
    await expect(pending('KYC-SECOND')).rejects.toBeInstanceOf(DuplicateKycCaseError);
    expect(await repo.findByKycRefNo('KYC-SECOND')).toBeNull();
  });
  it('preserves old persisted identities instead of silently migrating or merging them', async () => {
    const old = await repo.create({
      kycRefNo: 'KYC-OLD',
      reisSystemId: 'KYC-OLD',
      customerNo: '000045',
      customerType: CustomerType.INDIVIDUAL,
    });
    expect(await repo.findByReisSystemId('000045')).toBeNull();
    expect((await repo.findByInternalId(old.internalId))?.reisSystemId).toBe('KYC-OLD');
    // A migration cannot be inferred from this state. The active submission hold prevents new sends.
  });
});
