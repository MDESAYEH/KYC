import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { DataSource } from 'typeorm';
import { CustomerType } from '../src/canonical';
import { FlexcubeUpdateStatus, KycRequestStatus as S } from '../src/common/kyc-status';
import { FlexcubeStatusUpdate } from '../src/flexcube/dto/flexcube-status-update';
import {
  FLEXCUBE_STATUS_UPDATER,
  IFlexcubeStatusUpdater,
} from '../src/flexcube/flexcube.interfaces';
import { KycCase } from '../src/persistence/kyc-case';
import { KYC_CASE_REPOSITORY } from '../src/persistence/persistence.interfaces';
import { TypeOrmKycCaseRepository } from '../src/persistence/typeorm-kyc-case.repository';
import { TypeOrmWebhookEventRepository } from '../src/persistence/typeorm-webhook-event.repository';
import { WEBHOOK_EVENT_REPOSITORY } from '../src/persistence/webhook-event';
import { ReisFinalStatus, ReisOnboardingStatus } from '../src/reis/reis-status';
import { CustomerStatusMalformedRequestFilter } from '../src/webhook/customer-status-malformed.filter';
import { CustomerStatusController } from '../src/webhook/customer-status.controller';
import { CustomerStatusService } from '../src/webhook/customer-status.service';
import {
  IWebhookSecurityStrategy,
  WEBHOOK_SECURITY_STRATEGY,
} from '../src/webhook/webhook.interfaces';
import { createTestDataSource } from './support/test-database';

// Synthetic data only.
const SAMPLE = {
  status: 'BLOCKED',
  systemId: '2378287',
  customerId: 217489,
  systemName: 'Flexcube',
  ServiceType: 'CUSTOMER_STATUS',
};

class RecordingUpdater implements IFlexcubeStatusUpdater {
  calls: FlexcubeStatusUpdate[] = [];
  fail = false;
  async updateStatus(update: FlexcubeStatusUpdate): Promise<void> {
    this.calls.push(update);
    if (this.fail) throw new Error('FLEXCUBE is down (internal detail)');
  }
}

describe('POST /customerStatus (real HTTP, real SQLite repositories)', () => {
  let ds: DataSource;
  let cases: TypeOrmKycCaseRepository;
  let events: TypeOrmWebhookEventRepository;
  let updater: RecordingUpdater;
  let security: { authorize: jest.Mock };
  let app: INestApplication;
  let base: string;

  beforeEach(async () => {
    ds = await createTestDataSource();
    cases = new TypeOrmKycCaseRepository(ds);
    events = new TypeOrmWebhookEventRepository(ds);
    updater = new RecordingUpdater();
    security = { authorize: jest.fn().mockReturnValue(true) };
    const moduleRef = await Test.createTestingModule({
      controllers: [CustomerStatusController],
      providers: [
        CustomerStatusService,
        CustomerStatusMalformedRequestFilter,
        { provide: KYC_CASE_REPOSITORY, useValue: cases },
        { provide: WEBHOOK_EVENT_REPOSITORY, useValue: events },
        { provide: FLEXCUBE_STATUS_UPDATER, useValue: updater },
        { provide: WEBHOOK_SECURITY_STRATEGY, useValue: security as IWebhookSecurityStrategy },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(moduleRef.get(CustomerStatusMalformedRequestFilter));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
    await ds.destroy();
  });

  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/customerStatus`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      text,
      json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
  };
  const callback = (systemId: string, status: string, extra: Record<string, unknown> = {}) => ({
    status,
    systemId,
    systemName: 'Flexcube',
    ServiceType: 'CUSTOMER_STATUS',
    ...extra,
  });

  /** A case REIS answered PENDING: the state in which /customerStatus is expected. */
  const pending = async (
    kycRefNo: string,
    over: { reisCustomerId?: number; instruction?: string } = {},
  ) => {
    const c = await cases.create({ kycRefNo, customerType: CustomerType.INDIVIDUAL });
    return cases.recordOnboardingResult(c.internalId, {
      reisOnboardingStatus: ReisOnboardingStatus.PENDING,
      reisId: 'R-1',
      riskCalculationId: 'RC-1',
      ...(over.reisCustomerId !== undefined ? { reisCustomerId: over.reisCustomerId } : {}),
      ...(over.instruction ? { instruction: over.instruction } : {}),
    });
  };
  const allCases = async (): Promise<KycCase[]> => {
    const rows = (await ds.query('SELECT kyc_ref_no FROM kyc_case ORDER BY kyc_ref_no')) as {
      kyc_ref_no: string;
    }[];
    return Promise.all(
      rows.map(async (r) => (await cases.findByKycRefNo(r.kyc_ref_no)) as KycCase),
    );
  };
  const audit = (systemId: string) => events.listBySystemId(systemId);
  const auditDump = async () => JSON.stringify(await ds.query('SELECT * FROM webhook_event'));

  describe('successful processing returns HTTP 200', () => {
    it('PENDING -> CUSTOMER: applies once, persists the final status and tells FLEXCUBE once', async () => {
      const c = await pending('K-1');
      const res = await post(callback('K-1', 'CUSTOMER', { customerId: 555 }));
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ result: 'APPLIED' });
      expect(await cases.findByKycRefNo('K-1')).toMatchObject({
        internalId: c.internalId,
        finalStatus: ReisFinalStatus.CUSTOMER,
        internalRequestStatus: S.FINALIZED,
        reisOnboardingStatus: 'PENDING', // the earlier onboarding result is kept
        reisCustomerId: 555,
        customerNo: null, // REIS customerId is not FLEXCUBE CUSTOMER_NO
        flexcubeUpdateStatus: FlexcubeUpdateStatus.APPLIED,
        finalStatusReceivedCount: 1,
      });
      expect(updater.calls).toEqual([
        {
          kycRefNo: 'K-1',
          customerNo: null,
          finalStatus: 'CUSTOMER',
          reisCustomerId: 555,
          idempotencyKey: `${c.internalId}:CUSTOMER`,
        },
      ]);
    });

    it('PENDING -> BLOCKED: applies once', async () => {
      await pending('K-2');
      const res = await post(callback('K-2', 'BLOCKED'));
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ result: 'APPLIED' });
      expect(await cases.findByKycRefNo('K-2')).toMatchObject({
        finalStatus: 'BLOCKED',
        internalRequestStatus: S.FINALIZED,
        reisCustomerId: null, // customerId is optional
      });
      expect(updater.calls).toHaveLength(1);
      expect(updater.calls[0]).toMatchObject({ finalStatus: 'BLOCKED' });
    });

    it('accepts the exact sample callback and correlates systemId = KYC_REF_NO', async () => {
      await pending('2378287');
      const res = await post(SAMPLE);
      expect(res.status).toBe(200);
      expect(await cases.findByReisSystemId('2378287')).toMatchObject({
        kycRefNo: '2378287',
        finalStatus: 'BLOCKED',
        reisCustomerId: 217489,
      });
    });

    it('accepts a null customerId and ignores unknown extra fields', async () => {
      await pending('K-3');
      const res = await post(callback('K-3', 'CUSTOMER', { customerId: null, surprise: 'x' }));
      expect(res.status).toBe(200);
      expect((await cases.findByKycRefNo('K-3'))?.reisCustomerId).toBeNull();
    });

    it('response carries only the typed result and event id, never REIS text or customer data', async () => {
      await pending('K-4', { instruction: 'SENSITIVE-INSTRUCTION' });
      const res = await post(callback('K-4', 'CUSTOMER'));
      expect(Object.keys(res.json).sort()).toEqual(['eventId', 'result']);
      expect(res.text).not.toContain('SENSITIVE-INSTRUCTION');
      expect(res.text).not.toContain('K-4');
    });
  });

  describe('idempotency', () => {
    it.each(['CUSTOMER', 'BLOCKED'])(
      'a repeated identical %s callback is a DUPLICATE with HTTP 200 and no repeated business effect',
      async (status) => {
        await pending('K-5');
        expect((await post(callback('K-5', status))).json).toMatchObject({ result: 'APPLIED' });
        const second = await post(callback('K-5', status));
        const third = await post(callback('K-5', status));
        expect(second.status).toBe(200);
        expect(third.status).toBe(200);
        expect(second.json).toMatchObject({ result: 'DUPLICATE' });
        expect(await cases.findByKycRefNo('K-5')).toMatchObject({
          finalStatus: status,
          finalStatusReceivedCount: 3,
          flexcubeUpdateStatus: FlexcubeUpdateStatus.APPLIED,
        });
        expect(updater.calls).toHaveLength(1); // the FLEXCUBE update is not repeated
        expect((await audit('K-5')).map((e) => e.processingResult)).toEqual([
          'APPLIED',
          'DUPLICATE',
          'DUPLICATE',
        ]);
      },
    );

    it('concurrent identical callbacks produce exactly one business application', async () => {
      await pending('K-6');
      const results = await Promise.all(
        Array.from({ length: 6 }, () => post(callback('K-6', 'CUSTOMER', { customerId: 9 }))),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => r.json.result === 'APPLIED')).toHaveLength(1);
      expect(results.filter((r) => r.json.result === 'DUPLICATE')).toHaveLength(5);
      expect(updater.calls).toHaveLength(1);
      expect(await cases.findByKycRefNo('K-6')).toMatchObject({
        finalStatus: 'CUSTOMER',
        finalStatusReceivedCount: 6,
        reisCustomerId: 9,
      });
      expect(await audit('K-6')).toHaveLength(6);
    });

    it.each([
      ['CUSTOMER', 'BLOCKED'],
      ['BLOCKED', 'CUSTOMER'],
    ])(
      '%s followed by %s is a CONFLICT: original preserved, attempt audited, no override',
      async (first, second) => {
        await pending('K-7');
        await post(callback('K-7', first));
        const res = await post(callback('K-7', second));
        expect(res.status).toBe(409); // PROVISIONAL status code
        expect(res.json).toMatchObject({ result: 'CONFLICT' });
        expect(await cases.findByKycRefNo('K-7')).toMatchObject({
          finalStatus: first,
          conflictingFinalStatus: second,
          internalRequestStatus: S.FINALIZED,
        });
        expect(updater.calls).toHaveLength(1); // only the first decision reached FLEXCUBE
        expect((await audit('K-7')).map((e) => [e.processingResult, e.incomingStatus])).toEqual([
          ['APPLIED', first],
          ['CONFLICT', second],
        ]);
      },
    );
  });

  describe('safe rejection: nothing is changed', () => {
    it('an unknown systemId never updates any case and is audited', async () => {
      await pending('K-8');
      await pending('K-9');
      const before = await allCases();
      const res = await post(callback('NOT-A-REAL-ID', 'CUSTOMER', { customerId: 1 }));
      expect(res.status).toBe(404); // PROVISIONAL status code
      expect(res.json).toMatchObject({ result: 'UNKNOWN_CASE' });
      expect(await allCases()).toEqual(before);
      expect(updater.calls).toHaveLength(0);
      const [event] = await audit('NOT-A-REAL-ID');
      expect(event).toMatchObject({
        processingResult: 'UNKNOWN_CASE',
        kycCaseInternalId: null,
        incomingStatus: 'CUSTOMER',
      });
    });

    it('correlates only by systemId (never by names or other fields)', async () => {
      const c = await pending('K-10');
      const res = await post({
        ...callback('SOMETHING-ELSE', 'CUSTOMER'),
        kycRefNo: 'K-10',
        KYC_REF_NO: 'K-10',
        firstName: 'Testfirst',
        internalId: c.internalId,
      });
      expect(res.json).toMatchObject({ result: 'UNKNOWN_CASE' });
      expect((await cases.findByKycRefNo('K-10'))?.finalStatus).toBeNull();
    });

    it('a customerId different from the stored REIS customerId is rejected safely', async () => {
      await pending('K-11', { reisCustomerId: 100 });
      const before = await allCases();
      const res = await post(callback('K-11', 'CUSTOMER', { customerId: 200 }));
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ result: 'CUSTOMER_ID_MISMATCH' });
      expect(await allCases()).toEqual(before);
      expect(updater.calls).toHaveLength(0);
      expect((await audit('K-11'))[0]).toMatchObject({
        processingResult: 'CUSTOMER_ID_MISMATCH',
        incomingCustomerId: 200,
      });
    });

    it.each([
      [
        'CLEAN',
        async (id: string) =>
          cases.recordOnboardingResult(id, { reisOnboardingStatus: ReisOnboardingStatus.CLEAN }),
      ],
      [
        'REJECT',
        async (id: string) =>
          cases.recordOnboardingResult(id, { reisOnboardingStatus: ReisOnboardingStatus.REJECT }),
      ],
    ])('a %s case receiving a callback is not silently changed', async (_name, prepare) => {
      const c = await cases.create({ kycRefNo: 'K-12', customerType: CustomerType.INDIVIDUAL });
      const prepared = await prepare(c.internalId);
      for (const status of ['CUSTOMER', 'BLOCKED']) {
        const res = await post(callback('K-12', status, { customerId: 5 }));
        expect(res.status).toBe(409);
        expect(res.json).toMatchObject({ result: 'INCONSISTENT_STATE' });
      }
      expect(await cases.findByKycRefNo('K-12')).toEqual(prepared);
      expect(updater.calls).toHaveLength(0);
      expect((await audit('K-12')).map((e) => e.processingResult)).toEqual([
        'INCONSISTENT_STATE',
        'INCONSISTENT_STATE',
      ]);
    });

    it.each(['CUSTOMER', 'BLOCKED'])(
      'a DELIVERY_UNCERTAIN case receiving %s is RECONCILIATION_REQUIRED: audited, nothing applied, FLEXCUBE not called',
      async (status) => {
        const c = await cases.create({ kycRefNo: 'K-12R', customerType: CustomerType.INDIVIDUAL });
        const prepared = await cases.recordDeliveryUncertain(c.internalId, {
          code: 'REIS_ONBOARDING_TIMEOUT',
          message: 'timed out',
        });
        const res = await post(callback('K-12R', status, { customerId: 5 }));
        expect(res.status).toBe(409); // PROVISIONAL status code
        expect(res.json).toMatchObject({ result: 'RECONCILIATION_REQUIRED' });
        // Not finalized, not overwritten, REIS customerId not stored, FLEXCUBE untouched.
        expect(await cases.findByKycRefNo('K-12R')).toEqual(prepared);
        expect(prepared).toMatchObject({
          internalRequestStatus: S.DELIVERY_UNCERTAIN,
          finalStatus: null,
          flexcubeUpdateStatus: FlexcubeUpdateStatus.NOT_ATTEMPTED,
        });
        expect(updater.calls).toHaveLength(0);
        // The evidence is preserved in the audit, including the incoming final value.
        const [event] = await audit('K-12R');
        expect(event).toMatchObject({
          processingResult: 'RECONCILIATION_REQUIRED',
          incomingStatus: status,
          incomingCustomerId: 5,
          kycCaseInternalId: c.internalId,
          systemId: 'K-12R',
        });
        expect(event.processedAt).toBeInstanceOf(Date);
        // Repeated callbacks stay audited and the case stays untouched.
        await post(callback('K-12R', status));
        expect(await audit('K-12R')).toHaveLength(2);
        expect(await cases.findByKycRefNo('K-12R')).toEqual(prepared);
      },
    );

    it.each(['CLEAN', 'PENDING', 'REJECT', 'clean', 'blocked', '', 'ACTIVE'])(
      'rejects the non-final status %p',
      async (status) => {
        await pending('K-13');
        const res = await post(callback('K-13', status));
        expect(res.status).toBe(400);
        expect(res.json).toMatchObject({ result: 'INVALID' });
        expect((await cases.findByKycRefNo('K-13'))?.finalStatus).toBeNull();
        expect(updater.calls).toHaveLength(0);
        expect((await audit('K-13'))[0]).toMatchObject({
          processingResult: 'INVALID',
          detailCode: 'INVALID_PAYLOAD',
        });
      },
    );

    it.each([
      [{}],
      [[]],
      [{ status: 'CUSTOMER' }],
      [{ systemId: 'K-14' }],
      [{ status: 'CUSTOMER', systemId: 14 }],
      [{ status: 'CUSTOMER', systemId: '' }],
      [{ status: 'CUSTOMER', systemId: 'K-14', customerId: 'abc' }],
      [{ status: 'CUSTOMER', systemId: 'K-14', customerId: 1.5 }],
      [{ status: 'CUSTOMER', systemId: 'K-14', ServiceType: 'OTHER' }],
    ])('rejects the malformed payload %p with HTTP 400 and changes nothing', async (body) => {
      await pending('K-14');
      const before = await allCases();
      const res = await post(body as never);
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ result: 'INVALID' });
      expect(await allCases()).toEqual(before);
      expect(updater.calls).toHaveLength(0);
    });

    it.each(['{ not json', '"just a string"', 'null', '42'])(
      'rejects the non-object body %p with HTTP 400 (HTTP layer) and still audits the attempt',
      async (raw) => {
        await pending('K-15');
        const res = await post(raw);
        expect(res.status).toBe(400);
        expect(res.json).toMatchObject({ result: 'INVALID' });
        expect((await cases.findByKycRefNo('K-15'))?.finalStatus).toBeNull();
        expect(updater.calls).toHaveLength(0);
        expect(security.authorize).toHaveBeenCalledTimes(1); // security still runs first
      },
    );

    it('audits a malformed-JSON attempt with safe metadata only: no raw body, no parser text', async () => {
      const res = await post('{"systemId":"LEAKED-SYSTEM-ID","password":"LEAKED-SECRET", oops');
      expect(res.status).toBe(400);
      expect(Object.keys(res.json).sort()).toEqual(['eventId', 'result']);
      expect(res.text).not.toContain('LEAKED'); // the parser message can quote the body
      const rows = (await ds.query('SELECT * FROM webhook_event')) as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        event_id: res.json.eventId,
        processing_result: 'INVALID',
        detail_code: 'MALFORMED_JSON',
        system_id: null,
        incoming_status: null,
        incoming_customer_id: null,
        system_name: null,
        service_type: null,
        kyc_case_internal_id: null,
      });
      expect(rows[0].received_at).not.toBeNull();
      expect(rows[0].processed_at).not.toBeNull();
      expect(JSON.stringify(rows)).not.toContain('LEAKED');
    });

    it('records an oversized body as PAYLOAD_TOO_LARGE without storing it', async () => {
      const res = await post(
        JSON.stringify({ status: 'CUSTOMER', systemId: 'x', pad: 'p'.repeat(300_000) }),
      );
      expect(res.status).toBe(413);
      expect(res.json).toMatchObject({ result: 'INVALID' });
      const rows = (await ds.query(
        'SELECT detail_code, processing_result FROM webhook_event',
      )) as Record<string, unknown>[];
      expect(rows).toEqual([{ detail_code: 'PAYLOAD_TOO_LARGE', processing_result: 'INVALID' }]);
    });

    it('a malformed attempt from an unauthorized caller is SECURITY_REJECTED, not INVALID', async () => {
      security.authorize.mockReturnValue(false);
      const res = await post('{ not json');
      expect(res.status).toBe(401);
      expect(res.json).toMatchObject({ result: 'SECURITY_REJECTED' });
      const rows = (await ds.query('SELECT processing_result FROM webhook_event')) as Record<
        string,
        unknown
      >[];
      expect(rows).toEqual([{ processing_result: 'SECURITY_REJECTED' }]);
    });

    it('does not weaken JSON validation and does not audit malformed requests to other routes', async () => {
      const other = await fetch(`${base}/somewhere-else`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      });
      expect(other.status).toBe(400); // still rejected by the framework
      expect(((await ds.query('SELECT * FROM webhook_event')) as unknown[]).length).toBe(0);
      expect(security.authorize).not.toHaveBeenCalled();
    });

    it('does not accept other HTTP methods', async () => {
      const res = await fetch(`${base}/customerStatus`, { method: 'GET' });
      expect(res.status).toBe(404);
    });
  });

  describe('webhook security strategy', () => {
    it('is invoked for every callback with the request headers and remote address, before processing', async () => {
      await pending('K-16');
      let applied = false;
      security.authorize.mockImplementation(async () => {
        applied = (await cases.findByKycRefNo('K-16'))?.finalStatus !== null;
        return true;
      });
      await post(callback('K-16', 'CUSTOMER'), { 'x-test-credential': 'abc' });
      await post(callback('K-16', 'CUSTOMER'));
      expect(security.authorize).toHaveBeenCalledTimes(2);
      const arg = security.authorize.mock.calls[0][0] as {
        headers: Record<string, string>;
        remoteAddress: string;
      };
      expect(arg.headers['x-test-credential']).toBe('abc');
      expect(arg.remoteAddress).toMatch(/127\.0\.0\.1/);
      expect(applied).toBe(true); // second call saw the first already applied; first ran before apply
    });

    it.each([
      ['returns false', () => false],
      ['returns a promise of false', async () => false],
      [
        'throws',
        () => {
          throw new Error('boom');
        },
      ],
      [
        'rejects',
        async () => {
          throw new Error('boom');
        },
      ],
      ['returns something other than true', () => 'yes'],
    ])(
      'a strategy that %s rejects the callback with nothing read, changed or sent',
      async (_n, impl) => {
        await pending('K-17');
        const before = await allCases();
        security.authorize.mockImplementation(impl as never);
        const res = await post(callback('K-17', 'CUSTOMER', { customerId: 3 }));
        expect(res.status).toBe(401); // PROVISIONAL status code
        expect(res.json).toMatchObject({ result: 'SECURITY_REJECTED' });
        expect(await allCases()).toEqual(before);
        expect(updater.calls).toHaveLength(0);
        // Audited, but the unauthorized body is never read or stored.
        const rows = (await ds.query('SELECT * FROM webhook_event')) as Record<string, unknown>[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          processing_result: 'SECURITY_REJECTED',
          system_id: null,
          incoming_status: null,
          incoming_customer_id: null,
          system_name: null,
          kyc_case_internal_id: null,
        });
        expect(rows[0].processed_at).not.toBeNull();
      },
    );
  });

  describe('FLEXCUBE update is tracked separately from the REIS final status', () => {
    it('calls the updater exactly once for the first valid callback and never for duplicates', async () => {
      await pending('K-18');
      await post(callback('K-18', 'CUSTOMER'));
      await post(callback('K-18', 'CUSTOMER'));
      await post(callback('K-18', 'CUSTOMER'));
      expect(updater.calls).toHaveLength(1);
    });

    it('a FLEXCUBE failure does not erase the REIS final status; duplicates do not retry it', async () => {
      await pending('K-19');
      updater.fail = true;
      const res = await post(callback('K-19', 'CUSTOMER', { customerId: 77 }));
      expect(res.status).toBe(200); // the REIS callback itself was accepted and stored
      expect(res.json).toMatchObject({ result: 'UPDATE_FAILED' });
      const failed = await cases.findByKycRefNo('K-19');
      expect(failed).toMatchObject({
        finalStatus: 'CUSTOMER', // the REIS decision survives
        internalRequestStatus: S.FINALIZED,
        reisCustomerId: 77,
        flexcubeUpdateStatus: FlexcubeUpdateStatus.FAILED,
        flexcubeUpdateErrorCode: 'FLEXCUBE_UPDATE_FAILED',
        flexcubeUpdatedAt: null,
      });
      expect(failed?.flexcubeUpdateErrorMessage).not.toContain('internal detail');
      expect((await audit('K-19'))[0]).toMatchObject({
        processingResult: 'UPDATE_FAILED',
        detailCode: 'FLEXCUBE_UPDATE_FAILED',
      });
      // No automatic retry: a duplicate callback does not call FLEXCUBE again.
      updater.fail = false;
      const dup = await post(callback('K-19', 'CUSTOMER'));
      expect(dup.json).toMatchObject({ result: 'DUPLICATE' });
      expect(updater.calls).toHaveLength(1);
      expect((await cases.findByKycRefNo('K-19'))?.flexcubeUpdateStatus).toBe(
        FlexcubeUpdateStatus.FAILED,
      );
    });

    it('a successful update is recorded as APPLIED with a timestamp', async () => {
      await pending('K-20');
      await post(callback('K-20', 'BLOCKED'));
      const c = await cases.findByKycRefNo('K-20');
      expect(c).toMatchObject({ flexcubeUpdateStatus: 'APPLIED', flexcubeUpdateErrorCode: null });
      expect(c?.flexcubeUpdatedAt).toBeInstanceOf(Date);
    });

    it('only cases that received a final status leave NOT_ATTEMPTED', async () => {
      await pending('K-21');
      expect((await cases.findByKycRefNo('K-21'))?.flexcubeUpdateStatus).toBe('NOT_ATTEMPTED');
      await post(callback('K-NOPE', 'CUSTOMER'));
      expect((await cases.findByKycRefNo('K-21'))?.flexcubeUpdateStatus).toBe('NOT_ATTEMPTED');
    });
  });

  describe('callback audit', () => {
    it('records safe technical fields with a generated event id and timestamps', async () => {
      await pending('K-22');
      const res = await post(callback('K-22', 'CUSTOMER', { customerId: 12 }));
      const [event] = await audit('K-22');
      expect(event).toMatchObject({
        eventId: res.json.eventId,
        systemId: 'K-22',
        incomingStatus: 'CUSTOMER',
        incomingCustomerId: 12,
        systemName: 'Flexcube',
        serviceType: 'CUSTOMER_STATUS',
        processingResult: 'APPLIED',
        detailCode: null,
      });
      expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(event.kycCaseInternalId).toBe((await cases.findByKycRefNo('K-22'))?.internalId);
      expect(event.receivedAt).toBeInstanceOf(Date);
      expect(event.processedAt).toBeInstanceOf(Date);
      expect(event.processedAt!.getTime()).toBeGreaterThanOrEqual(event.receivedAt.getTime());
    });

    it('gives every callback its own event id', async () => {
      await pending('K-23');
      const a = await post(callback('K-23', 'CUSTOMER'));
      const b = await post(callback('K-23', 'CUSTOMER'));
      expect(a.json.eventId).not.toBe(b.json.eventId);
    });

    it('never stores tokens, credentials, headers, extra fields or customer data', async () => {
      await pending('K-24', { instruction: 'SENSITIVE-INSTRUCTION' });
      await post(
        callback('K-24', 'CUSTOMER', {
          customerId: 4,
          password: 'hunter2-secret',
          token: 'tok-secret-123',
          firstName: 'Testfirst',
          lastName: 'Testlast',
          nid: '99887766',
          nested: { deep: 'deep-secret' },
        }),
        { authorization: 'Bearer bearer-secret-xyz', 'x-api-key': 'api-key-secret' },
      );
      await post(callback('K-24', 'not-a-status', { password: 'hunter2-secret' }), {
        authorization: 'Bearer bearer-secret-xyz',
      });
      const stored = await auditDump();
      for (const forbidden of [
        'hunter2',
        'tok-secret',
        'Testfirst',
        'Testlast',
        '99887766',
        'deep-secret',
        'bearer-secret',
        'api-key-secret',
        'SENSITIVE-INSTRUCTION',
        'password',
        'authorization',
      ]) {
        expect(stored).not.toContain(forbidden);
      }
      expect(stored).toContain('K-24');
    });

    it('truncates oversized echoed fields', async () => {
      await pending('K-25');
      await post(callback('K-25', 'CUSTOMER', { systemName: 'n'.repeat(500), customerId: 1 }));
      const [event] = await audit('K-25');
      expect(event.systemName).toHaveLength(100);
    });

    it('an unauthorized or invalid callback still leaves exactly one audit row each', async () => {
      security.authorize.mockReturnValueOnce(false);
      await post(callback('K-26', 'CUSTOMER'));
      await post({ nope: true });
      const rows = (await ds.query(
        'SELECT processing_result FROM webhook_event ORDER BY received_at',
      )) as {
        processing_result: string;
      }[];
      expect(rows.map((r) => r.processing_result)).toEqual(['SECURITY_REJECTED', 'INVALID']);
    });
  });

  describe('logging', () => {
    it('never logs payloads, REIS text or credentials', async () => {
      const lines: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
          lines.push(inspect(args, { depth: 8 }));
        });
      }
      await pending('K-27', { instruction: 'SENSITIVE-INSTRUCTION' });
      await post(
        callback('K-27', 'CUSTOMER', { password: 'hunter2-secret', firstName: 'Testfirst' }),
        {
          authorization: 'Bearer bearer-secret-xyz',
        },
      );
      await post(callback('K-27', 'BLOCKED')); // conflict
      await post(callback('UNKNOWN', 'CUSTOMER'));
      await post({ bad: true });
      const all = lines.join('\n');
      expect(all).toContain('customerStatus.processed');
      for (const forbidden of [
        'hunter2',
        'Testfirst',
        'bearer-secret',
        'SENSITIVE-INSTRUCTION',
        'K-27',
      ]) {
        expect(all).not.toContain(forbidden);
      }
    });
  });
});
