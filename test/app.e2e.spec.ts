import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { FlexcubeCustomerRequest } from '../src/flexcube/dto/flexcube-customer.request';
import { FLEXCUBE_STATUS_UPDATER } from '../src/flexcube/flexcube.interfaces';
import { MockFlexcubeStatusUpdater } from '../src/flexcube/mock-flexcube-status-updater';
import { KYC_WORKFLOW, IKycWorkflow } from '../src/kyc/kyc.interfaces';
import { KYC_CASE_REPOSITORY, IKycCaseRepository } from '../src/persistence/persistence.interfaces';
import {
  IReferenceMappingRepository,
  REFERENCE_MAPPING_REPOSITORY,
} from '../src/mapping/mapping.interfaces';
import { WEBHOOK_SECURITY_STRATEGY } from '../src/webhook/webhook.interfaces';
import {
  DenyAllWebhookSecurityStrategy,
  WebhookSecurityConfigError,
} from '../src/webhook/webhook-security';
import { FakeReisServer } from './support/fake-reis-server';
import { seededMappings } from './support/in-memory-reference-mappings';

// Synthetic values; the fake REIS server stands in for the real UAT environment.
const individualRequest = (kyc: string): FlexcubeCustomerRequest => ({
  KYC_REF_NO: kyc,
  CUSTOMER_TYPE: 'INDIVIDUAL',
  ACCOUNT_MANAGER_LOGIN: 'amgr',
  ACCOUNT_MANAGER_EMAIL: 'amgr@example.test',
  PEP: 'N',
  PRODUCT_CODES: ['T-PROD'],
  DISTRIBUTION_CHANNEL: 'T-CHAN',
  individual: {
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
    MONTHLY_INCOME: 1000,
  },
});

describe('end to end on the real AppModule: submit -> PENDING -> /customerStatus -> FINALIZED', () => {
  let server: FakeReisServer;
  let mod: TestingModule | undefined;
  let app: INestApplication | undefined;
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    'DB_SQLITE_PATH',
    'REIS_BASE_URL',
    'REIS_TENANT',
    'REIS_USERNAME',
    'REIS_PASSWORD',
    'REIS_TIMEOUT_MS',
    'WEBHOOK_SECURITY_MODE',
  ];

  beforeEach(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    server = new FakeReisServer();
    await server.start();
    Object.assign(process.env, {
      DB_SQLITE_PATH: ':memory:',
      REIS_BASE_URL: server.baseUrl,
      REIS_TENANT: 'test-tenant',
      REIS_USERNAME: 'test-user',
      REIS_PASSWORD: 'test-password-not-real',
      REIS_TIMEOUT_MS: '2000',
    });
    delete process.env.WEBHOOK_SECURITY_MODE;
  });
  afterEach(async () => {
    await app?.close();
    await mod?.close();
    app = undefined;
    mod = undefined;
    await server.stop();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const boot = async () => {
    mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication());
    await app.listen(0, '127.0.0.1');
    const ds = mod.get(DataSource, { strict: false });
    await ds.runMigrations({ transaction: 'all' });
    const mappings = mod.get<IReferenceMappingRepository>(REFERENCE_MAPPING_REPOSITORY, {
      strict: false,
    });
    for (const row of await (await seededMappings()).repo.list()) {
      await mappings.upsert({
        mappingType: row.mappingType,
        flexcubeValue: row.flexcubeValue,
        reisValue: row.reisValue,
      });
    }
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    return {
      base,
      workflow: mod.get<IKycWorkflow>(KYC_WORKFLOW, { strict: false }),
      cases: mod.get<IKycCaseRepository>(KYC_CASE_REPOSITORY, { strict: false }),
      updater: mod.get<MockFlexcubeStatusUpdater>(FLEXCUBE_STATUS_UPDATER, { strict: false }),
    };
  };
  const post = (base: string, body: unknown) =>
    fetch(`${base}/customerStatus`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('runs the full flow with the explicit development security strategy', async () => {
    process.env.WEBHOOK_SECURITY_MODE = 'unrestricted-dev';
    const { base, workflow, cases, updater } = await boot();
    server.onboardingHandler = (req, tokens) =>
      tokens.includes(String(req.headers['x-auth-token']))
        ? {
            status: 200,
            body: { status: 'PENDING', riskCalculationId: 5, reisId: 'R-9', instruction: 'wait' },
          }
        : { status: 401, body: {} };

    // Operational endpoints are live on the real application.
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: 'ok',
      checks: { database: 'up', configuration: 'ok' },
    });
    expect(server.requests).toHaveLength(0); // readiness made no REIS call

    const submitted = await workflow.submit(individualRequest('KYC-E2E'));
    expect(submitted).toMatchObject({ outcome: 'ONBOARDED', reisOnboardingStatus: 'PENDING' });
    expect(await cases.findByKycRefNo('KYC-E2E')).toMatchObject({
      internalRequestStatus: 'REIS_PENDING',
      reisInstruction: 'wait',
      flexcubeUpdateStatus: 'NOT_ATTEMPTED',
    });

    const res = await post(base, {
      status: 'CUSTOMER',
      systemId: 'KYC-E2E',
      customerId: 31337,
      systemName: 'Flexcube',
      ServiceType: 'CUSTOMER_STATUS',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: 'APPLIED' });
    expect(await cases.findByKycRefNo('KYC-E2E')).toMatchObject({
      finalStatus: 'CUSTOMER',
      internalRequestStatus: 'FINALIZED',
      reisOnboardingStatus: 'PENDING',
      reisCustomerId: 31337,
      customerNo: null,
      flexcubeUpdateStatus: 'APPLIED',
    });
    expect(updater.received).toHaveLength(1);
    expect(updater.received[0]).toMatchObject({ kycRefNo: 'KYC-E2E', finalStatus: 'CUSTOMER' });

    // A repeat is idempotent: HTTP 200, no second FLEXCUBE update, and no second REIS onboarding.
    const again = await post(base, { status: 'CUSTOMER', systemId: 'KYC-E2E', customerId: 31337 });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ result: 'DUPLICATE' });
    expect(updater.received).toHaveLength(1);
    expect(server.requestsTo('/onboarding/v2/searchOnboardCustomer')).toHaveLength(1);
  });

  it('a case that REIS answered CLEAN is not turned into CUSTOMER/BLOCKED by a callback', async () => {
    process.env.WEBHOOK_SECURITY_MODE = 'unrestricted-dev';
    const { base, workflow, cases, updater } = await boot();
    server.onboardingHandler = (req, tokens) =>
      tokens.includes(String(req.headers['x-auth-token']))
        ? { status: 200, body: { status: 'CLEAN' } }
        : { status: 401, body: {} };
    await workflow.submit(individualRequest('KYC-CLEAN'));
    const res = await post(base, { status: 'BLOCKED', systemId: 'KYC-CLEAN' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ result: 'INCONSISTENT_STATE' });
    // CLEAN already stored CUSTOMER at onboarding; the unexpected callback changed nothing.
    expect(await cases.findByKycRefNo('KYC-CLEAN')).toMatchObject({
      internalRequestStatus: 'REIS_CLEAN',
      finalStatus: 'CUSTOMER',
      finalStatusReceivedCount: 0,
    });
    // FLEXCUBE was told once (APPROVED) at onboarding time; the callback added nothing.
    expect(updater.received).toEqual([
      expect.objectContaining({ kycRefNo: 'KYC-CLEAN', finalStatus: 'CUSTOMER' }),
    ]);
  });

  it('with no security mechanism configured the webhook rejects every call (fail-safe default)', async () => {
    const { base, cases } = await boot();
    expect(mod!.get(WEBHOOK_SECURITY_STRATEGY, { strict: false })).toBeInstanceOf(
      DenyAllWebhookSecurityStrategy,
    );
    await cases.create({ kycRefNo: 'KYC-DENY', customerType: 'INDIVIDUAL' as never });
    const res = await post(base, { status: 'CUSTOMER', systemId: 'KYC-DENY' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ result: 'SECURITY_REJECTED' });
  });

  it('an unsupported security mode stops application startup', async () => {
    process.env.WEBHOOK_SECURITY_MODE = 'api-key';
    const err = await Test.createTestingModule({ imports: [AppModule] })
      .compile()
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(WebhookSecurityConfigError);
  });
});
