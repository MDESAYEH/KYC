import { DataSource } from 'typeorm';
import { CustomerType } from '../src/canonical';
import { FlexcubeUpdateStatus, KycRequestStatus as S } from '../src/common/kyc-status';
import { FlexcubeStatusUpdate } from '../src/flexcube/dto/flexcube-status-update';
import { IFlexcubeStatusUpdater } from '../src/flexcube/flexcube.interfaces';
import { FlexcubeUpdateRecoveryService } from '../src/operations/flexcube-update-recovery.service';
import { OperationalQueryService } from '../src/operations/operational-query.service';
import { KycCase } from '../src/persistence/kyc-case';
import { TypeOrmKycCaseRepository } from '../src/persistence/typeorm-kyc-case.repository';
import { TypeOrmWebhookEventRepository } from '../src/persistence/typeorm-webhook-event.repository';
import { ReisFinalStatus, ReisOnboardingStatus } from '../src/reis/reis-status';
import { CustomerStatusService } from '../src/webhook/customer-status.service';
import { createTestDataSource } from './support/test-database';

// Synthetic data only.
class RecordingUpdater implements IFlexcubeStatusUpdater {
  calls: FlexcubeStatusUpdate[] = [];
  fail = false;
  async updateStatus(update: FlexcubeStatusUpdate): Promise<void> {
    this.calls.push(update);
    if (this.fail) throw new Error('FLEXCUBE down: secret-internal-detail');
  }
}

describe('operational recovery and queries (application services, no HTTP)', () => {
  let ds: DataSource;
  let cases: TypeOrmKycCaseRepository;
  let events: TypeOrmWebhookEventRepository;
  let updater: RecordingUpdater;
  let webhook: CustomerStatusService;
  let recovery: FlexcubeUpdateRecoveryService;
  let queries: OperationalQueryService;

  beforeEach(async () => {
    ds = await createTestDataSource();
    cases = new TypeOrmKycCaseRepository(ds);
    events = new TypeOrmWebhookEventRepository(ds);
    updater = new RecordingUpdater();
    webhook = new CustomerStatusService({ authorize: () => true }, cases, events, updater);
    recovery = new FlexcubeUpdateRecoveryService(cases, updater);
    queries = new OperationalQueryService(cases, events);
  });
  afterEach(async () => {
    await ds.destroy();
  });

  const pending = async (
    ref: string,
    over: { instruction?: string; errorMessage?: string; customerNo?: string } = {},
  ) => {
    const c = await cases.create({
      kycRefNo: ref,
      customerType: CustomerType.INDIVIDUAL,
      customerNo: over.customerNo,
    });
    return cases.recordOnboardingResult(c.internalId, {
      reisOnboardingStatus: ReisOnboardingStatus.PENDING,
      reisId: 'R-1',
      riskCalculationId: 'RC-1',
      instruction: over.instruction,
      errorMessage: over.errorMessage,
    });
  };
  const callback = (systemId: string, status: string, extra: Record<string, unknown> = {}) =>
    webhook.handle({ headers: {}, body: { status, systemId, ...extra } });
  /** A case whose REIS decision is stored but whose FLEXCUBE update FAILED. */
  const failedUpdate = async (ref: string, status = 'CUSTOMER', customerId?: number) => {
    const c = await pending(ref);
    updater.fail = true;
    const out = await callback(ref, status, customerId !== undefined ? { customerId } : {});
    expect(out.result).toBe('UPDATE_FAILED');
    updater.fail = false;
    return c.internalId;
  };
  const decision = (c: KycCase) => ({
    finalStatus: c.finalStatus,
    finalStatusAt: c.finalStatusAt,
    internalRequestStatus: c.internalRequestStatus,
    reisCustomerId: c.reisCustomerId,
    finalStatusReceivedCount: c.finalStatusReceivedCount,
    conflictingFinalStatus: c.conflictingFinalStatus,
    reisOnboardingStatus: c.reisOnboardingStatus,
  });

  describe('FLEXCUBE update recovery (operator-triggered)', () => {
    it('a FAILED update can be retried manually and becomes APPLIED', async () => {
      const id = await failedUpdate('R-1', 'CUSTOMER', 77);
      expect(updater.calls).toHaveLength(1);
      const before = (await cases.findByInternalId(id)) as KycCase;
      expect(before).toMatchObject({
        flexcubeUpdateStatus: 'FAILED',
        flexcubeUpdateAttemptCount: 1,
      });

      const res = await recovery.retryFailedUpdate(id);
      expect(res.outcome).toBe('RECOVERED');
      expect(updater.calls).toHaveLength(2);
      expect(updater.calls[1]).toEqual({
        kycRefNo: 'R-1',
        customerNo: null,
        finalStatus: 'CUSTOMER',
        seqNo: 1,
        reisCustomerId: 77,
        idempotencyKey: `${id}:CUSTOMER`, // same key as the first attempt
      });
      expect(res.kycCase).toMatchObject({
        flexcubeUpdateStatus: FlexcubeUpdateStatus.APPLIED,
        flexcubeUpdateErrorCode: null,
        flexcubeUpdateErrorMessage: null,
        flexcubeUpdateAttemptCount: 2,
      });
      expect(res.kycCase?.flexcubeUpdatedAt).toBeInstanceOf(Date);
      expect(res.kycCase?.flexcubeLastAttemptAt).toBeInstanceOf(Date);
    });

    it('passes the BLOCKED decision through unchanged', async () => {
      const id = await failedUpdate('R-2', 'BLOCKED');
      await recovery.retryFailedUpdate(id);
      expect(updater.calls[1]).toMatchObject({ finalStatus: 'BLOCKED' });
    });

    it('a failed manual recovery stays FAILED with refreshed safe metadata and can be retried again', async () => {
      const id = await failedUpdate('R-3');
      updater.fail = true;
      const again = await recovery.retryFailedUpdate(id);
      expect(again.outcome).toBe('STILL_FAILED');
      expect(again.kycCase).toMatchObject({
        flexcubeUpdateStatus: FlexcubeUpdateStatus.FAILED,
        flexcubeUpdateErrorCode: 'FLEXCUBE_UPDATE_FAILED',
        flexcubeUpdateAttemptCount: 2,
        flexcubeUpdatedAt: null,
      });
      expect(again.kycCase?.flexcubeUpdateErrorMessage).not.toContain('secret-internal-detail');
      expect(again.kycCase?.flexcubeLastAttemptAt).toBeInstanceOf(Date);
      updater.fail = false;
      const third = await recovery.retryFailedUpdate(id);
      expect(third.outcome).toBe('RECOVERED');
      expect(third.kycCase?.flexcubeUpdateAttemptCount).toBe(3);
    });

    it('an already APPLIED update is never executed again (idempotent)', async () => {
      await pending('R-4');
      await callback('R-4', 'CUSTOMER'); // updater succeeds first time
      const c = (await cases.findByKycRefNo('R-4')) as KycCase;
      expect(c.flexcubeUpdateStatus).toBe(FlexcubeUpdateStatus.APPLIED);
      for (let i = 0; i < 3; i++) {
        const res = await recovery.retryFailedUpdate(c.internalId);
        expect(res.outcome).toBe('ALREADY_APPLIED');
      }
      expect(updater.calls).toHaveLength(1);
      expect(await cases.findByKycRefNo('R-4')).toEqual(c);
    });

    it('a successfully recovered update is also not executed a second time', async () => {
      const id = await failedUpdate('R-5');
      expect((await recovery.retryFailedUpdate(id)).outcome).toBe('RECOVERED');
      expect((await recovery.retryFailedUpdate(id)).outcome).toBe('ALREADY_APPLIED');
      expect(updater.calls).toHaveLength(2); // original failure + one recovery
    });

    it('never modifies the REIS final decision, on success or failure', async () => {
      const id = await failedUpdate('R-6', 'BLOCKED', 5);
      const before = decision((await cases.findByInternalId(id)) as KycCase);
      updater.fail = true;
      await recovery.retryFailedUpdate(id);
      expect(decision((await cases.findByInternalId(id)) as KycCase)).toEqual(before);
      updater.fail = false;
      await recovery.retryFailedUpdate(id);
      expect(decision((await cases.findByInternalId(id)) as KycCase)).toEqual(before);
      expect(before).toMatchObject({
        finalStatus: ReisFinalStatus.BLOCKED,
        internalRequestStatus: S.FINALIZED,
      });
    });

    it('is not eligible without a final status, for a non-failed update, or for an unknown case', async () => {
      const c = await pending('R-7');
      await ds.query(
        "UPDATE kyc_case SET flexcube_update_status = 'FAILED' WHERE internal_id = ?",
        [c.internalId],
      );
      const noFinal = await recovery.retryFailedUpdate(c.internalId);
      expect(noFinal).toMatchObject({ outcome: 'NOT_ELIGIBLE', reason: 'NO_FINAL_STATUS' });

      const fresh = await pending('R-8');
      expect(await recovery.retryFailedUpdate(fresh.internalId)).toMatchObject({
        outcome: 'NOT_ELIGIBLE',
        reason: 'NO_FINAL_STATUS',
      });

      const interrupted = await pending('R-9');
      await cases.applyFinalStatus('R-9', ReisFinalStatus.CUSTOMER); // update left PENDING (interrupted)
      expect(await recovery.retryFailedUpdate(interrupted.internalId)).toMatchObject({
        outcome: 'NOT_ELIGIBLE',
        reason: 'UPDATE_NOT_FAILED',
      });
      expect(await recovery.retryFailedUpdate('does-not-exist')).toMatchObject({
        outcome: 'CASE_NOT_FOUND',
        kycCase: null,
      });
      expect(updater.calls).toHaveLength(0);
    });

    it('concurrent recovery requests run the updater exactly once', async () => {
      const id = await failedUpdate('R-10');
      const before = updater.calls.length;
      const results = await Promise.all([
        recovery.retryFailedUpdate(id),
        recovery.retryFailedUpdate(id),
        recovery.retryFailedUpdate(id),
      ]);
      expect(results.filter((r) => r.outcome === 'RECOVERED')).toHaveLength(1);
      expect(updater.calls.length - before).toBe(1);
    });

    it('there is no automatic retry: a failed update stays failed until an operator acts', async () => {
      const id = await failedUpdate('R-11');
      await callback('R-11', 'CUSTOMER'); // duplicate callback
      await new Promise((r) => setTimeout(r, 200));
      expect(updater.calls).toHaveLength(1);
      expect((await cases.findByInternalId(id))?.flexcubeUpdateStatus).toBe('FAILED');
    });

    it('stores only technical metadata (no payload, names, tokens)', async () => {
      const id = await failedUpdate('R-12', 'CUSTOMER', 9);
      updater.fail = true;
      await recovery.retryFailedUpdate(id);
      const row = JSON.stringify(
        await ds.query('SELECT * FROM kyc_case WHERE internal_id = ?', [id]),
      );
      expect(row).not.toContain('secret-internal-detail');
      expect(row).toContain('FLEXCUBE_UPDATE_FAILED');
    });
  });

  describe('operational queries return safe metadata only', () => {
    const SENSITIVE = ['SENSITIVE-INSTRUCTION', 'SENSITIVE-ERROR-TEXT', 'CUST-NO-123'];

    it('finds stuck PENDING cases older than a threshold', async () => {
      const old = await pending('Q-1', {
        instruction: SENSITIVE[0],
        errorMessage: SENSITIVE[1],
        customerNo: SENSITIVE[2],
      });
      await pending('Q-2');
      await ds.query(
        "UPDATE kyc_case SET updated_at = '2020-01-01 00:00:00' WHERE internal_id = ?",
        [old.internalId],
      );
      const found = await queries.findStuckPendingCases(new Date(Date.now() - 60 * 60 * 1000));
      expect(found.map((c) => c.kycRefNo)).toEqual(['Q-1']);
      expect(found[0]).toMatchObject({
        internalRequestStatus: S.REIS_PENDING,
        reisOnboardingStatus: 'PENDING',
        reisId: 'R-1',
        riskCalculationId: 'RC-1',
      });
      // Finalized cases are no longer "stuck".
      await callback('Q-1', 'CUSTOMER');
      await ds.query("UPDATE kyc_case SET updated_at = '2020-01-01 00:00:00'");
      expect((await queries.findStuckPendingCases(new Date())).map((c) => c.kycRefNo)).toEqual([
        'Q-2',
      ]);
    });

    it('summaries contain no customer data, CUSTOMER_NO, REIS free text or error messages', async () => {
      const c = await pending('Q-3', {
        instruction: SENSITIVE[0],
        errorMessage: SENSITIVE[1],
        customerNo: SENSITIVE[2],
      });
      await ds.query(
        "UPDATE kyc_case SET updated_at = '2020-01-01 00:00:00' WHERE internal_id = ?",
        [c.internalId],
      );
      const [summary] = await queries.findStuckPendingCases(new Date());
      expect(Object.keys(summary).sort()).toEqual(
        [
          'conflictingFinalStatus',
          'createdAt',
          'customerType',
          'finalStatus',
          'finalStatusAt',
          'flexcubeLastAttemptAt',
          'flexcubeUpdateAttemptCount',
          'flexcubeUpdateErrorCode',
          'flexcubeUpdateStatus',
          'flexcubeUpdatedAt',
          'internalId',
          'internalRequestStatus',
          'kycRefNo',
          'lastErrorCode',
          'reisId',
          'reisOnboardingStatus',
          'reisSystemId',
          'retryCount',
          'riskCalculationId',
          'updatedAt',
        ].sort(),
      );
      for (const forbidden of [
        'reisInstruction',
        'reisErrorMessage',
        'customerNo',
        'lastErrorMessage',
        'flexcubeUpdateErrorMessage',
      ]) {
        expect(summary).not.toHaveProperty(forbidden);
      }
      expect(JSON.stringify(summary)).not.toContain('SENSITIVE');
      expect(JSON.stringify(summary)).not.toContain('CUST-NO-123');
    });

    it('finds DELIVERY_UNCERTAIN cases together with audited reconciliation callbacks', async () => {
      const c = await cases.create({ kycRefNo: 'Q-4', customerType: CustomerType.CORPORATE });
      await cases.recordDeliveryUncertain(c.internalId, {
        code: 'REIS_ONBOARDING_TIMEOUT',
        message: 'secret message text',
      });
      await cases.create({ kycRefNo: 'Q-4B', customerType: CustomerType.INDIVIDUAL });
      expect((await callback('Q-4', 'CUSTOMER')).result).toBe('RECONCILIATION_REQUIRED');
      expect((await callback('Q-4', 'BLOCKED')).result).toBe('RECONCILIATION_REQUIRED');
      const found = await queries.findDeliveryUncertainCases();
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        kycRefNo: 'Q-4',
        internalRequestStatus: S.DELIVERY_UNCERTAIN,
        lastErrorCode: 'REIS_ONBOARDING_TIMEOUT',
        finalStatus: null,
        reconciliationCallbackCount: 2,
        lastReconciliationIncomingStatus: 'BLOCKED',
      });
      expect(found[0].lastReconciliationCallbackAt).toBeInstanceOf(Date);
      expect(JSON.stringify(found)).not.toContain('secret message text');
      expect(updater.calls).toHaveLength(0);
    });

    it('finds FAILED FLEXCUBE updates and drops them once recovered', async () => {
      const id = await failedUpdate('Q-5', 'BLOCKED');
      await pending('Q-6');
      await callback('Q-6', 'CUSTOMER'); // succeeds
      const failed = await queries.findFailedFlexcubeUpdates();
      expect(failed.map((c) => c.kycRefNo)).toEqual(['Q-5']);
      expect(failed[0]).toMatchObject({
        flexcubeUpdateStatus: 'FAILED',
        flexcubeUpdateErrorCode: 'FLEXCUBE_UPDATE_FAILED',
        flexcubeUpdateAttemptCount: 1,
        finalStatus: 'BLOCKED',
      });
      await recovery.retryFailedUpdate(id);
      expect(await queries.findFailedFlexcubeUpdates()).toEqual([]);
    });

    it('finds recent callback conflicts of every kind, and nothing routine', async () => {
      await pending('Q-7');
      await callback('Q-7', 'CUSTOMER'); // APPLIED
      await callback('Q-7', 'CUSTOMER'); // DUPLICATE
      await callback('Q-7', 'BLOCKED'); // CONFLICT
      await pending('Q-8');
      await cases.recordOnboardingResult((await cases.findByKycRefNo('Q-8'))!.internalId, {
        reisOnboardingStatus: ReisOnboardingStatus.PENDING,
        reisCustomerId: 1,
      });
      await callback('Q-8', 'CUSTOMER', { customerId: 2 }); // CUSTOMER_ID_MISMATCH
      const clean = await cases.create({ kycRefNo: 'Q-9', customerType: CustomerType.INDIVIDUAL });
      await cases.recordOnboardingResult(clean.internalId, {
        reisOnboardingStatus: ReisOnboardingStatus.CLEAN,
      });
      await callback('Q-9', 'CUSTOMER'); // INCONSISTENT_STATE
      const unc = await cases.create({ kycRefNo: 'Q-10', customerType: CustomerType.INDIVIDUAL });
      await cases.recordDeliveryUncertain(unc.internalId, { code: 'X', message: 'x' });
      await callback('Q-10', 'BLOCKED'); // RECONCILIATION_REQUIRED
      const found = await queries.findRecentCallbackConflicts(new Date(Date.now() - 60_000));
      expect(found.map((e) => e.processingResult).sort()).toEqual(
        [
          'CONFLICT',
          'CUSTOMER_ID_MISMATCH',
          'INCONSISTENT_STATE',
          'RECONCILIATION_REQUIRED',
        ].sort(),
      );
      expect(found.find((e) => e.processingResult === 'RECONCILIATION_REQUIRED')).toMatchObject({
        systemId: 'Q-10',
        incomingStatus: 'BLOCKED',
      });
    });

    it('respects the time window and the limit for events', async () => {
      await pending('Q-11');
      await callback('Q-11', 'CUSTOMER');
      await callback('Q-11', 'BLOCKED');
      await callback('Q-11', 'BLOCKED');
      expect(await queries.findRecentCallbackConflicts(new Date(Date.now() + 60_000))).toEqual([]);
      expect(
        await queries.findRecentCallbackConflicts(new Date(Date.now() - 60_000), { limit: 1 }),
      ).toHaveLength(1);
      expect(await queries.findRecentCallbackConflicts(new Date(Date.now() - 60_000))).toHaveLength(
        2,
      );
    });

    it('finds recent UNKNOWN_CASE callbacks without exposing payloads', async () => {
      await callback('NOPE-1', 'CUSTOMER', {
        customerId: 3,
        password: 'leaky-secret',
        firstName: 'Testfirst',
      });
      await callback('NOPE-2', 'BLOCKED');
      await pending('Q-12');
      await callback('Q-12', 'CUSTOMER');
      const found = await queries.findRecentUnknownCaseCallbacks(new Date(Date.now() - 60_000));
      expect(found.map((e) => e.systemId).sort()).toEqual(['NOPE-1', 'NOPE-2']);
      expect(
        found.every((e) => e.processingResult === 'UNKNOWN_CASE' && e.kycCaseInternalId === null),
      ).toBe(true);
      expect(JSON.stringify(found)).not.toContain('leaky-secret');
      expect(JSON.stringify(found)).not.toContain('Testfirst');
      expect(Object.keys(found[0]).sort()).toEqual(
        [
          'detailCode',
          'eventId',
          'incomingCustomerId',
          'incomingStatus',
          'kycCaseInternalId',
          'processedAt',
          'processingResult',
          'receivedAt',
          'serviceType',
          'systemId',
          'systemName',
        ].sort(),
      );
    });

    it('applies a default limit and caps oversized limits', async () => {
      for (let i = 0; i < 3; i++) await failedUpdate(`Q-L${i}`);
      expect(await queries.findFailedFlexcubeUpdates({ limit: 2 })).toHaveLength(2);
      expect(await queries.findFailedFlexcubeUpdates({ limit: 100000 })).toHaveLength(3);
    });
  });
});
