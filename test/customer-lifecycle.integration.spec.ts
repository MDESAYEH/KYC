import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { FlexcubeCustomerRequest } from '../src/flexcube/dto/flexcube-customer.request';
import { FLEXCUBE_STATUS_UPDATER } from '../src/flexcube/flexcube.interfaces';
import { StagingFlexcubeStatusUpdater } from '../src/flexcube/staging/staging-flexcube-status-updater';
import { IKycWorkflow, KYC_WORKFLOW } from '../src/kyc/kyc.interfaces';
import {
  IReferenceMappingRepository,
  REFERENCE_MAPPING_REPOSITORY,
} from '../src/mapping/mapping.interfaces';
import { seedReferenceMappings } from '../src/mapping/seed/agreed-reference-mappings';
import {
  FLEXCUBE_UPDATE_RECOVERY_SERVICE,
  IFlexcubeUpdateRecoveryService,
} from '../src/operations/flexcube-update-recovery.service';
import { IKycCaseRepository, KYC_CASE_REPOSITORY } from '../src/persistence/persistence.interfaces';
import { FakeReisServer } from './support/fake-reis-server';
import { FakeStagingDb } from './support/fake-staging-db';

/**
 * Task 5 - customer lifecycle after the REIS answer, on the real AppModule over real HTTP:
 * file-based SQLite (survives restarts), agreed reference lists, Bearer-protected webhook,
 * real StagingFlexcubeStatusUpdater writing an in-memory FLEXCUBE staging table.
 * The systemId used is the current rule (KYC_REF_NO): this proves consistency of the
 * implementation, not the still-open business decision (customer number vs KYC reference).
 */
const TOKEN = 'synthetic-bearer-token-0123456789-abcdefXYZ'; // test only
const ONBOARDING = '/onboarding/v2/searchOnboardCustomer';

const individual = (kyc: string): FlexcubeCustomerRequest => ({
  KYC_REF_NO: kyc,
  CUSTOMER_TYPE: 'INDIVIDUAL',
  ACCOUNT_MANAGER_LOGIN: 'account_manager',
  ACCOUNT_MANAGER_EMAIL: 'KYC@aiib.ly',
  PEP: 'N',
  PRODUCT_CODES: ['SALR'],
  DISTRIBUTION_CHANNEL: '00',
  individual: {
    FIRST_NAME: 'Synthetic',
    LAST_NAME: 'Person',
    BIRTH_DATE: '1985-03-15',
    RELATION_PEP: 'N',
    NATIONALITY: 'LY',
    CITIZENSHIP: 'LY',
    PROFESSION: 'PRSE',
    ACC_PURPOSE: 'JOBS',
    RESIDENT: 'Y',
    FUND_SOURCE: 'BUSN',
    MONTHLY_INCOME: 3000,
  },
});

// Booting the whole app twice (restart scenarios) can exceed Jest's 5 s default when the full suite runs in parallel.
jest.setTimeout(30_000);

describe('Task 5 - customer lifecycle after the REIS answer', () => {
  let dir: string;
  let server: FakeReisServer;
  let staging: FakeStagingDb;
  let mod: TestingModule | undefined;
  let app: INestApplication | undefined;
  let base: string;
  let workflow: IKycWorkflow;
  let cases: IKycCaseRepository;
  let recovery: IFlexcubeUpdateRecoveryService;
  let ds: DataSource;
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    'DB_SQLITE_PATH',
    'REIS_BASE_URL',
    'REIS_TENANT',
    'REIS_USERNAME',
    'REIS_PASSWORD',
    'REIS_TIMEOUT_MS',
    'WEBHOOK_SECURITY_MODE',
    'WEBHOOK_BEARER_TOKEN',
  ];

  const boot = async () => {
    mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FLEXCUBE_STATUS_UPDATER)
      .useValue(new StagingFlexcubeStatusUpdater(staging, 'STTM_KYC_REIS_PAYLOAD_CUSTOM'))
      .compile();
    app = configureApp(mod.createNestApplication());
    await app.listen(0, '127.0.0.1');
    ds = mod.get(DataSource, { strict: false });
    await ds.runMigrations({ transaction: 'all' });
    await seedReferenceMappings(
      mod.get<IReferenceMappingRepository>(REFERENCE_MAPPING_REPOSITORY, { strict: false }),
    );
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    workflow = mod.get<IKycWorkflow>(KYC_WORKFLOW, { strict: false });
    cases = mod.get<IKycCaseRepository>(KYC_CASE_REPOSITORY, { strict: false });
    recovery = mod.get<IFlexcubeUpdateRecoveryService>(FLEXCUBE_UPDATE_RECOVERY_SERVICE, {
      strict: false,
    });
  };
  const shutdown = async () => {
    await app?.close();
    await mod?.close();
    app = undefined;
    mod = undefined;
  };
  const restart = async () => {
    await shutdown();
    await boot();
  };

  const callback = (body: unknown, auth: string | null = `Bearer ${TOKEN}`) =>
    fetch(`${base}/customerStatus`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(body),
    });
  const status = (systemId: string, s: 'CUSTOMER' | 'BLOCKED', customerId?: number) => ({
    status: s,
    systemId,
    ...(customerId !== undefined ? { customerId } : {}),
    systemName: 'Flexcube',
    ServiceType: 'CUSTOMER_STATUS',
  });
  const reisAnswers = (answer: string) => {
    server.onboardingHandler = (req, tokens) =>
      tokens.includes(String(req.headers['x-auth-token']))
        ? { status: 200, body: { status: answer, riskCalculationId: 1 } }
        : { status: 401, body: {} };
  };
  const send = async (kyc: string, answer: string) => {
    staging.addSubmission(kyc); // the poller would have created the N/W row
    reisAnswers(answer);
    return workflow.submit(individual(kyc));
  };
  const events = async (systemId: string) =>
    (
      (await ds.query(
        'SELECT processing_result AS r FROM webhook_event WHERE system_id = ? ORDER BY received_at',
        [systemId],
      )) as { r: string }[]
    ).map((e) => e.r);

  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    dir = mkdtempSync(join(tmpdir(), 'kyc-lifecycle-'));
    server = new FakeReisServer();
    await server.start();
    staging = new FakeStagingDb();
    Object.assign(process.env, {
      DB_SQLITE_PATH: join(dir, 'integration.sqlite'),
      REIS_BASE_URL: server.baseUrl,
      REIS_TENANT: 'public',
      REIS_USERNAME: 'synthetic-user',
      REIS_PASSWORD: 'synthetic-password-not-real',
      REIS_TIMEOUT_MS: '2000',
      WEBHOOK_SECURITY_MODE: 'bearer',
      WEBHOOK_BEARER_TOKEN: TOKEN,
    });
    await boot();
  });

  afterAll(async () => {
    await shutdown();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  beforeEach(() => {
    staging.down = false;
  });

  describe('1. REIS answers CLEAN', () => {
    it('stores CUSTOMER and writes APPROVED to FLEXCUBE at once (no webhook needed)', async () => {
      const r = await send('LC-CLEAN', 'CLEAN');
      expect(r).toMatchObject({
        outcome: 'ONBOARDED',
        kycCase: {
          internalRequestStatus: 'REIS_CLEAN',
          finalStatus: 'CUSTOMER',
          finalStatusReceivedCount: 0,
          flexcubeUpdateStatus: 'APPLIED',
        },
      });
      expect(staging.finalStatusOf('LC-CLEAN')).toBe('APPROVED');
    });
  });

  describe('2. REIS answers REJECT', () => {
    it('stores BLOCKED and writes BLOCKED to FLEXCUBE at once', async () => {
      const r = await send('LC-REJECT', 'REJECT');
      expect(r).toMatchObject({
        kycCase: {
          internalRequestStatus: 'REIS_REJECTED',
          finalStatus: 'BLOCKED',
          flexcubeUpdateStatus: 'APPLIED',
        },
      });
      expect(staging.finalStatusOf('LC-REJECT')).toBe('BLOCKED');
    });
  });

  describe('3. webhook with a wrong token', () => {
    it.each([
      ['no Authorization header', null],
      ['wrong token', 'Bearer wrong-token-wrong-token-wrong-token'],
      ['token with one character changed', `Bearer ${TOKEN.slice(0, -1)}x`],
      ['Basic instead of Bearer', `Basic ${TOKEN}`],
      ['token without scheme', TOKEN],
    ])('%s: 401 and nothing changes', async (_name, auth) => {
      await send(`LC-SEC-${_name.length}`, 'PENDING');
      const systemId = `LC-SEC-${_name.length}`;
      const before = await cases.findByKycRefNo(systemId);
      const writes = staging.finalStatusWrites;
      const res = await callback(status(systemId, 'BLOCKED'), auth);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ result: 'SECURITY_REJECTED' });
      expect(await cases.findByKycRefNo(systemId)).toEqual(before);
      expect(staging.finalStatusWrites).toBe(writes);
      expect(staging.finalStatusOf(systemId)).toBeNull();
      expect(await events(systemId)).toEqual([]); // body of an unauthorized call is not stored
    });

    it('the correct token is then accepted for the same case', async () => {
      await send('LC-SEC-OK', 'PENDING');
      await callback(status('LC-SEC-OK', 'CUSTOMER'), 'Bearer nope-nope-nope-nope-nope-nope');
      const res = await callback(status('LC-SEC-OK', 'CUSTOMER', 101));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ result: 'APPLIED' });
      expect(staging.finalStatusOf('LC-SEC-OK')).toBe('APPROVED');
    });
  });

  describe('4. the same answer arrives twice', () => {
    it('is applied once; the repeat is a DUPLICATE with no second FLEXCUBE write', async () => {
      await send('LC-DUP', 'PENDING');
      const first = await callback(status('LC-DUP', 'BLOCKED', 202));
      expect(await first.json()).toMatchObject({ result: 'APPLIED' });
      const writes = staging.finalStatusWrites;
      const again = await callback(status('LC-DUP', 'BLOCKED', 202));
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ result: 'DUPLICATE' });
      expect(staging.finalStatusWrites).toBe(writes);
      expect(await cases.findByKycRefNo('LC-DUP')).toMatchObject({
        finalStatus: 'BLOCKED',
        finalStatusReceivedCount: 2,
        flexcubeUpdateStatus: 'APPLIED',
      });
      expect(
        server
          .requestsTo(ONBOARDING)
          .filter((q) => (q.json as { systemId: string }).systemId === 'LC-DUP'),
      ).toHaveLength(1);
    });

    it('concurrent identical callbacks: exactly one APPLIED, one FLEXCUBE write', async () => {
      await send('LC-RACE', 'PENDING');
      const writes = staging.finalStatusWrites;
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          callback(status('LC-RACE', 'CUSTOMER', 303)).then(
            async (r) => ((await r.json()) as { result: string }).result,
          ),
        ),
      );
      expect(results.filter((r) => r === 'APPLIED')).toHaveLength(1);
      expect(results.filter((r) => r === 'DUPLICATE')).toHaveLength(5);
      expect(staging.finalStatusWrites).toBe(writes + 1);
      expect(staging.finalStatusOf('LC-RACE')).toBe('APPROVED');
    });
  });

  describe('5. the FLEXCUBE update fails', () => {
    it('keeps the REIS decision, records FAILED, and a safe recovery applies it once', async () => {
      await send('LC-FAIL', 'PENDING');
      staging.down = true;
      const res = await callback(status('LC-FAIL', 'CUSTOMER', 404));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ result: 'UPDATE_FAILED' });
      const failed = await cases.findByKycRefNo('LC-FAIL');
      expect(failed).toMatchObject({
        finalStatus: 'CUSTOMER',
        flexcubeUpdateStatus: 'FAILED',
        flexcubeUpdateErrorCode: 'FLEXCUBE_UPDATE_FAILED',
      });
      expect(failed?.flexcubeUpdateErrorMessage ?? '').not.toContain('ORA-');
      expect(staging.finalStatusOf('LC-FAIL')).toBeNull();

      // Recovery while FLEXCUBE is still down: stays FAILED, decision untouched.
      expect((await recovery.retryFailedUpdate(failed!.internalId)).kycCase).toMatchObject({
        finalStatus: 'CUSTOMER',
        flexcubeUpdateStatus: 'FAILED',
      });
      // FLEXCUBE back: one recovery applies it; a second recovery does nothing.
      staging.down = false;
      expect(await recovery.retryFailedUpdate(failed!.internalId)).toMatchObject({
        kycCase: { flexcubeUpdateStatus: 'APPLIED', finalStatus: 'CUSTOMER' },
      });
      const writes = staging.finalStatusWrites;
      const second = await recovery.retryFailedUpdate(failed!.internalId);
      expect(second.kycCase).toMatchObject({ flexcubeUpdateStatus: 'APPLIED' });
      expect(staging.finalStatusWrites).toBe(writes);
      expect(staging.finalStatusOf('LC-FAIL')).toBe('APPROVED');
    });

    it('a failed immediate CLEAN update is also recoverable', async () => {
      staging.down = true;
      const r = await send('LC-FAIL-CLEAN', 'CLEAN');
      expect(r.kycCase).toMatchObject({ finalStatus: 'CUSTOMER', flexcubeUpdateStatus: 'FAILED' });
      staging.down = false;
      await recovery.retryFailedUpdate(r.kycCase!.internalId);
      expect(staging.finalStatusOf('LC-FAIL-CLEAN')).toBe('APPROVED');
    });
  });

  describe('6. late or unknown answers', () => {
    it('an unknown systemId changes nothing (404, audited)', async () => {
      const writes = staging.finalStatusWrites;
      const res = await callback(status('LC-NOBODY', 'BLOCKED'));
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ result: 'UNKNOWN_CASE' });
      expect(staging.finalStatusWrites).toBe(writes);
      expect(await events('LC-NOBODY')).toEqual(['UNKNOWN_CASE']);
    });

    it('a contrary late answer never turns a final status back (CONFLICT)', async () => {
      await send('LC-LATE', 'PENDING');
      await callback(status('LC-LATE', 'CUSTOMER', 505));
      const res = await callback(status('LC-LATE', 'BLOCKED', 505));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ result: 'CONFLICT' });
      expect(await cases.findByKycRefNo('LC-LATE')).toMatchObject({
        finalStatus: 'CUSTOMER',
        conflictingFinalStatus: 'BLOCKED',
      });
      expect(staging.finalStatusOf('LC-LATE')).toBe('APPROVED');
    });

    it('a callback for a CLEAN / REJECT customer (no webhook expected) is refused', async () => {
      for (const kyc of ['LC-CLEAN', 'LC-REJECT']) {
        const before = await cases.findByKycRefNo(kyc);
        const res = await callback(
          status(kyc, before!.finalStatus === 'CUSTOMER' ? 'BLOCKED' : 'CUSTOMER'),
        );
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ result: 'INCONSISTENT_STATE' });
        expect(await cases.findByKycRefNo(kyc)).toEqual(before);
      }
      expect(staging.finalStatusOf('LC-CLEAN')).toBe('APPROVED');
      expect(staging.finalStatusOf('LC-REJECT')).toBe('BLOCKED');
    });

    it('an answer for customer A never touches customer B', async () => {
      await send('LC-A', 'PENDING');
      await send('LC-B', 'PENDING');
      const b = await cases.findByKycRefNo('LC-B');
      await callback(status('LC-A', 'BLOCKED', 606));
      expect(await cases.findByKycRefNo('LC-B')).toEqual(b);
      expect(staging.finalStatusOf('LC-B')).toBeNull();
      expect(staging.finalStatusOf('LC-A')).toBe('BLOCKED');
    });

    it('a different REIS customerId for the same systemId is refused', async () => {
      await send('LC-ID', 'PENDING');
      await callback(status('LC-ID', 'CUSTOMER', 707));
      const res = await callback(status('LC-ID', 'CUSTOMER', 708));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ result: 'CUSTOMER_ID_MISMATCH' });
    });
  });

  describe('7. after a restart (same database file)', () => {
    it('duplicates are still detected: no second REIS call, no second FLEXCUBE write', async () => {
      await send('LC-RESTART', 'PENDING');
      await callback(status('LC-RESTART', 'CUSTOMER', 808));
      const writes = staging.finalStatusWrites;
      const calls = server.requestsTo(ONBOARDING).length;

      await restart();

      const dup = await callback(status('LC-RESTART', 'CUSTOMER', 808));
      expect(await dup.json()).toMatchObject({ result: 'DUPLICATE' });
      const conflict = await callback(status('LC-RESTART', 'BLOCKED', 808));
      expect(await conflict.json()).toMatchObject({ result: 'CONFLICT' });
      const resubmit = await workflow.submit(individual('LC-RESTART'));
      expect(resubmit).toMatchObject({ outcome: 'DUPLICATE', reason: 'ALREADY_FINALIZED' });
      expect(server.requestsTo(ONBOARDING)).toHaveLength(calls);
      expect(staging.finalStatusWrites).toBe(writes);
      expect(await cases.findByKycRefNo('LC-RESTART')).toMatchObject({
        finalStatus: 'CUSTOMER',
        finalStatusReceivedCount: 2,
      });
    });

    it('a case still PENDING before the restart is finalized by the webhook after it', async () => {
      await send('LC-PEND-RESTART', 'PENDING');
      await restart();
      const res = await callback(status('LC-PEND-RESTART', 'BLOCKED', 909));
      expect(await res.json()).toMatchObject({ result: 'APPLIED' });
      expect(staging.finalStatusOf('LC-PEND-RESTART')).toBe('BLOCKED');
    });

    it('the same KYC submitted concurrently reaches REIS at most once', async () => {
      staging.addSubmission('LC-PAR');
      reisAnswers('PENDING');
      const before = server.requestsTo(ONBOARDING).length;
      const results = await Promise.all(
        Array.from({ length: 5 }, () => workflow.submit(individual('LC-PAR'))),
      );
      expect(results.filter((r) => r.outcome === 'ONBOARDED')).toHaveLength(1);
      expect(server.requestsTo(ONBOARDING).length - before).toBe(1);
    });
  });
});
