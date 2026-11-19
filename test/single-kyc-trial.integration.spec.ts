import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpService } from '@nestjs/axios';
import axios from 'axios';
import { Logger } from '@nestjs/common';
import { createTestDataSource } from './support/test-database';
import { SingleTrialDb } from './support/single-trial-db';
import { FakeReisServer } from './support/fake-reis-server';
import { INDIVIDUAL_ROW } from './support/sync-fixtures';
import { FlexcubeKycSource } from '../src/flexcube/source/flexcube-kyc-source';
import { FlexcubeToCanonicalMapper } from '../src/flexcube/flexcube-to-canonical.mapper';
import { StrictIsoFlexcubeDateNormalizer } from '../src/flexcube/flexcube-date-normalizer';
import { YesNoResidentParser } from '../src/flexcube/flexcube-resident-parser';
import { ReferenceMappingService } from '../src/mapping/reference-mapping.service';
import { seedReferenceMappings } from '../src/mapping/seed/agreed-reference-mappings';
import { SingleSelectionSourceOfIncomeStrategy } from '../src/mapping/single-source-of-income.strategy';
import { TypeOrmReferenceMappingRepository } from '../src/persistence/typeorm-reference-mapping.repository';
import { TypeOrmKycCaseRepository } from '../src/persistence/typeorm-kyc-case.repository';
import { CanonicalToReisTransformer } from '../src/reis/canonical-to-reis.transformer';
import { CifOnboardingPreview } from '../src/reis/cif-onboarding-preview';
import { ReisAuthClient } from '../src/reis/reis-auth.client';
import { ReisOnboardingClient } from '../src/reis/reis-onboarding.client';
import { ReisConfig } from '../src/reis/reis.config';
import { SingleKycTrialRepository } from '../src/tools/single-kyc-trial.repository';
import { SingleTrialTransport } from '../src/tools/single-kyc-trial.transport';
import {
  SINGLE_KYC_TRIAL as TARGET,
  SingleTrialApproval,
  SINGLE_TRIAL_CONFIRMATION,
  trialHash,
} from '../src/tools/single-kyc-trial.contract';
import {
  planSingleKycTrial,
  sendSingleKycTrial,
  SingleTrialSendDeps,
  SingleTrialPlan,
} from '../src/tools/single-kyc-trial';
import { validateTrialSourceSql } from '../src/tools/run-single-kyc-trial';
import {
  applyReset,
  LocalCaseRow,
  planReset,
  RESET_CONFIRMATION,
  ResetDeps,
} from '../src/tools/single-kyc-trial-reset';
import { CustomerStatusService } from '../src/webhook/customer-status.service';
import { TypeOrmWebhookEventRepository } from '../src/persistence/typeorm-webhook-event.repository';
import { CustomerType } from '../src/canonical';
import { ReisOnboardingStatus } from '../src/reis/reis-status';

jest.setTimeout(30_000);
describe('ONE fixed KYC trial: synthetic Oracle, isolated SQLite, fake REIS HTTP only', () => {
  let ds: Awaited<ReturnType<typeof createTestDataSource>>;
  let db: SingleTrialDb;
  let server: FakeReisServer;
  let deps: SingleTrialSendDeps;
  let saved: { phase: string; value: unknown }[];
  let baselineRows: string;
  const NOW = Date.parse('2026-11-17T12:00:00Z');
  const path = '/onboarding/v2/searchOnboardCustomer';
  const approval = (
    plan: SingleTrialPlan,
    over: Partial<SingleTrialApproval> = {},
  ): SingleTrialApproval => ({
    approvedBy: 'Synthetic Reviewer',
    approvedAt: new Date(NOW).toISOString(),
    planSha256: plan.planSha256,
    sourceSqlSha256: deps.sourceSqlSha256,
    claimSqlSha256: deps.staging.claimSqlSha256,
    sourceReference: 'Synthetic Finexta source evidence',
    cifSourceAndJoinVerified: true,
    cifAvailableBeforeSubmission: true,
    oldAndCifIdentitiesAbsent: true,
    reisIdentityCheckReference: 'Synthetic REIS lookup evidence',
    isolatedOracleClaimTestReference: 'Synthetic isolated claim evidence (NOT real Oracle proof)',
    cleanPendingBlockedContractReference: 'Synthetic consumer contract',
    exactRevisionCallbackRoutingReference: 'Synthetic callback routing contract',
    pollingAndOtherSendersStopped: true,
    backupsVerified: true,
    rejectToBlockedApproved: false,
    ...over,
  });
  const send = (plan: SingleTrialPlan, over: Partial<SingleTrialApproval> = {}) =>
    sendSingleKycTrial(deps, plan, approval(plan, over), SINGLE_TRIAL_CONFIRMATION, NOW);
  const targetRow = () =>
    db.staging.find((r) => r.KYC_REF_NO === TARGET.kycRefNo && r.SEQ_NO === TARGET.seqNo)!;
  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    ds = await createTestDataSource();
    await seedReferenceMappings(new TypeOrmReferenceMappingRepository(ds));
    server = new FakeReisServer();
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
    await ds.destroy();
    jest.restoreAllMocks();
  });
  beforeEach(async () => {
    await ds.query('DELETE FROM webhook_event');
    await ds.query('DELETE FROM kyc_case');
    db = new SingleTrialDb();
    saved = [];
    server.requests.length = 0;
    server.onboardingHandler = () => ({
      status: 200,
      body: { status: 'CLEAN', reisId: 'SYNTHETIC', extraField: { actual: 'response' } },
    });
    db.master = [
      {
        KYC_REF_NO: TARGET.kycRefNo,
        MOD_NO: 2,
        KYC_CUST_TYPE: 'R',
        RECORD_STAT: 'O',
        AUTH_STAT: 'A',
      },
    ];
    for (let n = 0; n < 58; n++)
      db.staging.push({
        KYC_REF_NO: `HISTORICAL-${n}`,
        SEQ_NO: 1,
        MSGID: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        PROCESS_STATUS: 'E',
        REQUEST: null,
        RESPONSE: '{"error":"ORA-01745"}',
        RETRY_COUNT: 1,
      });
    // A LOWER revision of the same KYC is never touched (the account check reads the highest SEQ_NO).
    db.staging.push({
      KYC_REF_NO: TARGET.kycRefNo,
      SEQ_NO: 0,
      MSGID: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      PROCESS_STATUS: 'E',
      REQUEST: null,
      RESPONSE: 'preserve',
      RETRY_COUNT: 1,
    });
    baselineRows = JSON.stringify(db.staging);
    db.details.set(TARGET.kycRefNo, { ...INDIVIDUAL_ROW });
    db.products.set(TARGET.kycRefNo, ['SALR']);
    const refs = new ReferenceMappingService(new TypeOrmReferenceMappingRepository(ds));
    const config = {
      baseUrl: server.baseUrl,
      tenant: 'synthetic',
      userName: 'synthetic',
      password: 'synthetic',
      timeoutMs: 100,
      systemName: 'Flexcube',
    } as ReisConfig;
    const transport = new SingleTrialTransport(
      new HttpService(axios.create()),
      config,
      async (wire) => {
        saved.push({ phase: 'wire', value: wire });
      },
    );
    deps = {
      assertExecutionAllowed: async () => undefined,
      staging: new SingleKycTrialRepository(db, 'STAGE'),
      sourceSqlSha256: trialHash('synthetic verified query'),
      readCif: jest.fn(async () => [{ CIF_VALUE: '00005818' }]),
      load: () =>
        new FlexcubeKycSource(db, 'STAGE', '2026-11-16').load({
          kycRefNo: TARGET.kycRefNo,
          seqNo: 2,
          customerType: 'INDIVIDUAL',
        }),
      mapper: new FlexcubeToCanonicalMapper(
        new StrictIsoFlexcubeDateNormalizer(),
        new YesNoResidentParser(),
      ),
      preview: new CifOnboardingPreview(
        new CanonicalToReisTransformer(
          refs,
          new SingleSelectionSourceOfIncomeStrategy(refs),
          config,
        ),
      ),
      hasLocalIdentity: async () =>
        Number((await ds.query('SELECT COUNT(*) AS n FROM kyc_case'))[0].n) > 0,
      cases: new TypeOrmKycCaseRepository(ds),
      reis: new ReisOnboardingClient(new ReisAuthClient(transport, config), transport),
      wireResponse: () => transport.wire,
      evidence: async (phase, value) => {
        saved.push({ phase, value });
      },
    };
  });

  it('preflight performs SELECT only and never authenticates, sends or creates a case', async () => {
    const plan = await planSingleKycTrial(deps);
    expect(plan.plan.request.systemId).toBe('00005818');
    expect(plan.plan.target.seqNo).toBe(1); // STTM_CUSTOMER.MOD_NO, not the KYC MOD_NO (2)
    expect(db.writes).toHaveLength(0);
    expect(server.requests).toHaveLength(0);
    expect(saved).toHaveLength(0);
    expect(await deps.hasLocalIdentity()).toBe(false);
  });
  it.each(['CLEAN', 'PENDING'] as const)(
    'stores the fake server actual raw %s response and changes ONLY the CIF version (SEQ_NO 1)',
    async (status) => {
      server.onboardingHandler = () => ({
        status: 200,
        body: { status, extraField: 'retained raw' },
      });
      const plan = await planSingleKycTrial(deps);
      expect(await send(plan)).toMatchObject({
        sent: 1,
        statusRecorded: status,
        requiresReisCallback: status === 'PENDING',
      });
      expect(server.requestsTo(path)).toHaveLength(1);
      expect(server.requestsTo(path)[0].json).toMatchObject({
        systemId: '00005818',
        systemName: 'Flexcube',
      });
      expect(targetRow()).toMatchObject({
        KYC_REF_NO: TARGET.kycRefNo,
        SEQ_NO: TARGET.seqNo,
        PROCESS_STATUS: 'S',
        REIS_FINAL_STATUS: status,
      });
      expect(JSON.parse(targetRow().RESPONSE!).wire.body).toBe(
        JSON.stringify({ status, extraField: 'retained raw' }),
      );
      expect(
        JSON.stringify(
          db.staging.filter(
            (r) => !(r.KYC_REF_NO === TARGET.kycRefNo && r.SEQ_NO === TARGET.seqNo),
          ),
        ),
      ).toBe(baselineRows);
      // Finexta trigger: picked (P) once our row was claimed, and stays P after the answer.
      expect(db.triggers[0].READY_TO_SCAN).toBe('P');
      expect(
        db.writes.every(
          (w) =>
            w.binds.seqNo === TARGET.seqNo &&
            w.binds.kycRefNo === TARGET.kycRefNo &&
            !w.sql.includes('MAX(SEQ_NO)'),
        ),
      ).toBe(true);
      expect(JSON.stringify(saved)).not.toContain('fake-token-');
    },
  );
  it('does not pretend REJECT is CLEAN or BLOCKED without an approved mapping', async () => {
    server.onboardingHandler = () => ({ status: 200, body: { status: 'REJECT' } });
    expect(await send(await planSingleKycTrial(deps))).toMatchObject({
      statusRecorded: null,
      requiresRejectMapping: true,
    });
    expect(targetRow().REIS_FINAL_STATUS).toBeUndefined();
  });
  it('uses BLOCKED for REJECT only with a separately approved Finexta mapping', async () => {
    server.onboardingHandler = () => ({ status: 200, body: { status: 'REJECT' } });
    expect(
      await send(await planSingleKycTrial(deps), { rejectToBlockedApproved: true }),
    ).toMatchObject({ statusRecorded: 'BLOCKED' });
  });
  it.each([
    { rows: [], code: 'CIF_SOURCE_MISSING_OR_AMBIGUOUS' },
    { rows: [{ CIF_VALUE: '' }], code: 'MISSING_CIF' },
    { rows: [{ CIF_VALUE: 5804 }], code: 'INVALID_CIF' },
    { rows: [{ CIF_VALUE: 'WRONG' }], code: 'CIF_DOES_NOT_MATCH_REPORTED_VALUE' },
    {
      rows: [{ CIF_VALUE: '00005818' }, { CIF_VALUE: '00005818' }],
      code: 'CIF_SOURCE_MISSING_OR_AMBIGUOUS',
    },
  ])(
    'refuses missing, numeric, incorrect or ambiguous source CIF ($code)',
    async ({ rows, code }) => {
      deps.readCif = async () => rows;
      await expect(planSingleKycTrial(deps)).rejects.toMatchObject({ code });
      expect(db.writes).toHaveLength(0);
      expect(server.requests).toHaveLength(0);
    },
  );
  it.each([
    'cifSourceAndJoinVerified',
    'cifAvailableBeforeSubmission',
    'oldAndCifIdentitiesAbsent',
    'pollingAndOtherSendersStopped',
    'backupsVerified',
  ] as const)('requires operational evidence: %s', async (key) => {
    const plan = await planSingleKycTrial(deps);
    await expect(send(plan, { [key]: false })).rejects.toMatchObject({
      code: 'PREREQUISITE_NOT_APPROVED',
    });
    expect(db.writes).toHaveLength(0);
    expect(server.requests).toHaveLength(0);
  });
  it('rejects missing, expired or changed approval and a missing explicit confirmation', async () => {
    const plan = await planSingleKycTrial(deps);
    await expect(
      sendSingleKycTrial(deps, plan, undefined, SINGLE_TRIAL_CONFIRMATION, NOW),
    ).rejects.toMatchObject({ code: 'OPERATIONAL_APPROVAL_REQUIRED' });
    await expect(
      send(plan, { approvedAt: new Date(NOW - 3_600_001).toISOString() }),
    ).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED_OR_INVALID' });
    await expect(send(plan, { claimSqlSha256: 'changed' })).rejects.toMatchObject({
      code: 'APPROVAL_EVIDENCE_CHANGED',
    });
    await expect(
      sendSingleKycTrial(deps, plan, approval(plan), undefined, NOW),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(db.writes).toHaveLength(0);
    expect(server.requests).toHaveLength(0);
  });
  it('refuses any existing local or legacy identity before claim', async () => {
    deps.hasLocalIdentity = async () => true;
    await expect(planSingleKycTrial(deps)).rejects.toMatchObject({
      code: 'LOCAL_OR_LEGACY_IDENTITY_EXISTS',
    });
    expect(db.writes).toHaveLength(0);
  });
  const neverSent = (over: Record<string, unknown> = {}) => ({
    KYC_REF_NO: TARGET.kycRefNo,
    SEQ_NO: TARGET.seqNo,
    MSGID: '0b6a1c2e-6b0f-4c55-9a43-1f2d3c4b5a69',
    PROCESS_STATUS: 'E',
    REQUEST: null,
    RESPONSE: '{"error":"ORA-01745"}',
    RETRY_COUNT: 1,
    RES_DATE: '2026-11-17T10:00:00',
    ...over,
  });
  it('reuses our own E row that failed before REIS (ORA-01745) under the same MSGID', async () => {
    db.staging.push(neverSent());
    const plan = await planSingleKycTrial(deps);
    expect(plan.plan.original).toMatchObject({ processStatus: 'E', retryCount: 1 });
    expect(db.writes).toHaveLength(0);
    expect(await send(plan)).toMatchObject({ sent: 1, statusRecorded: 'CLEAN' });
    const rows = db.staging.filter(
      (r) => r.KYC_REF_NO === TARGET.kycRefNo && r.SEQ_NO === TARGET.seqNo,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      MSGID: '0b6a1c2e-6b0f-4c55-9a43-1f2d3c4b5a69',
      PROCESS_STATUS: 'S',
      RETRY_COUNT: 0,
      REIS_FINAL_STATUS: 'CLEAN',
    });
    expect(server.requestsTo(path)).toHaveLength(1);
  });
  it.each([
    {
      label: 'a delivery that may have reached REIS',
      over: { RESPONSE: '{"error":"X","delivery":"UNCERTAIN"}' },
    },
    { label: 'a stored request', over: { REQUEST: '{}' } },
    { label: 'a second failure', over: { RETRY_COUNT: 2 } },
    { label: 'a row of another sender', over: { MSGID: 'FCUBS-0001' } },
    { label: 'a final status', over: { REIS_FINAL_STATUS: 'BLOCKED' } },
  ])('never reuses an E row with $label', async ({ over }) => {
    db.staging.push(neverSent(over));
    const original = JSON.stringify(db.staging);
    await expect(planSingleKycTrial(deps)).rejects.toMatchObject({
      code: 'STAGING_NOT_UNTOUCHED_NEW',
    });
    expect(JSON.stringify(db.staging)).toBe(original);
  });
  it('does not reuse the E row once FCUBS has moved the trigger or the CIF version', async () => {
    db.staging.push(neverSent());
    const plan = await planSingleKycTrial(deps);
    db.triggers[0].READY_TO_SCAN = 'P';
    await expect(send(plan)).rejects.toMatchObject({ code: 'RESTORE_NOT_ACQUIRED' });
    expect(targetRow().PROCESS_STATUS).toBe('E');
    expect(server.requests).toHaveLength(0);
  });
  it('refuses when the KYC has a HIGHER SEQ_NO (the account check would never see our status)', async () => {
    db.staging.push({ ...db.staging[0], KYC_REF_NO: TARGET.kycRefNo, SEQ_NO: 2 });
    await expect(planSingleKycTrial(deps)).rejects.toMatchObject({ code: 'HIGHER_SEQ_NO_EXISTS' });
    expect(db.writes).toHaveLength(0);
    expect(server.requests).toHaveLength(0);
  });
  it('detects changed payload between review and execution without any write', async () => {
    const plan = await planSingleKycTrial(deps);
    db.details.get(TARGET.kycRefNo)!.TOTAL_INCOME = 4000;
    await expect(send(plan)).rejects.toMatchObject({ code: 'PREFLIGHT_STATE_CHANGED' });
    expect(db.writes).toHaveLength(0);
    expect(server.requests).toHaveLength(0);
  });
  it.each(['ORA-01745', 'ORA-02290', 'ORA-01031'])(
    'claim failure %s never sends or marks a new row E',
    async (code) => {
      const plan = await planSingleKycTrial(deps);
      db.executeHook = (sql) => (sql.includes('REQ_DATE = SYSDATE') ? new Error(code) : undefined);
      await expect(send(plan)).rejects.toThrow(code);
      expect(targetRow().PROCESS_STATUS).toBe('N');
      expect(server.requests).toHaveLength(0);
    },
  );
  it('rejects a concurrent CIF modification at the exact claim', async () => {
    const plan = await planSingleKycTrial(deps);
    db.beforeWrite = (sql) => {
      if (sql.includes('REQ_DATE = SYSDATE')) db.customers[0].MOD_NO = 2;
    };
    await expect(send(plan)).rejects.toMatchObject({ code: 'CLAIM_NOT_ACQUIRED' });
    expect(targetRow().PROCESS_STATUS).toBe('N');
    expect(db.triggers[0].READY_TO_SCAN).toBe('U');
    expect(server.requests).toHaveLength(0);
  });
  it('a trigger no longer at U after the claim: claim given back, nothing sent', async () => {
    const plan = await planSingleKycTrial(deps);
    db.beforeWrite = (sql) => {
      if (sql.includes('SET READY_TO_SCAN = :pickedStatus')) db.triggers[0].READY_TO_SCAN = 'P';
    };
    await expect(send(plan)).rejects.toMatchObject({ code: 'TRIGGER_NOT_READY_OR_CIF_CHANGED' });
    expect(targetRow()).toMatchObject({ PROCESS_STATUS: 'N', REQUEST: null });
    expect(server.requests).toHaveLength(0);
  });
  it('failed durable backup stops before any Oracle write', async () => {
    const plan = await planSingleKycTrial(deps);
    deps.evidence = async () => {
      throw Error('disk failure');
    };
    await expect(send(plan)).rejects.toThrow('disk failure');
    expect(db.writes).toHaveLength(0);
    expect(server.requests).toHaveLength(0);
  });
  it('checks the operator stop control again after intent but before REIS authentication', async () => {
    const plan = await planSingleKycTrial(deps);
    let checks = 0;
    deps.assertExecutionAllowed = async () => {
      if (++checks === 2) throw Error('operator stopped');
    };
    await expect(send(plan)).rejects.toThrow('operator stopped');
    expect(server.requests).toHaveLength(0);
    expect(targetRow().PROCESS_STATUS).toBe('W');
    expect(targetRow().REIS_FINAL_STATUS).toBeUndefined();
  });
  const pendingCase = async (systemId: string) => {
    const cases = new TypeOrmKycCaseRepository(ds);
    const c = await cases.create({
      kycRefNo: TARGET.kycRefNo,
      seqNo: TARGET.seqNo,
      customerNo: TARGET.expectedCif,
      reisSystemId: systemId,
      customerType: CustomerType.INDIVIDUAL,
    });
    await cases.recordOnboardingResult(c.internalId, {
      reisOnboardingStatus: ReisOnboardingStatus.PENDING,
    });
    const updateStatus = jest.fn(async () => undefined);
    const service = new CustomerStatusService(
      { authorize: () => true },
      cases,
      new TypeOrmWebhookEventRepository(ds),
      { updateStatus },
    );
    return { cases, c, updateStatus, service };
  };
  it('the CIF callback of the trial reaches EXACTLY its revision (SEQ_NO 1), never MAX(SEQ_NO)', async () => {
    const { service, updateStatus } = await pendingCase(TARGET.expectedCif);
    expect(
      await service.handle({
        headers: {},
        body: { systemId: TARGET.expectedCif, status: 'CUSTOMER' },
      }),
    ).toMatchObject({ result: 'APPLIED' });
    expect(updateStatus).toHaveBeenCalledTimes(1);
    expect(updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        kycRefNo: TARGET.kycRefNo,
        seqNo: TARGET.seqNo,
        finalStatus: 'CUSTOMER',
      }),
    );
  });
  it('the old identity (KYC_REF_NO, never sent) stays quarantined on the callback route', async () => {
    const { service, updateStatus, cases, c } = await pendingCase(TARGET.kycRefNo);
    expect(
      await service.handle({
        headers: {},
        body: { systemId: TARGET.kycRefNo, status: 'CUSTOMER' },
      }),
    ).toMatchObject({ result: 'RECONCILIATION_REQUIRED' });
    expect(updateStatus).not.toHaveBeenCalled();
    expect((await cases.findByInternalId(c.internalId))?.finalStatus).toBeNull();
    const events = await ds.query('SELECT detail_code AS code FROM webhook_event');
    expect(events).toEqual([{ code: 'SINGLE_TRIAL_CALLBACK_QUARANTINED' }]);
  });
  it('a proposed CLEAN returned by a stub cannot override a captured real PENDING body', async () => {
    deps.reis = { onboard: async () => ({ status: ReisOnboardingStatus.CLEAN }) };
    deps.wireResponse = () => ({ status: 200, body: '{"status":"PENDING"}' });
    expect(await send(await planSingleKycTrial(deps))).toMatchObject({ statusRecorded: 'PENDING' });
    expect(targetRow().REIS_FINAL_STATUS).toBe('PENDING');
  });
  it.each([
    { status: 500, body: 'actual error' },
    { status: 200, body: 'not JSON' },
    { status: 200, body: { status: 'UNSUPPORTED' } },
  ])('records real failure response, without setting approval (%j)', async (reply) => {
    server.onboardingHandler = () => reply;
    await expect(send(await planSingleKycTrial(deps))).rejects.toMatchObject({
      code: 'DELIVERY_UNCERTAIN_NO_RESEND',
    });
    expect(targetRow().PROCESS_STATUS).toBe('E');
    expect(targetRow().REIS_FINAL_STATUS).toBeUndefined();
    expect(db.triggers[0].READY_TO_SCAN).toBe('E'); // Finexta: E when processing failed
    expect(JSON.parse(targetRow().RESPONSE!).wire.status).toBe(reply.status);
    expect(server.requestsTo(path)).toHaveLength(1);
  });
  it('timeout never fabricates CLEAN and cannot be retried through this tool', async () => {
    server.onboardingHandler = () => ({ status: 200, body: { status: 'CLEAN' }, delayMs: 250 });
    const plan = await planSingleKycTrial(deps);
    await expect(send(plan)).rejects.toMatchObject({ code: 'DELIVERY_UNCERTAIN_NO_RESEND' });
    expect(targetRow().REIS_FINAL_STATUS).toBeUndefined();
    await expect(planSingleKycTrial(deps)).rejects.toBeDefined();
    expect(server.requestsTo(path)).toHaveLength(1);
  });
  it('response-recording failure leaves W and protected wire evidence, never a second send', async () => {
    const plan = await planSingleKycTrial(deps);
    db.executeHook = (sql) =>
      sql.includes('SET PROCESS_STATUS = :resultStatus') ? Error('recording failure') : undefined;
    await expect(send(plan)).rejects.toThrow('recording failure');
    expect(targetRow().PROCESS_STATUS).toBe('W');
    expect(saved.some((e) => e.phase === 'wire')).toBe(true);
    await expect(planSingleKycTrial(deps)).rejects.toBeDefined();
    expect(server.requestsTo(path)).toHaveLength(1);
  });
  it('the CIF SELECT (docs/finexta-cif-source.sql): trigger at U, SEQ_NO = CIF MOD_NO, selects only the CIF', () => {
    const sql = validateTrialSourceSql(
      readFileSync(join(__dirname, '..', 'docs', 'finexta-cif-source.sql'), 'utf8'),
    );
    expect(sql).toMatch(/^SELECT C\.CUSTOMER_NO AS CIF_VALUE\s+FROM STTM_CUSTOMER C/);
    expect(sql).not.toContain('C.*');
    expect(sql).not.toContain('K.MOD_NO');
    for (const cond of [
      "KYC_DETAILS = 'V'",
      "RECORD_STAT = 'O'",
      "AUTH_STAT = 'A'",
      'C.MOD_NO = :seqNo',
      'FROM STTM_CUSTOMER_CUSTOM T',
      "T.READY_TO_SCAN = 'U'",
    ])
      expect(sql).toContain(cond);
  });
  it('validates source SQL binds and rejects a write, missing version bind or claim-style reserved names', () => {
    expect(
      validateTrialSourceSql(
        'SELECT CIF_VALUE FROM SYNTHETIC_FIXTURE WHERE KYC_REF_NO = :kycRefNo AND MOD_NO = :seqNo',
      ),
    ).toContain(':seqNo');
    for (const sql of [
      'UPDATE anything SET x = 1',
      'SELECT x FROM x WHERE k = :kycRefNo',
      'SELECT x FROM x WHERE k = :from',
      'SELECT x FROM x FOR UPDATE',
    ])
      expect(() => validateTrialSourceSql(sql)).toThrow();
  });

  describe('reset of an attempt that never reached REIS (19/11/2026: authentication timeout)', () => {
    const failBeforeReis = async () => {
      deps.reis = {
        onboard: async () => {
          throw new Error('authenticate TIMEOUT');
        },
      };
      deps.wireResponse = () => undefined;
      await expect(send(await planSingleKycTrial(deps))).rejects.toMatchObject({
        code: 'DELIVERY_UNCERTAIN_NO_RESEND',
      });
    };
    let backups: unknown[];
    const resetDeps = (over: Partial<ResetDeps> = {}): ResetDeps => ({
      staging: deps.staging,
      evidence: { wireSaved: false, failure: { wire: null, delivery: 'UNCERTAIN' } },
      localCases: async () =>
        (await ds.query(
          `SELECT internal_id, kyc_ref_no, reis_system_id, seq_no, internal_request_status,
                  reis_onboarding_status, final_status, last_error_code FROM kyc_case`,
        )) as LocalCaseRow[],
      deleteLocalCase: async (id) => {
        await ds.query('DELETE FROM kyc_case WHERE internal_id = ?', [id]);
        return Number((await ds.query('SELECT COUNT(*) AS n FROM kyc_case'))[0].n) === 0;
      },
      backup: async (v) => {
        backups.push(v);
      },
      ...over,
    });
    const confirm = {
      confirmation: RESET_CONFIRMATION,
      reisConfirmation: 'Synthetic REIS: nothing received',
    };
    beforeEach(() => {
      backups = [];
    });

    it('the failed attempt leaves E + marker, trigger E and a DELIVERY_UNCERTAIN case; no REIS request', async () => {
      await failBeforeReis();
      expect(targetRow()).toMatchObject({
        PROCESS_STATUS: 'E',
        RESPONSE: '{"wire":null,"delivery":"UNCERTAIN"}',
        RETRY_COUNT: 1,
      });
      expect(db.triggers[0].READY_TO_SCAN).toBe('E');
      expect(server.requests).toHaveLength(0);
      expect((await planReset(resetDeps())).refusals).toEqual([]);
    });

    it('reset puts back N / U / no case, and the normal trial then sends exactly once', async () => {
      await failBeforeReis();
      expect(await applyReset(resetDeps(), confirm)).toMatchObject({ reset: true });
      expect(targetRow()).toMatchObject({
        PROCESS_STATUS: 'N',
        REQUEST: null,
        RESPONSE: null,
        RETRY_COUNT: 0,
      });
      expect(targetRow().REQ_DATE).toBeUndefined();
      expect(db.triggers[0].READY_TO_SCAN).toBe('U');
      expect(await deps.hasLocalIdentity()).toBe(false);
      expect(backups).toHaveLength(1);
      // a fresh attempt through the normal path (real HTTP to the fake REIS)
      const transport = new SingleTrialTransport(
        new HttpService(axios.create()),
        {
          baseUrl: server.baseUrl,
          tenant: 'synthetic',
          userName: 'synthetic',
          password: 'synthetic',
          timeoutMs: 1000,
          systemName: 'Flexcube',
        } as ReisConfig,
        async () => undefined,
      );
      deps.reis = new ReisOnboardingClient(
        new ReisAuthClient(transport, { timeoutMs: 1000 } as ReisConfig),
        transport,
      );
      deps.wireResponse = () => transport.wire;
      expect(await send(await planSingleKycTrial(deps))).toMatchObject({ sent: 1 });
      expect(server.requestsTo(path)).toHaveLength(1);
      expect(targetRow()).toMatchObject({ PROCESS_STATUS: 'S', REIS_FINAL_STATUS: 'CLEAN' });
    });

    it.each([
      {
        label: 'a captured wire (REIS answered)',
        over: { evidence: { wireSaved: true, failure: { wire: null, delivery: 'UNCERTAIN' } } },
        code: 'WIRE_RESPONSE_EXISTS_REIS_ANSWERED',
      },
      {
        label: 'other failure evidence',
        over: {
          evidence: { wireSaved: false, failure: { wire: { status: 500 }, delivery: 'UNCERTAIN' } },
        },
        code: 'FAILURE_EVIDENCE_NOT_UNDELIVERED',
      },
    ])('refuses with $label and writes nothing', async ({ over, code }) => {
      await failBeforeReis();
      const before = JSON.stringify(db.staging);
      const writes = db.writes.length;
      await expect(
        applyReset(resetDeps(over as Partial<ResetDeps>), confirm),
      ).rejects.toMatchObject({
        code: expect.stringContaining(code),
      });
      expect(JSON.stringify(db.staging)).toBe(before);
      expect(db.writes).toHaveLength(writes);
      expect(backups).toHaveLength(0);
    });

    describe('REIS rejected the onboarding with a validation error (HTTP 400, 19/11/2026 14:14)', () => {
      const rejection = {
        status: 'BAD_REQUEST',
        timestamp: '19-11-2026 02:12:49',
        message:
          'Validation failed for field: account_manager_email Field customerIdentification1.cols1_6.account_manager_email has an invalid value\n',
      };
      const rejectOnce = async (body: unknown = rejection, status = 400) => {
        server.onboardingHandler = () => ({ status, body });
        await expect(send(await planSingleKycTrial(deps))).rejects.toMatchObject({
          code: 'DELIVERY_UNCERTAIN_NO_RESEND',
        });
        const phase = (p: string) => saved.find((e) => e.phase === p)?.value;
        return { wireSaved: true, wire: phase('wire'), failure: phase('failure') };
      };

      it('plans a reset of kind REJECTED_BY_REIS_VALIDATION naming the field, then sends again once', async () => {
        const evidence = await rejectOnce();
        const plan = await planReset(resetDeps({ evidence }));
        expect(plan).toMatchObject({
          kind: 'REJECTED_BY_REIS_VALIDATION',
          rejectedField: 'account_manager_email',
          refusals: [],
        });
        expect(await applyReset(resetDeps({ evidence }), confirm)).toMatchObject({
          reset: true,
          kind: 'REJECTED_BY_REIS_VALIDATION',
        });
        expect(targetRow()).toMatchObject({ PROCESS_STATUS: 'N', REQUEST: null, RESPONSE: null });
        expect(db.triggers[0].READY_TO_SCAN).toBe('U');
        server.onboardingHandler = () => ({ status: 200, body: { status: 'CLEAN' } });
        saved.length = 0;
        expect(await send(await planSingleKycTrial(deps))).toMatchObject({ sent: 1 });
        expect(server.requestsTo(path)).toHaveLength(2); // the rejected one and the new one
      });

      it.each([
        ['a 500', { status: 'ERROR', message: 'Validation failed for field: x' }, 500],
        [
          'a 400 that is not a validation error',
          { status: 'BAD_REQUEST', message: 'Something else' },
          400,
        ],
        ['a 400 with a non-JSON body', 'plain text', 400],
      ])('refuses %s', async (_label, body, status) => {
        const evidence = await rejectOnce(body, status as number);
        const writes = db.writes.length;
        await expect(applyReset(resetDeps({ evidence }), confirm)).rejects.toMatchObject({
          code: expect.stringContaining('WIRE_RESPONSE_EXISTS_REIS_ANSWERED'),
        });
        expect(db.writes).toHaveLength(writes);
        expect(targetRow().PROCESS_STATUS).toBe('E');
      });

      it('refuses when the row or failure.json no longer match the captured wire', async () => {
        const evidence = await rejectOnce();
        const other = {
          ...(evidence.wire as object),
          body: JSON.stringify({ ...rejection, timestamp: 'x' }),
        };
        await expect(
          applyReset(resetDeps({ evidence: { ...evidence, wire: other } }), confirm),
        ).rejects.toMatchObject({
          code: expect.stringContaining('FAILURE_EVIDENCE_DOES_NOT_MATCH_WIRE'),
        });
        expect(targetRow().PROCESS_STATUS).toBe('E');
      });
    });

    it('refuses without the confirmation phrase or the REIS reference', async () => {
      await failBeforeReis();
      await expect(
        applyReset(resetDeps(), { reisConfirmation: 'x'.repeat(20) }),
      ).rejects.toMatchObject({
        code: 'CONFIRMATION_REQUIRED',
      });
      await expect(
        applyReset(resetDeps(), { confirmation: RESET_CONFIRMATION, reisConfirmation: 'short' }),
      ).rejects.toMatchObject({ code: 'REIS_CONFIRMATION_REFERENCE_REQUIRED' });
    });

    it('refuses when the trigger moved (FCUBS set U again) or nothing failed', async () => {
      expect((await planReset(resetDeps())).refusals).toEqual(
        expect.arrayContaining(['STAGING_ROW_NOT_THE_FAILED_ATTEMPT', 'TRIGGER_NOT_E']),
      );
      await failBeforeReis();
      db.triggers[0].READY_TO_SCAN = 'U';
      await expect(applyReset(resetDeps(), confirm)).rejects.toMatchObject({
        code: expect.stringContaining('TRIGGER_NOT_E'),
      });
      expect(targetRow().PROCESS_STATUS).toBe('E');
    });
  });
});
