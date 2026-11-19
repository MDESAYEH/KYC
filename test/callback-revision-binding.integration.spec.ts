import { DataSource } from 'typeorm';
import { KycRequestStatus } from '../src/common/kyc-status';
import { CustomerType } from '../src/canonical';
import { IFlexcubeSqlExecutor, SqlBinds, SqlRow } from '../src/flexcube/staging/flexcube-staging';
import { assertValidBinds } from '../src/flexcube/staging/sql-binds';
import { StagingFlexcubeStatusUpdater } from '../src/flexcube/staging/staging-flexcube-status-updater';
import { SINGLE_KYC_TRIAL } from '../src/kyc/single-kyc-trial.scope';
import { TypeOrmKycCaseRepository } from '../src/persistence/typeorm-kyc-case.repository';
import { TypeOrmWebhookEventRepository } from '../src/persistence/typeorm-webhook-event.repository';
import { ReisOnboardingStatus } from '../src/reis/reis-status';
import { CustomerStatusService } from '../src/webhook/customer-status.service';
import { createTestDataSource } from './support/test-database';

/**
 * HOW A CALLBACK FINDS THE RIGHT REVISION (REIS sends no seqNo / revision token).
 *
 *   callback { systemId = CIF, status }  -> kyc_case WHERE reis_system_id = CIF   (UNIQUE: at most one)
 *                                        -> that case holds the submission's seqNo (MOD_NO)
 *                                        -> staging UPDATE ... SEQ_NO = <case.seqNo>   (never MAX(SEQ_NO))
 *
 * The seqNo therefore comes from OUR persisted case, written when we sent that exact revision. These
 * tests prove the chain end to end (real SQLite repositories + the real webhook service + the real
 * status updater against an in-memory Oracle double) and document the one residual ambiguity that only
 * REIS can remove (a second, late callback for an earlier revision of the SAME identity). That ambiguity is now
 * QUARANTINED, never applied: once more than one revision was ever sent under an identity (kyc_case.revision_count > 1),
 * a callback arriving while the current revision is pending is audited as RECONCILIATION_REQUIRED and changes nothing.
 * Synthetic identifiers only; no live system is touched.
 */
jest.setTimeout(30_000);

type StageRow = { KYC_REF_NO: string; SEQ_NO: number; REIS_FINAL_STATUS: string | null };

/** In-memory Oracle double for the final-status UPDATE (latest SEQ_NO or exact SEQ_NO, PENDING replaceable). */
class StagingOracle implements IFlexcubeSqlExecutor {
  rows: StageRow[] = [];
  writes: SqlBinds[] = [];
  async query(): Promise<SqlRow[]> {
    return [];
  }
  async execute(sql: string, b: SqlBinds) {
    assertValidBinds(sql, b);
    this.writes.push(b);
    const mine = this.rows.filter((r) => r.KYC_REF_NO === b.kycRefNo);
    const target = b.seqNo !== undefined ? b.seqNo : Math.max(...mine.map((r) => r.SEQ_NO));
    let rowsAffected = 0;
    for (const r of mine) {
      const replaceable = b.pendingStatus !== undefined && r.REIS_FINAL_STATUS === b.pendingStatus;
      if (
        r.SEQ_NO === target &&
        (r.REIS_FINAL_STATUS === null || r.REIS_FINAL_STATUS === b.finalStatus || replaceable)
      ) {
        r.REIS_FINAL_STATUS = String(b.finalStatus);
        rowsAffected++;
      }
    }
    return { rowsAffected };
  }
}

describe('callback -> revision binding (no seqNo in the REIS callback)', () => {
  let ds: DataSource;
  let cases: TypeOrmKycCaseRepository;
  let events: TypeOrmWebhookEventRepository;
  let oracle: StagingOracle;

  const SYN = { kycRefNo: 'KYC-SYN-0001', cif: '00001234' };
  const service = (vocabulary: 'approved-blocked' | 'clean-pending-blocked') =>
    new CustomerStatusService(
      { authorize: () => true },
      cases,
      events,
      new StagingFlexcubeStatusUpdater(oracle, 'STAGE', vocabulary),
    );
  const callback = (systemId: string, status: 'CUSTOMER' | 'BLOCKED', extra = {}) => ({
    headers: {},
    remoteAddress: '127.0.0.1',
    body: { status, systemId, systemName: 'Flexcube', ServiceType: 'CUSTOMER_STATUS', ...extra },
  });
  const row = (seq: number) => oracle.rows.find((r) => r.SEQ_NO === seq)!;

  /** What the single-record trial does for a PENDING answer: a case for the exact revision under the CIF. */
  async function pendingCase(kycRefNo: string, cif: string, seqNo: number) {
    const created = await cases.create({
      kycRefNo,
      seqNo,
      customerNo: cif,
      reisSystemId: cif,
      customerType: CustomerType.INDIVIDUAL,
    });
    await cases.updateInternalStatus(created.internalId, KycRequestStatus.SUBMITTED_TO_REIS);
    return cases.recordOnboardingResult(created.internalId, {
      reisOnboardingStatus: ReisOnboardingStatus.PENDING,
      reisId: 'R-1',
      riskCalculationId: 'RC-1',
    });
  }

  beforeEach(async () => {
    ds = await createTestDataSource();
    cases = new TypeOrmKycCaseRepository(ds);
    events = new TypeOrmWebhookEventRepository(ds);
    oracle = new StagingOracle();
    // staging: revision 1 closed as E by the ORA-01745 incident, revision 2 written PENDING by the trial
    oracle.rows = [
      { KYC_REF_NO: SYN.kycRefNo, SEQ_NO: 1, REIS_FINAL_STATUS: null },
      { KYC_REF_NO: SYN.kycRefNo, SEQ_NO: 2, REIS_FINAL_STATUS: 'PENDING' },
    ];
  });
  afterEach(() => ds.destroy());

  it('a callback without seqNo updates exactly the revision stored in the case (2), never revision 1', async () => {
    const c = await pendingCase(SYN.kycRefNo, SYN.cif, 2);
    expect(c.seqNo).toBe(2);
    const out = await service('clean-pending-blocked').handle(callback(SYN.cif, 'CUSTOMER'));
    expect(out.result).toBe('APPLIED');
    expect(row(2).REIS_FINAL_STATUS).toBe('CLEAN'); // PENDING replaced by the final decision
    expect(row(1).REIS_FINAL_STATUS).toBeNull(); // the old revision is untouched
    expect(oracle.writes).toEqual([
      { finalStatus: 'CLEAN', kycRefNo: SYN.kycRefNo, seqNo: 2, pendingStatus: 'PENDING' },
    ]);
  });

  it('BLOCKED replaces PENDING on revision 2 only', async () => {
    await pendingCase(SYN.kycRefNo, SYN.cif, 2);
    await service('clean-pending-blocked').handle(callback(SYN.cif, 'BLOCKED'));
    expect(row(2).REIS_FINAL_STATUS).toBe('BLOCKED');
    expect(row(1).REIS_FINAL_STATUS).toBeNull();
  });

  it('a repeated callback is a DUPLICATE (no second write); a contrary late one is a CONFLICT (status kept)', async () => {
    await pendingCase(SYN.kycRefNo, SYN.cif, 2);
    const svc = service('clean-pending-blocked');
    expect((await svc.handle(callback(SYN.cif, 'CUSTOMER'))).result).toBe('APPLIED');
    expect((await svc.handle(callback(SYN.cif, 'CUSTOMER'))).result).toBe('DUPLICATE');
    expect((await svc.handle(callback(SYN.cif, 'BLOCKED'))).result).toBe('CONFLICT');
    expect(row(2).REIS_FINAL_STATUS).toBe('CLEAN');
    expect(oracle.writes).toHaveLength(1);
  });

  it('a callback for an unknown identity changes nothing (also: the old KYC reference is NOT a key once the case is under the CIF)', async () => {
    await pendingCase(SYN.kycRefNo, SYN.cif, 2);
    const svc = service('clean-pending-blocked');
    expect((await svc.handle(callback('00009999', 'CUSTOMER'))).result).toBe('UNKNOWN_CASE');
    expect((await svc.handle(callback(SYN.kycRefNo, 'CUSTOMER'))).result).toBe('UNKNOWN_CASE');
    expect(oracle.writes).toEqual([]);
    expect(row(2).REIS_FINAL_STATUS).toBe('PENDING');
  });

  it('HAZARD: with the DEFAULT vocabulary the final status cannot replace the PENDING written by the trial', async () => {
    await pendingCase(SYN.kycRefNo, SYN.cif, 2);
    const out = await service('approved-blocked').handle(callback(SYN.cif, 'CUSTOMER'));
    // the REIS decision is stored, the FLEXCUBE write is refused and recorded as FAILED (operator recovery)
    expect(out.result).toBe('UPDATE_FAILED');
    expect(row(2).REIS_FINAL_STATUS).toBe('PENDING');
    expect((await cases.findByReisSystemId(SYN.cif))?.flexcubeUpdateStatus).toBe('FAILED');
    // => the trial may only be sent together with FLEXCUBE_FINAL_STATUS_VOCABULARY=clean-pending-blocked
  });

  /** Revision 2 answered and finalized, then revision 3 sent under the same CIF and left PENDING. */
  async function rev2FinalThenRev3(svc: CustomerStatusService, thirdPending: boolean) {
    await pendingCase(SYN.kycRefNo, SYN.cif, 2);
    expect((await svc.handle(callback(SYN.cif, 'CUSTOMER'))).result).toBe('APPLIED');
    const c = (await cases.findByReisSystemId(SYN.cif))!;
    expect(await cases.reopenForAmendment(c.internalId, 3, CustomerType.INDIVIDUAL)).not.toBeNull();
    if (thirdPending) {
      await cases.updateInternalStatus(c.internalId, KycRequestStatus.SUBMITTED_TO_REIS);
      await cases.recordOnboardingResult(c.internalId, {
        reisOnboardingStatus: ReisOnboardingStatus.PENDING,
      });
    }
    oracle.rows.push({
      KYC_REF_NO: SYN.kycRefNo,
      SEQ_NO: 3,
      REIS_FINAL_STATUS: thirdPending ? 'PENDING' : null,
    });
    return c.internalId;
  }

  it('B5: a late DUPLICATE callback of revision 2 is QUARANTINED while revision 3 is pending: nothing applied, nothing written', async () => {
    const svc = service('clean-pending-blocked');
    await rev2FinalThenRev3(svc, true);
    const writesBefore = oracle.writes.length;
    const late = await svc.handle(callback(SYN.cif, 'CUSTOMER'));
    expect(late.result).toBe('RECONCILIATION_REQUIRED');
    expect(row(3).REIS_FINAL_STATUS).toBe('PENDING'); // revision 3 is NOT decided by revision 2's duplicate
    expect(row(2).REIS_FINAL_STATUS).toBe('CLEAN');
    expect(oracle.writes).toHaveLength(writesBefore);
    const c = (await cases.findByReisSystemId(SYN.cif))!;
    expect(c).toMatchObject({
      seqNo: 3,
      revisionCount: 2,
      finalStatus: null,
      internalRequestStatus: KycRequestStatus.REIS_PENDING,
    });
    const audited = await events.listBySystemId(SYN.cif);
    expect(audited.map((e) => e.processingResult)).toContain('RECONCILIATION_REQUIRED');
  });

  it('B5: the genuine answer of revision 3 is quarantined too (ambiguous without a REIS revision token): safe, needs reconciliation', async () => {
    const svc = service('clean-pending-blocked');
    await rev2FinalThenRev3(svc, true);
    expect((await svc.handle(callback(SYN.cif, 'BLOCKED'))).result).toBe('RECONCILIATION_REQUIRED');
    expect(row(3).REIS_FINAL_STATUS).toBe('PENDING');
  });

  it('B5 delayed callback: revision 3 cannot be sent while revision 2 is still pending, so the delayed answer of 2 reaches 2 only', async () => {
    await pendingCase(SYN.kycRefNo, SYN.cif, 2);
    const c = (await cases.findByReisSystemId(SYN.cif))!;
    // FLEXCUBE advanced to revision 3 while REIS has not answered revision 2: refused, nothing changes
    expect(await cases.reopenForAmendment(c.internalId, 3, CustomerType.INDIVIDUAL)).toBeNull();
    expect(await cases.findByReisSystemId(SYN.cif)).toMatchObject({ seqNo: 2, revisionCount: 1 });
    // the delayed answer now arrives: unambiguous (one revision ever sent), applied to revision 2 only
    const out = await service('clean-pending-blocked').handle(callback(SYN.cif, 'CUSTOMER'));
    expect(out.result).toBe('APPLIED');
    expect(row(2).REIS_FINAL_STATUS).toBe('CLEAN');
    expect(oracle.rows.find((r) => r.SEQ_NO === 3)).toBeUndefined();
    expect(oracle.writes.map((w) => w.seqNo)).toEqual([2]);
  });

  it('B5 out-of-order: a late callback of revision 2 while revision 3 is only RECEIVED (not sent yet) is not applied', async () => {
    const svc = service('clean-pending-blocked');
    await rev2FinalThenRev3(svc, false);
    const writesBefore = oracle.writes.length;
    expect((await svc.handle(callback(SYN.cif, 'CUSTOMER'))).result).toBe('INCONSISTENT_STATE');
    expect(oracle.writes).toHaveLength(writesBefore);
    expect(row(3).REIS_FINAL_STATUS).toBeNull();
  });

  it('B5 out-of-order: after revision 3 was answered CLEAN, a late callback of revision 2 changes nothing', async () => {
    const svc = service('clean-pending-blocked');
    const id = await rev2FinalThenRev3(svc, false);
    await cases.updateInternalStatus(id, KycRequestStatus.SUBMITTED_TO_REIS);
    await cases.recordOnboardingResult(id, { reisOnboardingStatus: ReisOnboardingStatus.CLEAN });
    const writesBefore = oracle.writes.length;
    expect((await svc.handle(callback(SYN.cif, 'BLOCKED'))).result).toBe('INCONSISTENT_STATE');
    expect(oracle.writes).toHaveLength(writesBefore);
    expect(row(2).REIS_FINAL_STATUS).toBe('CLEAN');
  });

  it('the old, never-sent trial identity (KYC reference) is quarantined: audited, no status, no write', async () => {
    const svc = service('clean-pending-blocked');
    for (const id of [SINGLE_KYC_TRIAL.kycRefNo]) {
      const out = await svc.handle(callback(id, 'CUSTOMER'));
      expect(out.result).toBe('RECONCILIATION_REQUIRED');
      const [event] = await events.listBySystemId(id);
      expect(event).toMatchObject({
        processingResult: 'RECONCILIATION_REQUIRED',
        detailCode: 'SINGLE_TRIAL_CALLBACK_QUARANTINED',
      });
    }
    expect(oracle.writes).toEqual([]);
  });
});
