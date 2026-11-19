import { MockFlexcubeStatusUpdater } from '../src/flexcube/mock-flexcube-status-updater';
import { HttpService } from '@nestjs/axios';
import axios from 'axios';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FlexcubeCustomerRequest } from '../src/flexcube/dto/flexcube-customer.request';
import { StrictIsoFlexcubeDateNormalizer } from '../src/flexcube/flexcube-date-normalizer';
import { YesNoResidentParser } from '../src/flexcube/flexcube-resident-parser';
import { FlexcubeToCanonicalMapper } from '../src/flexcube/flexcube-to-canonical.mapper';
import { CifKycWorkflow } from '../src/kyc/cif-kyc.workflow';
import { CustomerStatusService } from '../src/webhook/customer-status.service';
import { TypeOrmWebhookEventRepository } from '../src/persistence/typeorm-webhook-event.repository';
import { SingleSelectionSourceOfIncomeStrategy } from '../src/mapping/single-source-of-income.strategy';
import { TypeOrmKycCaseRepository } from '../src/persistence/typeorm-kyc-case.repository';
import { CanonicalToReisTransformer } from '../src/reis/canonical-to-reis.transformer';
import { ReisAuthClient } from '../src/reis/reis-auth.client';
import { ReisOnboardingClient } from '../src/reis/reis-onboarding.client';
import { ReisConfig } from '../src/reis/reis.config';
import { ReisHttpTransport } from '../src/reis/transport/reis-http.transport';
import { createTestDataSource } from './support/test-database';
import { seededMappings } from './support/in-memory-reference-mappings';
import { FakeReisServer } from './support/fake-reis-server';

// Synthetic values only.
const PASSWORD = 'synthetic-password-123';
const ONBOARDING = '/onboarding/v2/searchOnboardCustomer';
const AUTH = '/xauth/authenticate/';

const individualReq = (
  kyc = 'KYC-0001',
  over: Partial<FlexcubeCustomerRequest> = {},
  ind = {},
): FlexcubeCustomerRequest => ({
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
    NID: '12345',
    TIN: 'T-DOC',
    RELATION_PEP: 'N',
    NATIONALITY: 'T-NAT',
    CITIZENSHIP: 'T-CIT',
    PROFESSION: 'T-PROF',
    ACC_PURPOSE: 'T-APIND',
    RESIDENT: 'Y',
    FUND_SOURCE: 'T-SALARY',
    MONTHLY_INCOME: 1500.5,
    ...ind,
  },
  ...over,
});

/** CifKycWorkflow: the poller's workflow. systemId = CIF, same path as the CLEAN trial of 19/11/2026. */
describe('CifKycWorkflow (systemId = CIF) against a fake REIS server and a real SQLite repository', () => {
  let ds: DataSource;
  let repo: TypeOrmKycCaseRepository;
  let server: FakeReisServer;
  let mappings: Awaited<ReturnType<typeof seededMappings>>;
  let workflow: CifKycWorkflow;
  let flexcube: MockFlexcubeStatusUpdater;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    ds = await createTestDataSource();
    repo = new TypeOrmKycCaseRepository(ds);
    server = new FakeReisServer();
    await server.start();
    mappings = await seededMappings();
    flexcube = new MockFlexcubeStatusUpdater();
    const config = Object.defineProperty(
      {
        baseUrl: server.baseUrl,
        tenant: 'test-tenant',
        userName: 'synthetic-user',
        timeoutMs: 2000,
        systemName: 'Flexcube',
      } as ReisConfig,
      'password',
      { value: PASSWORD, enumerable: false },
    );
    const transport = new ReisHttpTransport(new HttpService(axios.create()), config);
    workflow = new CifKycWorkflow(
      new FlexcubeToCanonicalMapper(
        new StrictIsoFlexcubeDateNormalizer(),
        new YesNoResidentParser(),
      ),
      new CanonicalToReisTransformer(
        mappings.service,
        new SingleSelectionSourceOfIncomeStrategy(mappings.service),
        config,
      ),
      repo,
      new ReisOnboardingClient(new ReisAuthClient(transport, config), transport),
      flexcube,
    );
  });
  afterEach(async () => {
    await server.stop();
    await ds.destroy();
    jest.restoreAllMocks();
  });

  const reply = (body: unknown, status = 200) => {
    server.onboardingHandler = () => ({ status, body });
  };

  it('sends systemId = CIF, stores the case under the CIF, writes CLEAN for the exact SEQ_NO', async () => {
    reply({ status: 'CLEAN', reisId: 247, riskCalculationId: 247 });
    const result = await workflow.submit(individualReq('KYC-CIF-1', { CUSTOMER_NO: '00009999' }), {
      seqNo: 3,
    });
    expect(result.outcome).toBe('ONBOARDED');
    expect(server.requestsTo(ONBOARDING)[0].json).toMatchObject({ systemId: '00009999' });
    const kycCase = await repo.findByReisSystemId('00009999');
    expect(kycCase).toMatchObject({ kycRefNo: 'KYC-CIF-1', customerNo: '00009999', seqNo: 3 });
    expect(flexcube.received).toEqual([
      expect.objectContaining({ kycRefNo: 'KYC-CIF-1', seqNo: 3, finalStatus: 'CUSTOMER' }),
    ]);
    expect(server.requestsTo(AUTH)).toHaveLength(1);
  });

  it('PENDING, then the REIS callback (systemId = CIF) finishes the same revision', async () => {
    reply({ status: 'PENDING', reisId: 248 });
    await workflow.submit(individualReq('KYC-CIF-2', { CUSTOMER_NO: '00009998' }), { seqNo: 1 });
    expect(flexcube.received).toEqual([]);
    const callbackUpdater = new MockFlexcubeStatusUpdater();
    const service = new CustomerStatusService(
      { authorize: () => true },
      repo,
      new TypeOrmWebhookEventRepository(ds),
      callbackUpdater,
    );
    const out = await service.handle({
      headers: {},
      body: { systemId: '00009998', status: 'CUSTOMER', customerId: 248 },
    });
    expect(out.result).toBe('APPLIED');
    expect(callbackUpdater.received).toEqual([
      expect.objectContaining({ kycRefNo: 'KYC-CIF-2', seqNo: 1, finalStatus: 'CUSTOMER' }),
    ]);
  });

  it('a REIS validation rejection (400) is a FAILED result that never reached a decision', async () => {
    reply(
      { status: 'BAD_REQUEST', message: 'Validation failed for field: account_manager_email' },
      400,
    );
    const result = await workflow.submit(individualReq('KYC-CIF-3', { CUSTOMER_NO: '00009997' }), {
      seqNo: 1,
    });
    expect(result).toMatchObject({ outcome: 'FAILED' });
    expect(flexcube.received).toEqual([]);
  });

  it('account manager login / email are sent trimmed, case kept (REIS matches them exactly)', async () => {
    reply({ status: 'CLEAN' });
    await workflow.submit(
      individualReq('KYC-CIF-5', {
        CUSTOMER_NO: '00009995',
        ACCOUNT_MANAGER_LOGIN: 'Test001 ',
        ACCOUNT_MANAGER_EMAIL: ' samer.elazabi@aiib.ly',
      }),
      { seqNo: 1 },
    );
    expect(server.requestsTo(ONBOARDING)[0].json).toMatchObject({
      items: { account_manager_login: 'Test001', account_manager_email: 'samer.elazabi@aiib.ly' },
    });
  });

  it('the same revision is never sent twice', async () => {
    reply({ status: 'CLEAN' });
    const req = individualReq('KYC-CIF-4', { CUSTOMER_NO: '00009996' });
    await workflow.submit(req, { seqNo: 1 });
    expect((await workflow.submit(req, { seqNo: 1 })).outcome).toBe('DUPLICATE');
    expect(server.requestsTo(ONBOARDING)).toHaveLength(1);
  });
});
