import { DataSource } from 'typeorm';
import { createTestDataSource } from '../../test/support/test-database';
import { CustomerType } from '../canonical';
import { FlexcubeUpdateStatus, KycRequestStatus } from '../common/kyc-status';
import { ReisFinalStatus, ReisOnboardingStatus } from '../reis/reis-status';
import {
  CustomerNoConflictError,
  DuplicateKycCaseError,
  KycCaseNotFoundError,
} from './persistence.errors';
import { IKycCaseRepository } from './persistence.interfaces';
import { TypeOrmKycCaseRepository } from './typeorm-kyc-case.repository';

describe('TypeOrmKycCaseRepository (isolated SQLite)', () => {
  let ds: DataSource;
  let repo: IKycCaseRepository;

  beforeEach(async () => {
    ds = await createTestDataSource();
    repo = new TypeOrmKycCaseRepository(ds);
  });
  afterEach(async () => {
    await ds.destroy();
  });

  const newCase = (kycRefNo = 'KYC-1') =>
    repo.create({ kycRefNo, customerType: CustomerType.INDIVIDUAL });

  describe('create / retrieve', () => {
    it('creates a case with defaults and retrieves it by internal id', async () => {
      const created = await newCase();
      expect(created.internalId).toMatch(/^[0-9a-f-]{36}$/);
      expect(created).toMatchObject({
        kycRefNo: 'KYC-1',
        reisSystemId: 'KYC-1',
        customerType: CustomerType.INDIVIDUAL,
        internalRequestStatus: KycRequestStatus.RECEIVED,
        reisOnboardingStatus: null,
        finalStatus: null,
        retryCount: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
        reisCustomerId: null,
        riskCalculationId: null,
        reisId: null,
        finalStatusReceivedCount: 0,
        conflictingFinalStatus: null,
      });
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.updatedAt).toBeInstanceOf(Date);
      expect(await repo.findByInternalId(created.internalId)).toEqual(created);
    });

    it('returns null for unknown ids', async () => {
      expect(await repo.findByInternalId('nope')).toBeNull();
      expect(await repo.findByKycRefNo('nope')).toBeNull();
      expect(await repo.findByReisSystemId('nope')).toBeNull();
    });

    it('rejects a duplicate KYC_REF_NO and a duplicate systemId', async () => {
      await newCase('KYC-1');
      await expect(newCase('KYC-1')).rejects.toBeInstanceOf(DuplicateKycCaseError);
      await expect(
        repo.create({
          kycRefNo: 'KYC-2',
          reisSystemId: 'KYC-1',
          customerType: CustomerType.CORPORATE,
        }),
      ).rejects.toBeInstanceOf(DuplicateKycCaseError);
    });
  });

  describe('correlation lookups', () => {
    it('finds by KYC_REF_NO', async () => {
      const c = await newCase('KYC-7');
      expect((await repo.findByKycRefNo('KYC-7'))?.internalId).toBe(c.internalId);
    });

    it('finds by REIS systemId (defaults to KYC_REF_NO)', async () => {
      const c = await newCase('KYC-8');
      expect((await repo.findByReisSystemId('KYC-8'))?.internalId).toBe(c.internalId);
    });

    it('supports a systemId that differs from KYC_REF_NO', async () => {
      const c = await repo.create({
        kycRefNo: 'KYC-9',
        reisSystemId: 'SYS-9',
        customerType: CustomerType.CORPORATE,
      });
      expect((await repo.findByReisSystemId('SYS-9'))?.internalId).toBe(c.internalId);
      expect(await repo.findByReisSystemId('KYC-9')).toBeNull();
    });
  });

  describe('CUSTOMER_NO', () => {
    it('is nullable at creation and can be supplied at creation', async () => {
      expect((await newCase('A')).customerNo).toBeNull();
      const b = await repo.create({
        kycRefNo: 'B',
        customerNo: 'C-100',
        customerType: CustomerType.INDIVIDUAL,
      });
      expect(b.customerNo).toBe('C-100');
    });

    it('can be attached later; KYC_REF_NO and systemId stay intact', async () => {
      const c = await newCase('KYC-10');
      const updated = await repo.attachCustomerNo(c.internalId, 'CUST-55');
      expect(updated.customerNo).toBe('CUST-55');
      expect(updated.kycRefNo).toBe('KYC-10');
      expect(updated.reisSystemId).toBe('KYC-10');
      expect((await repo.findByKycRefNo('KYC-10'))?.customerNo).toBe('CUST-55');
    });

    it('is idempotent for the same value and rejects a different one', async () => {
      const c = await newCase();
      await repo.attachCustomerNo(c.internalId, 'CUST-1');
      expect((await repo.attachCustomerNo(c.internalId, 'CUST-1')).customerNo).toBe('CUST-1');
      await expect(repo.attachCustomerNo(c.internalId, 'CUST-2')).rejects.toBeInstanceOf(
        CustomerNoConflictError,
      );
      expect((await repo.findByInternalId(c.internalId))?.customerNo).toBe('CUST-1');
    });

    it('throws for an unknown case', async () => {
      await expect(repo.attachCustomerNo('missing', 'X')).rejects.toBeInstanceOf(
        KycCaseNotFoundError,
      );
    });
  });

  describe('onboarding result', () => {
    it.each([
      [ReisOnboardingStatus.CLEAN, KycRequestStatus.REIS_CLEAN],
      [ReisOnboardingStatus.PENDING, KycRequestStatus.REIS_PENDING],
      [ReisOnboardingStatus.REJECT, KycRequestStatus.REIS_REJECTED],
    ])('persists %s and moves internal status to %s', async (reis, internal) => {
      const c = await newCase();
      const u = await repo.recordOnboardingResult(c.internalId, {
        reisOnboardingStatus: reis,
        reisCustomerId: 217489,
        riskCalculationId: 'RC-1',
        reisId: 'R-1',
      });
      expect(u).toMatchObject({
        reisOnboardingStatus: reis,
        internalRequestStatus: internal,
        reisCustomerId: 217489,
        riskCalculationId: 'RC-1',
        reisId: 'R-1',
      });
      expect(await repo.findByInternalId(c.internalId)).toEqual(u);
    });

    it('keeps previously stored REIS ids when a result omits them and clears the last error', async () => {
      const c = await newCase();
      await repo.recordRetryableError(c.internalId, { code: 'TIMEOUT', message: 'timed out' });
      await repo.recordOnboardingResult(c.internalId, {
        reisOnboardingStatus: ReisOnboardingStatus.PENDING,
        reisCustomerId: 5,
      });
      const u = await repo.recordOnboardingResult(c.internalId, {
        reisOnboardingStatus: ReisOnboardingStatus.PENDING,
      });
      expect(u.reisCustomerId).toBe(5);
      expect(u.lastErrorCode).toBeNull();
      expect(u.lastErrorMessage).toBeNull();
    });
  });

  describe('final status and idempotency foundations', () => {
    /** A case that REIS answered PENDING: the only state a final status is expected in. */
    const pendingCase = async (kycRefNo: string, reisCustomerId?: number) => {
      const c = await newCase(kycRefNo);
      return repo.recordOnboardingResult(c.internalId, {
        reisOnboardingStatus: ReisOnboardingStatus.PENDING,
        ...(reisCustomerId !== undefined ? { reisCustomerId } : {}),
      });
    };

    it('applies the first final status, finalizes the case and marks the FLEXCUBE update PENDING', async () => {
      const c = await pendingCase('KYC-20');
      expect(c.flexcubeUpdateStatus).toBe(FlexcubeUpdateStatus.NOT_ATTEMPTED);
      const r = await repo.applyFinalStatus('KYC-20', ReisFinalStatus.CUSTOMER, 999);
      expect(r.outcome).toBe('APPLIED');
      expect(r.kycCase).toMatchObject({
        internalId: c.internalId,
        finalStatus: ReisFinalStatus.CUSTOMER,
        internalRequestStatus: KycRequestStatus.FINALIZED,
        finalStatusReceivedCount: 1,
        reisCustomerId: 999,
        conflictingFinalStatus: null,
        flexcubeUpdateStatus: FlexcubeUpdateStatus.PENDING,
        customerNo: null, // REIS customerId is never confused with FLEXCUBE CUSTOMER_NO
      });
      expect(r.kycCase?.finalStatusAt).toBeInstanceOf(Date);
      expect((await repo.findByReisSystemId('KYC-20'))?.finalStatus).toBe('CUSTOMER');
    });

    it('applies BLOCKED the same way', async () => {
      await pendingCase('KYC-20B');
      const r = await repo.applyFinalStatus('KYC-20B', ReisFinalStatus.BLOCKED);
      expect(r.outcome).toBe('APPLIED');
      expect(r.kycCase).toMatchObject({
        finalStatus: 'BLOCKED',
        internalRequestStatus: KycRequestStatus.FINALIZED,
      });
    });

    it('accepts a callback without customerId (optional)', async () => {
      await pendingCase('KYC-20C');
      expect((await repo.applyFinalStatus('KYC-20C', ReisFinalStatus.CUSTOMER)).outcome).toBe(
        'APPLIED',
      );
      await pendingCase('KYC-20D');
      expect((await repo.applyFinalStatus('KYC-20D', ReisFinalStatus.CUSTOMER, null)).outcome).toBe(
        'APPLIED',
      );
    });

    it('treats an identical repeated callback as a DUPLICATE without changing state', async () => {
      await pendingCase('KYC-21');
      const first = await repo.applyFinalStatus('KYC-21', ReisFinalStatus.BLOCKED);
      const dup1 = await repo.applyFinalStatus('KYC-21', ReisFinalStatus.BLOCKED);
      const dup2 = await repo.applyFinalStatus('KYC-21', ReisFinalStatus.BLOCKED);
      expect(dup1.outcome).toBe('DUPLICATE');
      expect(dup2.outcome).toBe('DUPLICATE');
      expect(dup2.kycCase).toMatchObject({
        finalStatus: ReisFinalStatus.BLOCKED,
        finalStatusReceivedCount: 3,
        conflictingFinalStatus: null,
        internalRequestStatus: KycRequestStatus.FINALIZED,
        flexcubeUpdateStatus: FlexcubeUpdateStatus.PENDING, // not re-armed by duplicates
      });
      expect(dup2.kycCase?.finalStatusAt).toEqual(first.kycCase?.finalStatusAt);
    });

    it.each([
      [ReisFinalStatus.CUSTOMER, ReisFinalStatus.BLOCKED],
      [ReisFinalStatus.BLOCKED, ReisFinalStatus.CUSTOMER],
    ])(
      '%s followed by %s is a CONFLICT that keeps the original and flags the attempt',
      async (first, second) => {
        await pendingCase('KYC-22');
        await repo.applyFinalStatus('KYC-22', first);
        const r = await repo.applyFinalStatus('KYC-22', second);
        expect(r.outcome).toBe('CONFLICT');
        expect(r.kycCase).toMatchObject({
          finalStatus: first,
          conflictingFinalStatus: second,
          finalStatusReceivedCount: 1,
          internalRequestStatus: KycRequestStatus.FINALIZED,
        });
      },
    );

    it('reports an unknown systemId without creating or touching anything', async () => {
      const other = await pendingCase('KYC-OTHER');
      const r = await repo.applyFinalStatus('UNKNOWN', ReisFinalStatus.CUSTOMER);
      expect(r).toEqual({ outcome: 'UNKNOWN_CASE', kycCase: null });
      expect(await repo.findByReisSystemId('UNKNOWN')).toBeNull();
      expect(await repo.findByInternalId(other.internalId)).toEqual(other);
    });

    it('stores the REIS customerId when the case has none', async () => {
      await pendingCase('KYC-23A');
      const r = await repo.applyFinalStatus('KYC-23A', ReisFinalStatus.CUSTOMER, 2);
      expect(r.kycCase?.reisCustomerId).toBe(2);
    });

    it('rejects a different REIS customerId safely (CUSTOMER_ID_MISMATCH): nothing changes', async () => {
      const before = await pendingCase('KYC-23', 1);
      const r = await repo.applyFinalStatus('KYC-23', ReisFinalStatus.CUSTOMER, 2);
      expect(r.outcome).toBe('CUSTOMER_ID_MISMATCH');
      expect(await repo.findByKycRefNo('KYC-23')).toEqual(before);
      expect(before.finalStatus).toBeNull();
      // The same id is fine.
      expect((await repo.applyFinalStatus('KYC-23', ReisFinalStatus.CUSTOMER, 1)).outcome).toBe(
        'APPLIED',
      );
    });

    it('also checks the customerId on a repeated callback', async () => {
      await pendingCase('KYC-23B', 7);
      await repo.applyFinalStatus('KYC-23B', ReisFinalStatus.CUSTOMER, 7);
      const r = await repo.applyFinalStatus('KYC-23B', ReisFinalStatus.CUSTOMER, 8);
      expect(r.outcome).toBe('CUSTOMER_ID_MISMATCH');
      expect(r.kycCase).toMatchObject({ finalStatusReceivedCount: 1, reisCustomerId: 7 });
    });

    it.each([
      ['RECEIVED', async (id: string) => repo.updateInternalStatus(id, KycRequestStatus.RECEIVED)],
      [
        'CLEAN',
        async (id: string) =>
          repo.recordOnboardingResult(id, { reisOnboardingStatus: ReisOnboardingStatus.CLEAN }),
      ],
      [
        'REJECT',
        async (id: string) =>
          repo.recordOnboardingResult(id, { reisOnboardingStatus: ReisOnboardingStatus.REJECT }),
      ],
      [
        'FAILED_PERMANENT',
        async (id: string) => repo.recordPermanentError(id, { code: 'X', message: 'x' }),
      ],
      [
        'VALIDATION_FAILED',
        async (id: string) => repo.recordValidationFailure(id, { code: 'X', message: 'x' }),
      ],
    ])(
      'a %s case is INCONSISTENT_STATE for a callback and is not silently changed',
      async (_name, prepare) => {
        const c = await newCase('KYC-24I');
        const prepared = await prepare(c.internalId);
        for (const status of [ReisFinalStatus.CUSTOMER, ReisFinalStatus.BLOCKED]) {
          const r = await repo.applyFinalStatus('KYC-24I', status, 5);
          expect(r.outcome).toBe('INCONSISTENT_STATE');
        }
        const after = await repo.findByKycRefNo('KYC-24I');
        expect(after).toEqual(prepared);
        // CLEAN / REJECT already hold their immediate final status; nothing else changed it.
        expect(after).toMatchObject({
          finalStatus: prepared.finalStatus,
          reisCustomerId: null,
          finalStatusReceivedCount: 0,
        });
      },
    );

    it('a DELIVERY_UNCERTAIN case is RECONCILIATION_REQUIRED (not a normal lifecycle conflict) and is not changed', async () => {
      const c = await newCase('KYC-24R');
      const prepared = await repo.recordDeliveryUncertain(c.internalId, {
        code: 'T',
        message: 't',
      });
      for (const status of [ReisFinalStatus.CUSTOMER, ReisFinalStatus.BLOCKED]) {
        const r = await repo.applyFinalStatus('KYC-24R', status, 5);
        expect(r.outcome).toBe('RECONCILIATION_REQUIRED');
        expect(r.kycCase).toEqual(prepared);
      }
      expect(await repo.findByKycRefNo('KYC-24R')).toMatchObject({
        internalRequestStatus: KycRequestStatus.DELIVERY_UNCERTAIN,
        finalStatus: null,
        reisCustomerId: null,
        finalStatusReceivedCount: 0,
        flexcubeUpdateStatus: FlexcubeUpdateStatus.NOT_ATTEMPTED,
      });
    });

    it('lets only one of several concurrent identical callbacks win', async () => {
      await pendingCase('KYC-24');
      const results = await Promise.all([
        repo.applyFinalStatus('KYC-24', ReisFinalStatus.CUSTOMER),
        repo.applyFinalStatus('KYC-24', ReisFinalStatus.CUSTOMER),
        repo.applyFinalStatus('KYC-24', ReisFinalStatus.CUSTOMER),
      ]);
      expect(results.filter((r) => r.outcome === 'APPLIED')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'DUPLICATE')).toHaveLength(2);
      expect((await repo.findByReisSystemId('KYC-24'))?.finalStatusReceivedCount).toBe(3);
    });

    it('records the FLEXCUBE update result separately from the REIS final status', async () => {
      const c = await pendingCase('KYC-25');
      await repo.applyFinalStatus('KYC-25', ReisFinalStatus.CUSTOMER);
      const failed = await repo.recordFlexcubeUpdateResult(c.internalId, {
        status: FlexcubeUpdateStatus.FAILED,
        errorCode: 'FLEXCUBE_UPDATE_FAILED',
        errorMessage: 'update failed',
      });
      expect(failed).toMatchObject({
        flexcubeUpdateStatus: FlexcubeUpdateStatus.FAILED,
        flexcubeUpdateErrorCode: 'FLEXCUBE_UPDATE_FAILED',
        finalStatus: ReisFinalStatus.CUSTOMER, // the REIS decision is untouched
        internalRequestStatus: KycRequestStatus.FINALIZED,
        flexcubeUpdatedAt: null,
      });
      const applied = await repo.recordFlexcubeUpdateResult(c.internalId, {
        status: FlexcubeUpdateStatus.APPLIED,
      });
      expect(applied).toMatchObject({
        flexcubeUpdateStatus: FlexcubeUpdateStatus.APPLIED,
        flexcubeUpdateErrorCode: null,
        flexcubeUpdateErrorMessage: null,
        finalStatus: ReisFinalStatus.CUSTOMER,
      });
      expect(applied.flexcubeUpdatedAt).toBeInstanceOf(Date);
    });
  });

  describe('FLEXCUBE update attempts and operator recovery claim', () => {
    const finalized = async (ref: string) => {
      const c = await newCase(ref);
      await repo.recordOnboardingResult(c.internalId, {
        reisOnboardingStatus: ReisOnboardingStatus.PENDING,
      });
      await repo.applyFinalStatus(ref, ReisFinalStatus.CUSTOMER);
      return c.internalId;
    };

    it('counts every recorded updater result and stamps the attempt', async () => {
      const id = await finalized('KYC-30');
      const before = await repo.findByInternalId(id);
      expect(before).toMatchObject({ flexcubeUpdateAttemptCount: 0, flexcubeLastAttemptAt: null });
      const failed = await repo.recordFlexcubeUpdateResult(id, {
        status: FlexcubeUpdateStatus.FAILED,
        errorCode: 'E1',
        errorMessage: 'm1',
      });
      expect(failed).toMatchObject({
        flexcubeUpdateAttemptCount: 1,
        flexcubeUpdateErrorCode: 'E1',
      });
      expect(failed.flexcubeLastAttemptAt).toBeInstanceOf(Date);
      const applied = await repo.recordFlexcubeUpdateResult(id, {
        status: FlexcubeUpdateStatus.APPLIED,
      });
      expect(applied).toMatchObject({
        flexcubeUpdateAttemptCount: 2,
        flexcubeUpdateStatus: FlexcubeUpdateStatus.APPLIED,
        flexcubeUpdateErrorCode: null,
        finalStatus: ReisFinalStatus.CUSTOMER,
      });
      expect(applied.flexcubeUpdatedAt).toBeInstanceOf(Date);
    });

    it('claims a FAILED update once (FAILED -> PENDING) and refuses every other state', async () => {
      const id = await finalized('KYC-31');
      expect(await repo.claimFlexcubeRecovery(id)).toBeNull(); // PENDING, not FAILED
      await repo.recordFlexcubeUpdateResult(id, { status: FlexcubeUpdateStatus.FAILED });
      const claims = await Promise.all([
        repo.claimFlexcubeRecovery(id),
        repo.claimFlexcubeRecovery(id),
        repo.claimFlexcubeRecovery(id),
      ]);
      expect(claims.filter((c) => c !== null)).toHaveLength(1);
      expect((await repo.findByInternalId(id))?.flexcubeUpdateStatus).toBe(
        FlexcubeUpdateStatus.PENDING,
      );
      await repo.recordFlexcubeUpdateResult(id, { status: FlexcubeUpdateStatus.APPLIED });
      expect(await repo.claimFlexcubeRecovery(id)).toBeNull(); // APPLIED
      expect(await repo.claimFlexcubeRecovery('missing')).toBeNull();
    });

    it('never claims a case without a final status', async () => {
      const c = await newCase('KYC-32');
      await ds.query(
        "UPDATE kyc_case SET flexcube_update_status = 'FAILED' WHERE internal_id = ?",
        [c.internalId],
      );
      expect(await repo.claimFlexcubeRecovery(c.internalId)).toBeNull();
    });

    it('findCases filters by status / update status / age and caps the limit', async () => {
      const a = await finalized('KYC-33');
      await repo.recordFlexcubeUpdateResult(a, { status: FlexcubeUpdateStatus.FAILED });
      await newCase('KYC-34');
      const pend = await newCase('KYC-35');
      await repo.recordOnboardingResult(pend.internalId, {
        reisOnboardingStatus: ReisOnboardingStatus.PENDING,
      });
      await ds.query(
        "UPDATE kyc_case SET updated_at = '2020-01-01 00:00:00' WHERE internal_id = ?",
        [pend.internalId],
      );

      expect(
        (
          await repo.findCases({ flexcubeUpdateStatus: FlexcubeUpdateStatus.FAILED, limit: 10 })
        ).map((c) => c.kycRefNo),
      ).toEqual(['KYC-33']);
      expect(
        (
          await repo.findCases({
            internalRequestStatus: KycRequestStatus.REIS_PENDING,
            updatedBefore: new Date('2021-01-01T00:00:00Z'),
            limit: 10,
          })
        ).map((c) => c.kycRefNo),
      ).toEqual(['KYC-35']);
      expect(
        await repo.findCases({
          internalRequestStatus: KycRequestStatus.REIS_PENDING,
          updatedBefore: new Date('2019-01-01T00:00:00Z'),
          limit: 10,
        }),
      ).toEqual([]);
      expect(await repo.findCases({ limit: 2 })).toHaveLength(2);
      expect(await repo.findCases({ limit: 0 })).toHaveLength(1); // floor of 1
    });
  });

  describe('REIS response text (instruction / errorMessage)', () => {
    it('persists instruction and errorMessage with the onboarding result', async () => {
      const c = await newCase();
      const u = await repo.recordOnboardingResult(c.internalId, {
        reisOnboardingStatus: ReisOnboardingStatus.REJECT,
        reisId: 'R-1',
        riskCalculationId: 'RC-1',
        instruction: 'call the branch',
        errorMessage: 'rejected: rule X',
      });
      expect(u).toMatchObject({
        reisInstruction: 'call the branch',
        reisErrorMessage: 'rejected: rule X',
        reisOnboardingStatus: 'REJECT',
        reisId: 'R-1',
        riskCalculationId: 'RC-1',
      });
      expect(await repo.findByInternalId(c.internalId)).toEqual(u);
    });

    it('stores null when REIS sends null, and keeps values when a later result omits them', async () => {
      const c = await newCase();
      expect(c).toMatchObject({ reisInstruction: null, reisErrorMessage: null });
      await repo.recordOnboardingResult(c.internalId, {
        reisOnboardingStatus: ReisOnboardingStatus.PENDING,
        instruction: 'keep me',
        errorMessage: null,
      });
      const u = await repo.recordOnboardingResult(c.internalId, {
        reisOnboardingStatus: ReisOnboardingStatus.PENDING,
      });
      expect(u).toMatchObject({ reisInstruction: 'keep me', reisErrorMessage: null });
    });

    it('truncates oversized text to the 4000 character column size', async () => {
      const c = await newCase();
      const u = await repo.recordOnboardingResult(c.internalId, {
        reisOnboardingStatus: ReisOnboardingStatus.PENDING,
        instruction: 'i'.repeat(9000),
        errorMessage: 'e'.repeat(9000),
      });
      expect(u.reisInstruction).toHaveLength(4000);
      expect(u.reisErrorMessage).toHaveLength(4000);
    });
  });

  describe('retry / error state', () => {
    it('increments retryCount and records the error for retryable failures', async () => {
      const c = await newCase();
      await repo.recordRetryableError(c.internalId, { code: 'REIS_TIMEOUT', message: 'timeout 1' });
      const u = await repo.recordRetryableError(c.internalId, {
        code: 'REIS_5XX',
        message: 'server error',
      });
      expect(u).toMatchObject({
        retryCount: 2,
        internalRequestStatus: KycRequestStatus.FAILED_RETRYABLE,
        lastErrorCode: 'REIS_5XX',
        lastErrorMessage: 'server error',
      });
    });

    it('records permanent failures without incrementing retryCount', async () => {
      const c = await newCase();
      await repo.recordRetryableError(c.internalId, { code: 'X', message: 'x' });
      const u = await repo.recordPermanentError(c.internalId, {
        code: 'UNMAPPED_REFERENCE',
        message: 'no mapping',
      });
      expect(u).toMatchObject({
        retryCount: 1,
        internalRequestStatus: KycRequestStatus.FAILED_PERMANENT,
        lastErrorCode: 'UNMAPPED_REFERENCE',
      });
    });

    it('truncates oversized error text', async () => {
      const c = await newCase();
      const u = await repo.recordPermanentError(c.internalId, {
        code: 'C'.repeat(500),
        message: 'M'.repeat(5000),
      });
      expect(u.lastErrorCode).toHaveLength(100);
      expect(u.lastErrorMessage).toHaveLength(1000);
    });

    it('updates internal status', async () => {
      const c = await newCase();
      const u = await repo.updateInternalStatus(c.internalId, KycRequestStatus.SUBMITTED_TO_REIS);
      expect(u.internalRequestStatus).toBe(KycRequestStatus.SUBMITTED_TO_REIS);
    });

    it('throws for unknown cases on every update', async () => {
      const err = { code: 'x', message: 'y' };
      await expect(repo.recordRetryableError('m', err)).rejects.toBeInstanceOf(
        KycCaseNotFoundError,
      );
      await expect(repo.recordPermanentError('m', err)).rejects.toBeInstanceOf(
        KycCaseNotFoundError,
      );
      await expect(
        repo.recordOnboardingResult('m', { reisOnboardingStatus: ReisOnboardingStatus.CLEAN }),
      ).rejects.toBeInstanceOf(KycCaseNotFoundError);
      await expect(
        repo.updateInternalStatus('m', KycRequestStatus.RECEIVED),
      ).rejects.toBeInstanceOf(KycCaseNotFoundError);
    });
  });

  describe('validation failure, reopen and delivery-uncertain states', () => {
    it('records a validation failure without touching retryCount', async () => {
      const c = await newCase();
      const u = await repo.recordValidationFailure(c.internalId, {
        code: 'UNMAPPED_REFERENCE',
        message: 'm',
      });
      expect(u).toMatchObject({
        internalRequestStatus: KycRequestStatus.VALIDATION_FAILED,
        lastErrorCode: 'UNMAPPED_REFERENCE',
        retryCount: 0,
        reisOnboardingStatus: null,
      });
    });

    it('reopens only a VALIDATION_FAILED case, clearing the error', async () => {
      const c = await newCase();
      expect(
        await repo.reopenAfterValidationFailure(c.internalId, CustomerType.CORPORATE),
      ).toBeNull();
      await repo.recordValidationFailure(c.internalId, { code: 'X', message: 'y' });
      const reopened = await repo.reopenAfterValidationFailure(
        c.internalId,
        CustomerType.CORPORATE,
      );
      expect(reopened).toMatchObject({
        internalId: c.internalId,
        internalRequestStatus: KycRequestStatus.RECEIVED,
        customerType: CustomerType.CORPORATE,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      // Not reopenable again, and never reopens other failure kinds.
      expect(
        await repo.reopenAfterValidationFailure(c.internalId, CustomerType.CORPORATE),
      ).toBeNull();
      await repo.recordPermanentError(c.internalId, { code: 'P', message: 'p' });
      expect(
        await repo.reopenAfterValidationFailure(c.internalId, CustomerType.CORPORATE),
      ).toBeNull();
    });

    it('records DELIVERY_UNCERTAIN without incrementing retryCount and cannot be reopened', async () => {
      const c = await newCase();
      const u = await repo.recordDeliveryUncertain(c.internalId, {
        code: 'REIS_TIMEOUT',
        message: 't',
      });
      expect(u).toMatchObject({
        internalRequestStatus: KycRequestStatus.DELIVERY_UNCERTAIN,
        lastErrorCode: 'REIS_TIMEOUT',
        retryCount: 0,
      });
      expect(
        await repo.reopenAfterValidationFailure(c.internalId, CustomerType.INDIVIDUAL),
      ).toBeNull();
    });
  });

  it('isolates databases between tests', async () => {
    expect(await repo.findByKycRefNo('KYC-1')).toBeNull();
  });
});
