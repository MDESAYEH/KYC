import { DataSource } from 'typeorm';
import { createTestDataSource } from '../../test/support/test-database';
import { CustomerType } from '../canonical';
import { TypeOrmKycCaseRepository } from '../persistence/typeorm-kyc-case.repository';
import { TypeOrmWebhookEventRepository } from '../persistence/typeorm-webhook-event.repository';
import { SqliteLocalEvidence } from './sqlite-local-evidence';

jest.setTimeout(30_000); // creates a migrated database per test: slow under parallel load

describe('local evidence from the integration layer database (read-only SELECTs)', () => {
  let ds: DataSource;
  let evidence: SqliteLocalEvidence;

  beforeEach(async () => {
    ds = await createTestDataSource();
    evidence = new SqliteLocalEvidence(ds);
  });
  afterEach(() => ds.destroy());

  it('an empty database proves nothing and says so', async () => {
    expect(await evidence.summary()).toEqual({ caseCount: 0, oldestCaseAt: null });
    expect(await evidence.hasCase('K1')).toBe(false);
    expect(await evidence.hasWebhookEvent('K1')).toBe(false);
  });

  it('finds a case by KYC reference (a REIS submission was started) and counts the cases', async () => {
    const cases = new TypeOrmKycCaseRepository(ds);
    await cases.create({ kycRefNo: 'K1', customerType: CustomerType.INDIVIDUAL });
    const summary = await evidence.summary();
    expect(summary.caseCount).toBe(1);
    expect(summary.oldestCaseAt).not.toBeNull();
    expect(await evidence.hasCase('K1')).toBe(true);
    expect(await evidence.hasCase('K2')).toBe(false);
  });

  it('finds a REIS callback for the systemId (REIS knew the request)', async () => {
    const events = new TypeOrmWebhookEventRepository(ds);
    await events.start({ receivedAt: new Date(), systemId: 'K7' });
    expect(await evidence.hasWebhookEvent('K7')).toBe(true);
    expect(await evidence.hasWebhookEvent('K8')).toBe(false);
  });

  it('a missing table is an error, never "no evidence of sending"', async () => {
    await ds.query('DROP TABLE kyc_case');
    // The native SQLite addon can return an Error from a different Jest VM realm when the
    // full suite shares the addon. Assert the actual rejection, not instanceof Error.
    const missingTable = { message: expect.stringContaining('no such table: kyc_case') };
    await expect(evidence.hasCase('K1')).rejects.toMatchObject(missingTable);
    await expect(evidence.summary()).rejects.toMatchObject(missingTable);
  });
});
