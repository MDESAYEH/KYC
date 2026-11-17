import { DataSource } from 'typeorm';
import { CustomerType } from '../src/canonical';
import { KycRequestStatus } from '../src/common/kyc-status';
import { TypeOrmKycCaseRepository } from '../src/persistence/typeorm-kyc-case.repository';
import { ReisFinalStatus, ReisOnboardingStatus } from '../src/reis/reis-status';
import { createTestDataSource } from './support/test-database';

/**
 * LATE / REPEATED CALLBACKS, what can be done locally: REIS retries a callback until it receives a 200 and
 * the callback carries no revision. A repeat of revision 2's decision that arrives after revision 3 was
 * sent for the same identity would be applied to revision 3. The opt-in quiet period holds revision N+1
 * for a while after revision N's FINAL decision, so such repeats drain first. Default: no hold.
 */
jest.setTimeout(30_000);

describe('amendment quiet period after a final decision', () => {
  let ds: DataSource;
  let cases: TypeOrmKycCaseRepository;
  const HOUR = 3_600_000;

  /** A case whose revision 2 is FINAL (CUSTOMER) right now. */
  async function finalizedCase() {
    const c = await cases.create({
      kycRefNo: 'KYC-SYN-9',
      seqNo: 2,
      customerNo: '00001234',
      reisSystemId: '00001234',
      customerType: CustomerType.INDIVIDUAL,
    });
    await cases.updateInternalStatus(c.internalId, KycRequestStatus.SUBMITTED_TO_REIS);
    await cases.recordOnboardingResult(c.internalId, {
      reisOnboardingStatus: ReisOnboardingStatus.PENDING,
    });
    await cases.applyFinalStatus('00001234', ReisFinalStatus.CUSTOMER);
    return (await cases.findByInternalId(c.internalId))!;
  }

  beforeEach(async () => {
    ds = await createTestDataSource();
    cases = new TypeOrmKycCaseRepository(ds);
  });
  afterEach(() => ds.destroy());

  it('default (no quiet period): the next revision may follow at once, as before', async () => {
    const c = await finalizedCase();
    const reopened = await cases.reopenForAmendment(c.internalId, 3, CustomerType.INDIVIDUAL);
    expect(reopened).toMatchObject({ seqNo: 3, finalStatus: null });
  });

  it('with a quiet period the next revision is HELD: nothing changes, the decision of revision 2 stays', async () => {
    const c = await finalizedCase();
    const now = new Date(c.finalStatusAt!.getTime() + 10 * 60_000);
    const held = await cases.reopenForAmendment(c.internalId, 3, CustomerType.INDIVIDUAL, {
      quietPeriodMs: HOUR,
      now,
    });
    expect(held).toBeNull();
    const after = (await cases.findByInternalId(c.internalId))!;
    expect(after).toMatchObject({ seqNo: 2, finalStatus: ReisFinalStatus.CUSTOMER });
    // a late repeat of revision 2's decision in the meantime stays a harmless DUPLICATE for revision 2
    expect((await cases.applyFinalStatus('00001234', ReisFinalStatus.CUSTOMER)).outcome).toBe(
      'DUPLICATE',
    );
  });

  it('after the quiet period the next revision is accepted', async () => {
    const c = await finalizedCase();
    const now = new Date(c.finalStatusAt!.getTime() + HOUR + 1000);
    const reopened = await cases.reopenForAmendment(c.internalId, 3, CustomerType.INDIVIDUAL, {
      quietPeriodMs: HOUR,
      now,
    });
    expect(reopened).toMatchObject({ seqNo: 3, finalStatus: null });
  });

  it('the quiet period does not delay the restart after a validation failure (no decision was ever sent)', async () => {
    const c = await cases.create({
      kycRefNo: 'KYC-SYN-8',
      seqNo: 1,
      customerType: CustomerType.INDIVIDUAL,
    });
    await cases.recordValidationFailure(c.internalId, { code: 'X', message: 'x' });
    const reopened = await cases.reopenForAmendment(c.internalId, 2, CustomerType.INDIVIDUAL, {
      quietPeriodMs: HOUR,
    });
    expect(reopened).toMatchObject({ seqNo: 2 });
  });

  it('a lower or equal revision is still refused, quiet period or not', async () => {
    const c = await finalizedCase();
    const later = new Date(c.finalStatusAt!.getTime() + 2 * HOUR);
    expect(
      await cases.reopenForAmendment(c.internalId, 2, CustomerType.INDIVIDUAL, {
        quietPeriodMs: HOUR,
        now: later,
      }),
    ).toBeNull();
    expect(await cases.reopenForAmendment(c.internalId, 1, CustomerType.INDIVIDUAL)).toBeNull();
  });
});
