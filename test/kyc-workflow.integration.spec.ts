import { MockFlexcubeStatusUpdater } from '../src/flexcube/mock-flexcube-status-updater';
import { HttpService } from '@nestjs/axios';
import axios from 'axios';
import { Logger } from '@nestjs/common';
import { inspect } from 'node:util';
import { DataSource } from 'typeorm';
import { FlexcubeCustomerRequest } from '../src/flexcube/dto/flexcube-customer.request';
import { StrictIsoFlexcubeDateNormalizer } from '../src/flexcube/flexcube-date-normalizer';
import { YesNoResidentParser } from '../src/flexcube/flexcube-resident-parser';
import { FlexcubeToCanonicalMapper } from '../src/flexcube/flexcube-to-canonical.mapper';
import { KycRequestStatus as S } from '../src/common/kyc-status';
import { KycWorkflow } from '../src/kyc/kyc.workflow';
import { KycSubmissionResult } from '../src/kyc/kyc-submission.result';
import { ReferenceMappingType } from '../src/mapping/reference-mapping';
import { SingleSelectionSourceOfIncomeStrategy } from '../src/mapping/single-source-of-income.strategy';
import { TypeOrmKycCaseRepository } from '../src/persistence/typeorm-kyc-case.repository';
import { CanonicalToReisTransformer } from '../src/reis/canonical-to-reis.transformer';
import { ReisAuthClient } from '../src/reis/reis-auth.client';
import { ReisOnboardingClient } from '../src/reis/reis-onboarding.client';
import { ReisConfig } from '../src/reis/reis.config';
import { ReisFinalStatus, ReisOnboardingStatus } from '../src/reis/reis-status';
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

const corporateReq = (kyc = 'KYC-0002', corp = {}): FlexcubeCustomerRequest => ({
  KYC_REF_NO: kyc,
  CUSTOMER_TYPE: 'CORPORATE',
  ACCOUNT_MANAGER_LOGIN: 'amgr',
  ACCOUNT_MANAGER_EMAIL: 'amgr@example.test',
  PEP: 'Y',
  PRODUCT_CODES: ['T-PROD'],
  DISTRIBUTION_CHANNEL: 'T-CHAN',
  corporate: {
    CRP_BUSINESS_NAME: 'Test trading business',
    PARENT_CMPNY_COUNTRY: 'T-INC',
    OPERATION_COUNTRY: ['T-OP1', 'T-OP2'],
    LEGAL_ENTITY: 'T-LEGAL',
    ACTIVITY: 'T-ACT',
    ACC_PURPOSE: 'T-APCORP',
    SOURCE_OF_INCOME: 'T-CORP-INC',
    FIN_INFO: 250000,
    ...corp,
  },
});

describe('KycWorkflow against a fake REIS server and a real (SQLite) repository', () => {
  let ds: DataSource;
  let repo: TypeOrmKycCaseRepository;
  let server: FakeReisServer;
  let mappings: Awaited<ReturnType<typeof seededMappings>>;
  let workflow: KycWorkflow;
  let flexcube: MockFlexcubeStatusUpdater;

  const build = (timeoutMs = 2000) => {
    const config = Object.defineProperty(
      {
        baseUrl: server.baseUrl,
        tenant: 'test-tenant',
        userName: 'synthetic-user',
        timeoutMs,
        systemName: 'Flexcube',
      } as ReisConfig,
      'password',
      { value: PASSWORD, enumerable: false },
    );
    const transport = new ReisHttpTransport(new HttpService(axios.create()), config);
    const auth = new ReisAuthClient(transport, config);
    const onboarding = new ReisOnboardingClient(auth, transport);
    workflow = new KycWorkflow(
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
      onboarding,
      flexcube,
    );
  };

  beforeEach(async () => {
    ds = await createTestDataSource();
    repo = new TypeOrmKycCaseRepository(ds);
    server = new FakeReisServer();
    await server.start();
    mappings = await seededMappings();
    flexcube = new MockFlexcubeStatusUpdater();
    build();
  });
  afterEach(async () => {
    await server.stop();
    await ds.destroy();
  });

  const reply = (body: unknown, status = 200) => {
    server.onboardingHandler = () => ({ status, body });
  };
  const calls = () => ({
    auth: server.requestsTo(AUTH).length,
    onboarding: server.requestsTo(ONBOARDING).length,
  });
  const caseCount = async () =>
    ((await ds.query('SELECT COUNT(*) AS n FROM kyc_case')) as { n: number }[])[0].n;
  const dump = async () => JSON.stringify(await ds.query('SELECT * FROM kyc_case'));
  const onboarded = (r: KycSubmissionResult) => {
    if (r.outcome !== 'ONBOARDED') throw new Error(`expected ONBOARDED, got ${JSON.stringify(r)}`);
    return r;
  };
  const failed = (r: KycSubmissionResult) => {
    if (r.outcome !== 'FAILED') throw new Error(`expected FAILED, got ${r.outcome}`);
    return r;
  };

  describe('successful onboarding', () => {
    it('PENDING does not touch FLEXCUBE (the decision arrives later by webhook)', async () => {
      reply({ status: 'PENDING' });
      const r = onboarded(await workflow.submit(individualReq('KYC-PEND')));
      expect(r.kycCase).toMatchObject({ finalStatus: null, flexcubeUpdateStatus: 'NOT_ATTEMPTED' });
      expect(flexcube.received).toEqual([]);
    });

    it('a failing FLEXCUBE update keeps the CLEAN decision and is recorded as FAILED', async () => {
      reply({ status: 'CLEAN' });
      jest.spyOn(flexcube, 'updateStatus').mockRejectedValueOnce(new Error('db down'));
      const r = onboarded(await workflow.submit(individualReq('KYC-FXF')));
      expect(r.kycCase).toMatchObject({
        internalRequestStatus: S.REIS_CLEAN,
        finalStatus: ReisFinalStatus.CUSTOMER,
        flexcubeUpdateStatus: 'FAILED',
        flexcubeUpdateErrorCode: 'FLEXCUBE_UPDATE_FAILED',
      });
    });

    it('Individual CLEAN: one authentication, one onboarding call, case marked REIS_CLEAN', async () => {
      reply({ status: 'CLEAN', riskCalculationId: 77, reisId: 'R-5' });
      const r = onboarded(await workflow.submit(individualReq()));
      expect(r.reisOnboardingStatus).toBe(ReisOnboardingStatus.CLEAN);
      expect(r.kycCase).toMatchObject({
        kycRefNo: 'KYC-0001',
        reisSystemId: 'KYC-0001',
        customerType: 'INDIVIDUAL',
        internalRequestStatus: S.REIS_CLEAN,
        reisOnboardingStatus: 'CLEAN',
        // CLEAN is final at once (no webhook): CUSTOMER is stored and FLEXCUBE is told now.
        finalStatus: ReisFinalStatus.CUSTOMER,
        finalStatusReceivedCount: 0,
        flexcubeUpdateStatus: 'APPLIED',
        customerNo: null,
        lastErrorCode: null,
        retryCount: 0,
      });
      expect(flexcube.received).toEqual([
        expect.objectContaining({ kycRefNo: 'KYC-0001', finalStatus: ReisFinalStatus.CUSTOMER }),
      ]);
      expect(calls()).toEqual({ auth: 1, onboarding: 1 });
      expect(server.requests.map((q) => q.path)).toEqual([AUTH, ONBOARDING]);
      const sent = server.requestsTo(ONBOARDING)[0].json as {
        systemId: string;
        formId: number;
        items: Record<string, unknown>;
      };
      expect(sent).toMatchObject({
        systemName: 'Flexcube',
        systemId: 'KYC-0001',
        formId: 1,
        relations: [],
      });
      expect(sent.items).toMatchObject({
        entity_type: 'PP',
        first_name: 'Testfirst',
        tin: 'R-DOC',
        nid: '12345',
      });
      expect(server.requestsTo(ONBOARDING)[0].headers['x-auth-token']).toBe('fake-token-1');
    });

    it('Corporate CLEAN', async () => {
      reply({ status: 'CLEAN', reisId: 9 });
      const r = onboarded(await workflow.submit(corporateReq()));
      expect(r.kycCase).toMatchObject({
        kycRefNo: 'KYC-0002',
        customerType: 'CORPORATE',
        internalRequestStatus: S.REIS_CLEAN,
        reisOnboardingStatus: 'CLEAN',
        reisId: '9',
        riskCalculationId: null,
      });
      expect(calls()).toEqual({ auth: 1, onboarding: 1 });
      const sent = server.requestsTo(ONBOARDING)[0].json as {
        systemId: string;
        formId: number;
        items: Record<string, unknown>;
      };
      expect(sent).toMatchObject({ systemId: 'KYC-0002', formId: 2 });
      expect(sent.items).toMatchObject({
        entity_type: 'PM',
        operation_country: ['R-OP1', 'R-OP2'],
      });
    });

    it('PENDING persists PENDING and waits for the later /customerStatus callback', async () => {
      reply({ status: 'PENDING', riskCalculationId: 'RC-1', reisId: 'R-1', instruction: 'wait' });
      const r = onboarded(await workflow.submit(individualReq()));
      expect(r.reisOnboardingStatus).toBe('PENDING');
      expect(r.instruction).toBe('wait');
      expect(r.kycCase).toMatchObject({
        internalRequestStatus: S.REIS_PENDING,
        reisOnboardingStatus: 'PENDING',
        finalStatus: null,
        finalStatusAt: null,
      });
      expect(await repo.findByReisSystemId('KYC-0001')).toMatchObject({
        internalRequestStatus: S.REIS_PENDING,
      });
    });

    it('REJECT persists REJECT (not BLOCKED), marks the request rejected, and stores the REIS text on the case (never logged)', async () => {
      reply({
        status: 'REJECT',
        errorMessage: 'private reject reason',
        instruction: 'private instruction',
        reisId: 3,
      });
      const r = onboarded(await workflow.submit(individualReq()));
      expect(r.reisOnboardingStatus).toBe('REJECT');
      expect(r.errorMessage).toBe('private reject reason');
      expect(r.kycCase).toMatchObject({
        internalRequestStatus: S.REIS_REJECTED,
        reisOnboardingStatus: 'REJECT',
        // REJECT is final at once (no webhook): BLOCKED is stored and FLEXCUBE is told now.
        finalStatus: ReisFinalStatus.BLOCKED,
        flexcubeUpdateStatus: 'APPLIED',
        lastErrorCode: null,
      });
      expect(flexcube.received).toEqual([
        expect.objectContaining({ finalStatus: ReisFinalStatus.BLOCKED }),
      ]);
      // instruction / errorMessage ARE persisted on the case record.
      expect(r.kycCase).toMatchObject({
        reisInstruction: 'private instruction',
        reisErrorMessage: 'private reject reason',
      });
      expect(await repo.findByKycRefNo('KYC-0001')).toMatchObject({
        reisInstruction: 'private instruction',
        reisErrorMessage: 'private reject reason',
        reisId: '3',
      });
    });

    it.each(['CLEAN', 'PENDING', 'REJECT'])(
      'persists riskCalculationId, reisId, status, instruction and errorMessage for %s',
      async (status) => {
        reply({
          status,
          riskCalculationId: 4242,
          reisId: 'R-77',
          instruction: `instruction for ${status}`,
          errorMessage: `message for ${status}`,
        });
        const r = onboarded(await workflow.submit(individualReq(`KYC-T-${status}`)));
        expect(r.kycCase).toMatchObject({
          reisOnboardingStatus: status,
          riskCalculationId: '4242',
          reisId: 'R-77',
          reisInstruction: `instruction for ${status}`,
          reisErrorMessage: `message for ${status}`,
        });
        expect(await repo.findByKycRefNo(`KYC-T-${status}`)).toEqual(r.kycCase);
      },
    );

    it('stores null for text REIS did not send', async () => {
      reply({ status: 'CLEAN' });
      const r = onboarded(await workflow.submit(individualReq('KYC-NT')));
      expect(r.kycCase).toMatchObject({ reisInstruction: null, reisErrorMessage: null });
    });

    it('persists riskCalculationId and reisId exactly (number ids become text)', async () => {
      reply({ status: 'PENDING', riskCalculationId: 123456, reisId: 'REIS-ABC' });
      onboarded(await workflow.submit(individualReq()));
      expect(await repo.findByKycRefNo('KYC-0001')).toMatchObject({
        riskCalculationId: '123456',
        reisId: 'REIS-ABC',
      });
    });

    it('uses KYC_REF_NO as REIS systemId and keeps CUSTOMER_NO nullable / carries it when present', async () => {
      reply({ status: 'CLEAN' });
      const a = onboarded(await workflow.submit(individualReq('KYC-A')));
      expect(a.kycCase).toMatchObject({
        kycRefNo: 'KYC-A',
        reisSystemId: 'KYC-A',
        customerNo: null,
      });
      expect((server.requestsTo(ONBOARDING)[0].json as { systemId: string }).systemId).toBe(
        'KYC-A',
      );
      const b = onboarded(await workflow.submit(individualReq('KYC-B', { CUSTOMER_NO: 'CUST-9' })));
      expect(b.kycCase.customerNo).toBe('CUST-9');
    });

    it('two different KYC_REF_NO values produce independent cases and calls', async () => {
      server.onboardingHandler = (req, tokens) => {
        const status =
          (req.json as { systemId: string }).systemId === 'KYC-P' ? 'PENDING' : 'CLEAN';
        return tokens.includes(String(req.headers['x-auth-token']))
          ? { status: 200, body: { status, reisId: status === 'CLEAN' ? 'R-C' : 'R-P' } }
          : { status: 401, body: {} };
      };
      const a = onboarded(await workflow.submit(individualReq('KYC-C')));
      const b = onboarded(await workflow.submit(individualReq('KYC-P')));
      expect(a.kycCase.internalId).not.toBe(b.kycCase.internalId);
      expect(a.kycCase).toMatchObject({ internalRequestStatus: S.REIS_CLEAN, reisId: 'R-C' });
      expect(b.kycCase).toMatchObject({ internalRequestStatus: S.REIS_PENDING, reisId: 'R-P' });
      expect(await caseCount()).toBe(2);
      expect(calls()).toEqual({ auth: 2, onboarding: 2 });
    });
  });

  describe('failures before REIS is called: zero REIS calls', () => {
    it('a transformation failure (invalid date) makes no REIS call and records VALIDATION_FAILED', async () => {
      const r = failed(
        await workflow.submit(individualReq('KYC-V', {}, { BIRTH_DATE: '31/01/1990' })),
      );
      expect(r).toMatchObject({
        stage: 'VALIDATION',
        code: 'INVALID_FIELD_VALUE',
        requestMayHaveReachedReis: false,
        persistedStatus: S.VALIDATION_FAILED,
      });
      expect(r.kycCase).toMatchObject({
        kycRefNo: 'KYC-V',
        internalRequestStatus: S.VALIDATION_FAILED,
        reisOnboardingStatus: null,
        lastErrorCode: 'INVALID_FIELD_VALUE',
      });
      expect(server.requests).toHaveLength(0);
    });

    it('a missing mapping makes no REIS call and does not echo the value', async () => {
      const r = failed(
        await workflow.submit(individualReq('KYC-M', {}, { PROFESSION: 'T-UNKNOWN-PROF' })),
      );
      expect(r).toMatchObject({
        stage: 'VALIDATION',
        code: 'UNMAPPED_REFERENCE',
        persistedStatus: S.VALIDATION_FAILED,
      });
      expect(r.kycCase?.lastErrorMessage).toContain('PROFESSION');
      expect(r.kycCase?.lastErrorMessage).not.toContain('T-UNKNOWN-PROF');
      expect(server.requests).toHaveLength(0);
    });

    it('Corporate Account Purpose 203/204 are unmapped and stop before REIS', async () => {
      for (const code of ['203', '204']) {
        const r = failed(await workflow.submit(corporateReq(`KYC-${code}`, { ACC_PURPOSE: code })));
        expect(r).toMatchObject({ code: 'UNMAPPED_REFERENCE', stage: 'VALIDATION' });
      }
      expect(server.requests).toHaveLength(0);
    });

    it('a blank KYC_REF_NO or unknown customer type persists nothing and calls nothing', async () => {
      const blank = failed(await workflow.submit(individualReq('  ')));
      expect(blank).toMatchObject({ code: 'MISSING_REQUIRED_FIELD', kycCase: null });
      const bad = failed(
        await workflow.submit(individualReq('KYC-T', { CUSTOMER_TYPE: 'TRUST' as never })),
      );
      expect(bad).toMatchObject({ stage: 'VALIDATION', kycCase: null });
      expect(await caseCount()).toBe(0);
      expect(server.requests).toHaveLength(0);
    });

    it('a corrected resubmission after a validation failure reuses the same case and then calls REIS once', async () => {
      const first = failed(
        await workflow.submit(individualReq('KYC-R', {}, { PROFESSION: 'T-LATE' })),
      );
      expect(server.requests).toHaveLength(0);
      await mappings.repo.upsert({
        mappingType: ReferenceMappingType.PROFESSION,
        flexcubeValue: 'T-LATE',
        reisValue: 'R-LATE',
      });
      reply({ status: 'CLEAN' });
      const second = onboarded(
        await workflow.submit(individualReq('KYC-R', {}, { PROFESSION: 'T-LATE' })),
      );
      expect(second.kycCase.internalId).toBe(first.kycCase?.internalId);
      expect(second.kycCase).toMatchObject({
        internalRequestStatus: S.REIS_CLEAN,
        lastErrorCode: null,
      });
      expect(await caseCount()).toBe(1);
      expect(calls()).toEqual({ auth: 1, onboarding: 1 });
    });
  });

  describe('idempotent submission: an existing KYC_REF_NO is never sent to REIS again', () => {
    const expectNoNewWork = async (
      before: { auth: number; onboarding: number },
      casesBefore: number,
    ) => {
      expect(calls()).toEqual(before);
      expect(await caseCount()).toBe(casesBefore);
    };

    it('new KYC_REF_NO -> processed once', async () => {
      reply({ status: 'CLEAN' });
      onboarded(await workflow.submit(individualReq()));
      expect(calls()).toEqual({ auth: 1, onboarding: 1 });
    });

    it('existing before the REIS call (RECEIVED / SUBMITTED_TO_REIS) -> DUPLICATE, no call', async () => {
      const received = await repo.create({
        kycRefNo: 'KYC-D1',
        customerType: 'INDIVIDUAL' as never,
      });
      const r1 = await workflow.submit(individualReq('KYC-D1'));
      expect(r1).toMatchObject({ outcome: 'DUPLICATE', reason: 'IN_PROGRESS_OR_UNCERTAIN' });
      await repo.updateInternalStatus(received.internalId, S.SUBMITTED_TO_REIS);
      const r2 = await workflow.submit(individualReq('KYC-D1'));
      expect(r2).toMatchObject({ outcome: 'DUPLICATE', reason: 'IN_PROGRESS_OR_UNCERTAIN' });
      await expectNoNewWork({ auth: 0, onboarding: 0 }, 1);
    });

    it.each([
      ['CLEAN', 'ALREADY_CLEAN', S.REIS_CLEAN],
      ['PENDING', 'AWAITING_FINAL_STATUS', S.REIS_PENDING],
      ['REJECT', 'ALREADY_REJECTED', S.REIS_REJECTED],
    ])(
      'existing after %s -> DUPLICATE (%s), state untouched, no call',
      async (status, reason, internal) => {
        reply({ status, reisId: 'R-1' });
        const first = onboarded(await workflow.submit(individualReq('KYC-D2')));
        const before = calls();
        const again = await workflow.submit(individualReq('KYC-D2'));
        expect(again).toMatchObject({ outcome: 'DUPLICATE', reason });
        expect(again.outcome === 'DUPLICATE' && again.kycCase.internalId).toBe(
          first.kycCase.internalId,
        );
        expect(await repo.findByKycRefNo('KYC-D2')).toMatchObject({
          internalRequestStatus: internal,
        });
        await expectNoNewWork(before, 1);
      },
    );

    it('existing after a final status -> DUPLICATE (ALREADY_FINALIZED)', async () => {
      reply({ status: 'PENDING' });
      onboarded(await workflow.submit(individualReq('KYC-D3')));
      await repo.applyFinalStatus('KYC-D3', ReisFinalStatus.CUSTOMER, 5);
      const before = calls();
      expect(await workflow.submit(individualReq('KYC-D3'))).toMatchObject({
        outcome: 'DUPLICATE',
        reason: 'ALREADY_FINALIZED',
      });
      await expectNoNewWork(before, 1);
    });

    it('existing after a failure or uncertain delivery -> DUPLICATE, no automatic resubmission', async () => {
      const a = await repo.create({ kycRefNo: 'KYC-D4', customerType: 'INDIVIDUAL' as never });
      await repo.recordRetryableError(a.internalId, { code: 'X', message: 'x' });
      expect(await workflow.submit(individualReq('KYC-D4'))).toMatchObject({
        outcome: 'DUPLICATE',
        reason: 'PREVIOUS_ATTEMPT_FAILED',
      });
      const b = await repo.create({ kycRefNo: 'KYC-D5', customerType: 'INDIVIDUAL' as never });
      await repo.recordPermanentError(b.internalId, { code: 'X', message: 'x' });
      expect(await workflow.submit(individualReq('KYC-D5'))).toMatchObject({
        outcome: 'DUPLICATE',
        reason: 'PREVIOUS_ATTEMPT_FAILED',
      });
      const c = await repo.create({ kycRefNo: 'KYC-D6', customerType: 'INDIVIDUAL' as never });
      await repo.recordDeliveryUncertain(c.internalId, { code: 'X', message: 'x' });
      expect(await workflow.submit(individualReq('KYC-D6'))).toMatchObject({
        outcome: 'DUPLICATE',
        reason: 'DELIVERY_UNCERTAIN',
      });
      await expectNoNewWork({ auth: 0, onboarding: 0 }, 3);
    });

    it('a duplicate with invalid data is still a duplicate (checked before any processing)', async () => {
      reply({ status: 'CLEAN' });
      onboarded(await workflow.submit(individualReq('KYC-D7')));
      const r = await workflow.submit(individualReq('KYC-D7', {}, { BIRTH_DATE: 'garbage' }));
      expect(r.outcome).toBe('DUPLICATE');
      expect(await repo.findByKycRefNo('KYC-D7')).toMatchObject({
        internalRequestStatus: S.REIS_CLEAN,
        lastErrorCode: null,
      });
    });

    it('concurrent submissions of one KYC_REF_NO produce one case and one REIS onboarding', async () => {
      reply({ status: 'PENDING' });
      const results = await Promise.all([
        workflow.submit(individualReq('KYC-D8')),
        workflow.submit(individualReq('KYC-D8')),
        workflow.submit(individualReq('KYC-D8')),
      ]);
      expect(results.filter((r) => r.outcome === 'ONBOARDED')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'DUPLICATE')).toHaveLength(2);
      expect(await caseCount()).toBe(1);
      expect(calls().onboarding).toBe(1);
    });
  });

  describe('amendments (FLEXCUBE SEQ_NO): resent to REIS with the same systemId', () => {
    it('a higher SEQ_NO after a final decision is sent again and restarts the case', async () => {
      reply({ status: 'CLEAN' });
      const first = onboarded(await workflow.submit(individualReq('KYC-AM1')));
      expect(first.kycCase).toMatchObject({ seqNo: 1, finalStatus: ReisFinalStatus.CUSTOMER });

      reply({ status: 'PENDING' });
      const second = onboarded(await workflow.submit(individualReq('KYC-AM1'), { seqNo: 2 }));
      expect(second.kycCase).toMatchObject({
        internalId: first.kycCase.internalId,
        seqNo: 2,
        reisSystemId: 'KYC-AM1',
        internalRequestStatus: S.REIS_PENDING,
        finalStatus: null,
        flexcubeUpdateStatus: 'NOT_ATTEMPTED',
      });
      expect(calls().onboarding).toBe(2);
      const sent = server
        .requestsTo(ONBOARDING)
        .map((q) => (q.json as { systemId: string }).systemId);
      expect(sent).toEqual(['KYC-AM1', 'KYC-AM1']);
      expect(await caseCount()).toBe(1);
    });

    it('the same SEQ_NO, or an older one, is never sent again', async () => {
      reply({ status: 'CLEAN' });
      onboarded(await workflow.submit(individualReq('KYC-AM2'), { seqNo: 3 }));
      for (const seqNo of [3, 2, 1]) {
        const r = await workflow.submit(individualReq('KYC-AM2'), { seqNo });
        expect(r.outcome).toBe('DUPLICATE');
      }
      expect(calls().onboarding).toBe(1);
    });

    it('an amendment while the previous submission awaits its final status is not sent', async () => {
      reply({ status: 'PENDING' });
      onboarded(await workflow.submit(individualReq('KYC-AM3')));
      const r = await workflow.submit(individualReq('KYC-AM3'), { seqNo: 2 });
      expect(r).toMatchObject({ outcome: 'DUPLICATE', reason: 'AWAITING_FINAL_STATUS' });
      expect(calls().onboarding).toBe(1);
      expect(await repo.findByKycRefNo('KYC-AM3')).toMatchObject({ seqNo: 1 });
    });

    it('an invalid amendment fails before REIS and leaves the closed case untouched', async () => {
      reply({ status: 'CLEAN' });
      const first = onboarded(await workflow.submit(individualReq('KYC-AM4')));
      const r = failed(
        await workflow.submit(individualReq('KYC-AM4', {}, { NATIONALITY: 'T-NOPE' }), {
          seqNo: 2,
        }),
      );
      expect(r).toMatchObject({ stage: 'VALIDATION', code: 'UNMAPPED_REFERENCE' });
      expect(await repo.findByKycRefNo('KYC-AM4')).toEqual(first.kycCase);
      expect(calls().onboarding).toBe(1);
    });

    it('returns the exact REIS request and validated response for the staging table', async () => {
      reply({ status: 'CLEAN', riskCalculationId: 9 });
      const r = onboarded(await workflow.submit(individualReq('KYC-AM5')));
      expect(r.reisRequest).toEqual(server.requestsTo(ONBOARDING)[0].json);
      expect(r.reisResponse).toEqual({ status: 'CLEAN', riskCalculationId: 9 });
    });

    it.each([0, -1, 1.5])('refuses the invalid seqNo %p', async (seqNo) => {
      await expect(workflow.submit(individualReq('KYC-AM6'), { seqNo })).rejects.toThrow(/seqNo/);
    });
  });

  describe('REIS failures are classified, persisted and never retried', () => {
    it('authentication rejected (401): FAILED_PERMANENT, onboarding never called', async () => {
      server.authHandler = () => ({ status: 401, body: {} });
      const r = failed(await workflow.submit(individualReq('KYC-F1')));
      expect(r).toMatchObject({
        stage: 'REIS_AUTHENTICATE',
        code: 'REIS_AUTH_REJECTED',
        requestMayHaveReachedReis: false,
        persistedStatus: S.FAILED_PERMANENT,
      });
      expect(r.kycCase).toMatchObject({
        internalRequestStatus: S.FAILED_PERMANENT,
        lastErrorCode: 'REIS_AUTH_REJECTED',
        reisOnboardingStatus: null,
        retryCount: 0,
      });
      expect(calls()).toEqual({ auth: 1, onboarding: 0 });
    });

    it('authentication server error (503): FAILED_RETRYABLE with retryCount 1 but NO automatic retry', async () => {
      server.authHandler = () => ({ status: 503, body: {} });
      const r = failed(await workflow.submit(individualReq('KYC-F2')));
      expect(r).toMatchObject({
        code: 'REIS_AUTH_HTTP_ERROR',
        persistedStatus: S.FAILED_RETRYABLE,
        requestMayHaveReachedReis: false,
      });
      expect(r.kycCase).toMatchObject({ internalRequestStatus: S.FAILED_RETRYABLE, retryCount: 1 });
      expect(calls()).toEqual({ auth: 1, onboarding: 0 });
    });

    it('onboarding HTTP 400: FAILED_PERMANENT after exactly one call', async () => {
      reply({}, 400);
      const r = failed(await workflow.submit(individualReq('KYC-F3')));
      expect(r).toMatchObject({
        stage: 'REIS_ONBOARDING',
        code: 'REIS_ONBOARDING_HTTP_ERROR',
        persistedStatus: S.FAILED_PERMANENT,
        requestMayHaveReachedReis: true,
      });
      expect(r.kycCase).toMatchObject({
        internalRequestStatus: S.FAILED_PERMANENT,
        reisOnboardingStatus: null,
      });
      expect(calls()).toEqual({ auth: 1, onboarding: 1 });
    });

    it('onboarding HTTP 500: DELIVERY_UNCERTAIN, not retried', async () => {
      reply({}, 500);
      const r = failed(await workflow.submit(individualReq('KYC-F4')));
      expect(r).toMatchObject({
        code: 'REIS_ONBOARDING_HTTP_5XX',
        persistedStatus: S.DELIVERY_UNCERTAIN,
        requestMayHaveReachedReis: true,
      });
      expect(r.kycCase).toMatchObject({
        internalRequestStatus: S.DELIVERY_UNCERTAIN,
        retryCount: 0,
      });
      expect(calls()).toEqual({ auth: 1, onboarding: 1 });
    });

    it('onboarding timeout (request may have reached REIS): DELIVERY_UNCERTAIN, never retried, resubmission blocked', async () => {
      build(150);
      server.onboardingHandler = () => ({ status: 200, body: { status: 'CLEAN' }, delayMs: 800 });
      const r = failed(await workflow.submit(individualReq('KYC-F5')));
      expect(r).toMatchObject({
        stage: 'REIS_ONBOARDING',
        code: 'REIS_ONBOARDING_TIMEOUT',
        requestMayHaveReachedReis: true,
        persistedStatus: S.DELIVERY_UNCERTAIN,
      });
      expect(r.kycCase).toMatchObject({
        internalRequestStatus: S.DELIVERY_UNCERTAIN,
        lastErrorCode: 'REIS_ONBOARDING_TIMEOUT',
        retryCount: 0,
      });
      await new Promise((res) => setTimeout(res, 300)); // give any hidden retry time to appear
      expect(calls()).toEqual({ auth: 1, onboarding: 1 });
      // A later submission of the same KYC_REF_NO makes no external call either.
      expect(await workflow.submit(individualReq('KYC-F5'))).toMatchObject({
        outcome: 'DUPLICATE',
        reason: 'DELIVERY_UNCERTAIN',
      });
      expect(calls()).toEqual({ auth: 1, onboarding: 1 });
    });

    it('connection reset during onboarding: DELIVERY_UNCERTAIN', async () => {
      server.onboardingHandler = () => ({ destroySocket: true });
      const r = failed(await workflow.submit(individualReq('KYC-F6')));
      expect(r).toMatchObject({
        code: 'REIS_ONBOARDING_NETWORK_ERROR',
        persistedStatus: S.DELIVERY_UNCERTAIN,
        requestMayHaveReachedReis: true,
      });
      expect(calls().onboarding).toBe(1);
    });

    it('an unreadable 2xx or unsupported status is DELIVERY_UNCERTAIN (never silently treated as success)', async () => {
      reply('<html>not json</html>');
      const a = failed(await workflow.submit(individualReq('KYC-F7')));
      expect(a).toMatchObject({
        code: 'REIS_ONBOARDING_MALFORMED_RESPONSE',
        persistedStatus: S.DELIVERY_UNCERTAIN,
      });
      reply({ status: 'APPROVED' });
      const b = failed(await workflow.submit(individualReq('KYC-F8')));
      expect(b).toMatchObject({
        code: 'REIS_ONBOARDING_UNSUPPORTED_STATUS',
        persistedStatus: S.DELIVERY_UNCERTAIN,
      });
      expect(calls().onboarding).toBe(2);
    });

    it('an unexpected error from the REIS client is recorded as uncertain and rethrown', async () => {
      const boom = new KycWorkflow(
        {
          map: () => ({ customerType: 'INDIVIDUAL', customerNo: null, kycRefNo: 'KYC-F9' }),
        } as never,
        {
          transform: async () => ({ systemId: 'KYC-F9', formId: 1, items: {}, relations: [] }),
        } as never,
        repo,
        {
          onboard: async () => {
            throw new Error('kaboom');
          },
        } as never,
        flexcube,
      );
      await expect(boom.submit(individualReq('KYC-F9'))).rejects.toThrow('kaboom');
      expect(await repo.findByKycRefNo('KYC-F9')).toMatchObject({
        internalRequestStatus: S.DELIVERY_UNCERTAIN,
        lastErrorCode: 'UNEXPECTED_ERROR',
      });
    });
  });

  describe('REIS response text is never logged or put into exception messages', () => {
    const captureAllLogs = () => {
      const lines: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
          lines.push(inspect(args, { depth: 8 }));
        });
      }
      return lines;
    };
    afterEach(() => jest.restoreAllMocks());

    it('keeps instruction and errorMessage out of every log line on success, duplicates and failures', async () => {
      const lines = captureAllLogs();
      reply({
        status: 'REJECT',
        errorMessage: 'TOP-SECRET-ERROR',
        instruction: 'TOP-SECRET-INSTRUCTION',
        reisId: 1,
      });
      onboarded(await workflow.submit(individualReq('KYC-L1')));
      await workflow.submit(individualReq('KYC-L1')); // duplicate
      // A response with an unsupported status that also carries the text -> failure path.
      reply({
        status: 'APPROVED',
        errorMessage: 'TOP-SECRET-ERROR',
        instruction: 'TOP-SECRET-INSTRUCTION',
      });
      const failure = failed(await workflow.submit(individualReq('KYC-L2')));
      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join('\n');
      expect(all).not.toContain('TOP-SECRET');
      // no KYC reference, name or e-mail in any log line (success, duplicate, failure)
      expect(all).not.toMatch(/KYC-L1|KYC-L2|Testfirst|Testlast|amgr@example\.test/);
      expect(JSON.stringify(failure)).not.toContain('TOP-SECRET');
      expect(failure.kycCase?.lastErrorMessage).not.toContain('TOP-SECRET');
      expect(failure.kycCase?.reisErrorMessage).toBeNull();
    });
  });

  describe('what is persisted', () => {
    it('never stores tokens, credentials, or customer payload values - on success or failure', async () => {
      reply({ status: 'CLEAN', riskCalculationId: 1, reisId: 2, instruction: 'private note' });
      onboarded(await workflow.submit(individualReq('KYC-S1')));
      reply({}, 500);
      failed(await workflow.submit(individualReq('KYC-S2')));
      failed(
        await workflow.submit(
          individualReq('KYC-S3', {}, { BIRTH_DATE: 'bad', FIRST_NAME: 'Testfirst' }),
        ),
      );
      failed(
        await workflow.submit(
          individualReq('KYC-S4', {}, { PROFESSION: 'Secret profession text' }),
        ),
      );
      server.authHandler = () => ({ status: 401, body: { echo: 'fake-token-leak' } });
      failed(await workflow.submit(individualReq('KYC-S5')));

      const stored = await dump();
      for (const forbidden of [
        'fake-token',
        PASSWORD,
        'synthetic-user',
        'Testfirst',
        'Testlast',
        'amgr@example.test',
        '12345', // nid
        '1990-01-31',
        'T-DOC',
        'Secret profession text',
        'access_token',
        'password',
      ]) {
        expect(stored).not.toContain(forbidden);
      }
      // What IS stored: identifiers, statuses, classification codes and the REIS response text.
      expect(stored).toContain('private note');
      expect(stored).toContain('KYC-S1');
      expect(stored).toContain('REIS_ONBOARDING_HTTP_5XX');
    });

    it('persists error text only as classification text (<= 1000 chars, no payload)', async () => {
      reply({}, 500);
      const r = failed(await workflow.submit(individualReq('KYC-S6')));
      expect(r.kycCase?.lastErrorMessage).toBe('REIS searchOnboardCustomer returned HTTP 500');
    });
  });

  it('keeps the whole flow free of retry machinery: failed work stays failed', async () => {
    reply({}, 500);
    await workflow.submit(individualReq('KYC-N1'));
    await new Promise((res) => setTimeout(res, 250));
    expect(calls()).toEqual({ auth: 1, onboarding: 1 });
  });
});
