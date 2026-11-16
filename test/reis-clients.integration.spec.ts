import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';
import axios from 'axios';
import { inspect } from 'node:util';
import { ReisAuthClient } from '../src/reis/reis-auth.client';
import { ReisOnboardingClient } from '../src/reis/reis-onboarding.client';
import { ReisConfig } from '../src/reis/reis.config';
import {
  ReisAuthenticationError,
  ReisClientError,
  ReisHttpStatusError,
  ReisMalformedResponseError,
  ReisNetworkError,
  ReisTimeoutError,
  ReisUnsupportedStatusError,
} from '../src/reis/reis.errors';
import {
  ReisCorporateItems,
  ReisCorporateRelationEntry,
  ReisIndividualItems,
  ReisIndividualRelationEntry,
  ReisOnboardingRequest,
} from '../src/reis/dto';
import { ReisOnboardingStatus } from '../src/reis/reis-status';
import { ReisHttpTransport } from '../src/reis/transport/reis-http.transport';
import { FakeReisServer } from './support/fake-reis-server';

// All credentials/ids below are synthetic test values.
const PASSWORD = 'synthetic-password-123';
const TENANT = 'test-tenant';
const USER = 'synthetic-user';

const individualItems: ReisIndividualItems = {
  entity_type: 'PP',
  first_name: 'SensitiveFirst',
  last_name: 'SensitiveLast',
  cus_birth_date: '1990-01-31',
  account_manager_login: 'amgr',
  account_manager_email: 'amgr@example.test',
  pep: false,
  relation_pep: true,
  nationality_customer: 'N1',
  nationality: 'N1',
  citizenship_customer: 'C1',
  citizenship: 'C1',
  profession: 'P1',
  account_purpose_individual: 'AP1',
  resident: '1',
  distribution_channel: 'D1',
  product: ['PR1'],
  source_income_individual: 'S1',
  m_income: 1500.5,
  nid: '123456789',
};

const corporateItems: ReisCorporateItems = {
  entity_type: 'PM',
  business_name: 'Trading',
  account_manager_login: 'amgr',
  account_manager_email: 'amgr@example.test',
  pep: false,
  incorp_country: 'X',
  nationality: 'X',
  operation_country: ['X', 'Y'],
  legal_entity: 'L',
  activity: 'A',
  account_purpose_organization: 'AP',
  source_income_organization: 'S',
  distribution_channel: 'D',
  product: ['PR'],
  fin_info: 250000,
};

const individualRelation: ReisIndividualRelationEntry = {
  formId: 3,
  items: {
    entity_type: 'PP',
    first_name: 'RelFirst',
    last_name: 'RelLast',
    cus_birth_date: '1991-02-03',
    nationality: 'N',
    nid: 'P-REL-1',
    issue_date: '2020-01-02',
    valid_until: '2030-01-01',
    citizenship: 'C',
  },
  relationshipId: 3,
  systemName: 'Flexcube',
  systemId: 'REL-0001',
};
const corporateRelation: ReisCorporateRelationEntry = {
  formId: 4,
  items: { entity_type: 'PM', business_name: 'Sub Co', nationality: 'N' },
  relationshipId: 7,
  systemName: 'Flexcube',
  systemId: 'REL-0002',
};

const envelope = (
  systemId: string,
  formId: number,
  items: object,
  relations: ReisOnboardingRequest['relations'] = [],
): ReisOnboardingRequest => ({ systemName: 'Flexcube', systemId, formId, items, relations });

// Main request bodies (relations nested inside, never separate calls).
const individualRequest = envelope('KYC-0001', 1, individualItems, [individualRelation]);
const corporateRequest = envelope('KYC-0002', 2, corporateItems, [corporateRelation]);

describe('REIS clients against a fake REIS server', () => {
  let server: FakeReisServer;
  let config: ReisConfig;
  let auth: ReisAuthClient;
  let onboarding: ReisOnboardingClient;

  const build = (timeoutMs = 2000) => {
    config = Object.defineProperty(
      { baseUrl: server.baseUrl, tenant: TENANT, userName: USER, timeoutMs } as ReisConfig,
      'password',
      { value: PASSWORD, enumerable: false },
    );
    const transport = new ReisHttpTransport(new HttpService(axios.create()), config);
    auth = new ReisAuthClient(transport, config);
    onboarding = new ReisOnboardingClient(auth, transport);
  };

  beforeEach(async () => {
    server = new FakeReisServer();
    await server.start();
    build();
  });
  afterEach(async () => {
    await server.stop();
    jest.restoreAllMocks();
  });

  const fail = async (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => undefined,
      (e: unknown) => e,
    );

  describe('authentication', () => {
    it('POSTs credentials as JSON to /xauth/authenticate/ with the tenant header and returns the token', async () => {
      const token = await auth.authenticate();
      expect(token).toBe('fake-token-1');
      const [req] = server.requests;
      expect(req.method).toBe('POST');
      expect(req.path).toBe('/xauth/authenticate/');
      expect(req.headers['content-type']).toContain('application/json');
      expect(req.headers['x-auth-tenant']).toBe(TENANT);
      expect(req.json).toEqual({ user_name: USER, password: PASSWORD });
      expect(req.headers['x-auth-token']).toBeUndefined();
      expect(req.headers.authorization).toBeUndefined();
    });

    it('rejects a response without a token', async () => {
      server.authHandler = () => ({ status: 200, body: { access_token: 'wrong-field' } });
      expect(await fail(auth.authenticate())).toBeInstanceOf(ReisMalformedResponseError);
    });

    it.each([{ token: '' }, { token: '   ' }, { token: 123 }, { token: null }, []])(
      'rejects a missing/blank/invalid token %p',
      async (body) => {
        server.authHandler = () => ({ status: 200, body });
        expect(await fail(auth.authenticate())).toBeInstanceOf(ReisMalformedResponseError);
      },
    );

    it('rejects a body that is not valid JSON', async () => {
      server.authHandler = () => ({ status: 200, body: '<html>not json</html>' });
      expect(await fail(auth.authenticate())).toBeInstanceOf(ReisMalformedResponseError);
    });

    it('rejects an empty body', async () => {
      server.authHandler = () => ({ status: 200, body: '' });
      expect(await fail(auth.authenticate())).toBeInstanceOf(ReisMalformedResponseError);
    });

    it.each([401, 403])('classifies HTTP %i as an authentication failure', async (status) => {
      server.authHandler = () => ({ status, body: { message: 'denied' } });
      const err = await fail(auth.authenticate());
      expect(err).toBeInstanceOf(ReisAuthenticationError);
      expect(err).toMatchObject({
        category: 'AUTHENTICATION',
        httpStatus: status,
        operation: 'authenticate',
      });
    });

    it('classifies other non-2xx statuses as HTTP status errors', async () => {
      server.authHandler = () => ({ status: 503, body: {} });
      const err = await fail(auth.authenticate());
      expect(err).toBeInstanceOf(ReisHttpStatusError);
      expect(err).toMatchObject({ category: 'HTTP_STATUS', httpStatus: 503 });
    });

    it('classifies a slow server as a timeout', async () => {
      build(150);
      server.authHandler = () => ({ status: 200, body: { token: 't' }, delayMs: 800 });
      const err = await fail(auth.authenticate());
      expect(err).toBeInstanceOf(ReisTimeoutError);
      expect(err).toMatchObject({
        category: 'TIMEOUT',
        timeoutMs: 150,
        requestMayHaveReachedReis: true,
      });
    });

    it('classifies a refused connection as a network failure that never reached REIS', async () => {
      await server.stop();
      const err = await fail(auth.authenticate());
      expect(err).toBeInstanceOf(ReisNetworkError);
      expect(err).toMatchObject({
        category: 'NETWORK',
        errorCode: 'ECONNREFUSED',
        requestMayHaveReachedReis: false,
      });
      await server.start(); // so afterEach can stop it again
    });

    it('classifies a connection reset mid-request as a network failure that may have reached REIS', async () => {
      server.authHandler = () => ({ destroySocket: true });
      const err = await fail(auth.authenticate());
      expect(err).toBeInstanceOf(ReisNetworkError);
      expect(err).toMatchObject({ category: 'NETWORK', requestMayHaveReachedReis: true });
    });

    it('does not retry on its own', async () => {
      server.authHandler = () => ({ status: 503, body: {} });
      await fail(auth.authenticate());
      expect(server.requestsTo('/xauth/authenticate/')).toHaveLength(1);
    });
  });

  describe('onboarding', () => {
    it('authenticates first and sends the returned token as x-auth-token (never Authorization)', async () => {
      await onboarding.onboard(individualRequest);
      expect(server.requests.map((r) => r.path)).toEqual([
        '/xauth/authenticate/',
        '/onboarding/v2/searchOnboardCustomer',
      ]);
      const req = server.requestsTo('/onboarding/v2/searchOnboardCustomer')[0];
      expect(req.method).toBe('POST');
      expect(req.headers['x-auth-token']).toBe('fake-token-1');
      expect(req.headers['x-auth-tenant']).toBe(TENANT);
      expect(req.headers['content-type']).toContain('application/json');
      expect(req.headers.authorization).toBeUndefined();
      expect(server.requests.every((r) => r.headers.authorization === undefined)).toBe(true);
    });

    it('serializes an Individual request exactly as given', async () => {
      await onboarding.onboard(individualRequest);
      const req = server.requestsTo('/onboarding/v2/searchOnboardCustomer')[0];
      expect(req.json).toEqual(individualRequest);
      const items = (req.json as ReisOnboardingRequest).items as ReisIndividualItems;
      expect(items.m_income).toBe(1500.5); // number, not string
      expect(items.pep).toBe(false); // boolean, not string
    });

    it('serializes a Corporate request exactly as given', async () => {
      await onboarding.onboard(corporateRequest);
      const req = server.requestsTo('/onboarding/v2/searchOnboardCustomer')[0];
      expect(req.json).toEqual(corporateRequest);
      const items = (req.json as ReisOnboardingRequest).items as ReisCorporateItems;
      expect(items.fin_info).toBe(250000);
    });

    it('keeps relations nested inside the single main onboarding request', async () => {
      await onboarding.onboard(individualRequest);
      await onboarding.onboard(corporateRequest);
      const posts = server.requestsTo('/onboarding/v2/searchOnboardCustomer');
      // Exactly one onboarding call per main request: no separate calls for formId 3 / 4.
      expect(posts).toHaveLength(2);
      const [first, second] = posts.map((r) => r.json as ReisOnboardingRequest);
      expect(first.formId).toBe(1);
      expect(first.relations).toEqual([individualRelation]);
      expect(first.relations?.[0]).toMatchObject({
        formId: 3,
        relationshipId: 3,
        systemName: 'Flexcube',
        systemId: 'REL-0001',
      });
      expect(second.formId).toBe(2);
      expect(second.relations).toEqual([corporateRelation]);
      expect(posts.map((r) => (r.json as ReisOnboardingRequest).formId)).not.toContain(3);
      expect(posts.map((r) => (r.json as ReisOnboardingRequest).formId)).not.toContain(4);
    });

    it('sends an empty relations array when there are none', async () => {
      await onboarding.onboard(envelope('KYC-0003', 1, individualItems));
      const body = server.requestsTo('/onboarding/v2/searchOnboardCustomer')[0]
        .json as ReisOnboardingRequest;
      expect(body.relations).toEqual([]);
    });

    it('keeps the confirmed wire shape: envelope fields on top, entity_type inside items', async () => {
      await onboarding.onboard(individualRequest);
      const body = server.requestsTo('/onboarding/v2/searchOnboardCustomer')[0].json as Record<
        string,
        unknown
      >;
      expect(Object.keys(body).sort()).toEqual([
        'formId',
        'items',
        'relations',
        'systemId',
        'systemName',
      ]);
      expect((body.items as Record<string, unknown>).entity_type).toBe('PP');
      expect(body).not.toHaveProperty('entity_type');
      const rel = (body.relations as ReisIndividualRelationEntry[])[0];
      expect(rel).not.toHaveProperty('entity_type'); // V1.4: only inside items
      expect(rel.items.entity_type).toBe('PP');
    });

    it.each([
      ['CLEAN', ReisOnboardingStatus.CLEAN],
      ['PENDING', ReisOnboardingStatus.PENDING],
      ['REJECT', ReisOnboardingStatus.REJECT],
    ])('parses a %s response', async (wire, expected) => {
      server.onboardingHandler = () => ({
        status: 200,
        body: {
          status: wire,
          reisId: 4711,
          riskCalculationId: 'RC-9',
          instruction: 'check docs',
          ignored: 'x',
        },
      });
      const res = await onboarding.onboard(individualRequest);
      expect(res).toEqual({
        status: expected,
        reisId: 4711,
        riskCalculationId: 'RC-9',
        instruction: 'check docs',
      });
    });

    it('keeps the wire types of reisId / riskCalculationId (string or number) and accepts null', async () => {
      server.onboardingHandler = () => ({
        status: 200,
        body: { status: 'CLEAN', reisId: null, riskCalculationId: 12 },
      });
      expect(await onboarding.onboard(individualRequest)).toEqual({
        status: 'CLEAN',
        reisId: null,
        riskCalculationId: 12,
      });
    });

    it('accepts a response with only a status', async () => {
      server.onboardingHandler = () => ({ status: 200, body: { status: 'PENDING' } });
      expect(await onboarding.onboard(individualRequest)).toEqual({ status: 'PENDING' });
    });

    it.each(['clean', 'APPROVED', 'CUSTOMER', ''])(
      'rejects unknown status %p without coercion',
      async (status) => {
        server.onboardingHandler = () => ({ status: 200, body: { status } });
        const err = await fail(onboarding.onboard(individualRequest));
        expect(err).toBeInstanceOf(ReisUnsupportedStatusError);
        expect(err).toMatchObject({ category: 'UNSUPPORTED_STATUS', receivedStatus: status });
      },
    );

    it.each([
      [{}],
      [{ status: null }],
      [{ status: 5 }],
      [{ status: 'CLEAN', reisId: { nested: true } }],
      [{ status: 'CLEAN', riskCalculationId: true }],
      [{ status: 'CLEAN', instruction: 7 }],
      [[]],
      ['"just a string"'],
    ])('rejects malformed body %p', async (body) => {
      server.onboardingHandler = () => ({ status: 200, body });
      expect(await fail(onboarding.onboard(individualRequest))).toBeInstanceOf(
        ReisMalformedResponseError,
      );
    });

    it('rejects invalid JSON', async () => {
      server.onboardingHandler = () => ({ status: 200, body: '{oops' });
      expect(await fail(onboarding.onboard(individualRequest))).toBeInstanceOf(
        ReisMalformedResponseError,
      );
    });

    it.each([400, 404, 500, 502])('classifies HTTP %i as a non-2xx failure', async (status) => {
      server.onboardingHandler = () => ({ status, body: { status: 'CLEAN' } });
      const err = await fail(onboarding.onboard(individualRequest));
      expect(err).toBeInstanceOf(ReisHttpStatusError);
      expect(err).toMatchObject({ httpStatus: status, operation: 'searchOnboardCustomer' });
    });

    it.each([401, 403])(
      'classifies onboarding HTTP %i as an authentication failure',
      async (status) => {
        server.onboardingHandler = () => ({ status, body: {} });
        const err = await fail(onboarding.onboard(individualRequest));
        expect(err).toBeInstanceOf(ReisAuthenticationError);
        expect(err).toMatchObject({ operation: 'searchOnboardCustomer', httpStatus: status });
      },
    );

    it('returns a valid REJECT as a normal result even with an informational errorMessage', async () => {
      server.onboardingHandler = () => ({
        status: 200,
        body: {
          status: 'REJECT',
          errorMessage: 'Customer rejected: rule X',
          reisId: 5,
          instruction: 'call',
        },
      });
      const res = await onboarding.onboard(individualRequest);
      expect(res).toEqual({
        status: ReisOnboardingStatus.REJECT,
        errorMessage: 'Customer rejected: rule X',
        reisId: 5,
        instruction: 'call',
      });
    });

    it.each(['CLEAN', 'PENDING', 'REJECT'])(
      'preserves errorMessage and instruction on %s',
      async (status) => {
        server.onboardingHandler = () => ({
          status: 200,
          body: { status, errorMessage: 'info text', instruction: 'next step' },
        });
        const res = await onboarding.onboard(individualRequest);
        expect(res).toMatchObject({ status, errorMessage: 'info text', instruction: 'next step' });
      },
    );

    it('does not raise ReisApplicationError for any recognized status', async () => {
      for (const status of ['CLEAN', 'PENDING', 'REJECT']) {
        server.onboardingHandler = () => ({ status: 200, body: { status, errorMessage: 'x' } });
        const err = await fail(onboarding.onboard(individualRequest));
        expect(err).toBeUndefined();
      }
    });

    it('treats an error body without a status as malformed (missing required structure)', async () => {
      server.onboardingHandler = () => ({
        status: 200,
        body: { errorMessage: 'Something failed' },
      });
      expect(await fail(onboarding.onboard(individualRequest))).toBeInstanceOf(
        ReisMalformedResponseError,
      );
    });

    it.each([null, '', '   '])(
      'keeps a blank errorMessage (%p) as received',
      async (errorMessage) => {
        server.onboardingHandler = () => ({ status: 200, body: { status: 'CLEAN', errorMessage } });
        const res = await onboarding.onboard(individualRequest);
        expect(res.status).toBe('CLEAN');
        expect(res.errorMessage).toBe(errorMessage);
      },
    );

    it('does not log errorMessage or instruction text', async () => {
      const lines: string[] = [];
      jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation((...a: unknown[]) => void lines.push(inspect(a)));
      server.onboardingHandler = () => ({
        status: 200,
        body: {
          status: 'REJECT',
          errorMessage: 'private reason text',
          instruction: 'private instruction',
        },
      });
      await onboarding.onboard(individualRequest);
      const all = lines.join(' | ');
      expect(all).not.toContain('private');
      expect(all).toContain('REJECT');
    });

    it('classifies onboarding timeouts and network failures', async () => {
      build(150);
      server.onboardingHandler = () => ({ status: 200, body: { status: 'CLEAN' }, delayMs: 800 });
      const timeout = await fail(onboarding.onboard(individualRequest));
      expect(timeout).toBeInstanceOf(ReisTimeoutError);
      expect(timeout).toMatchObject({
        operation: 'searchOnboardCustomer',
        requestMayHaveReachedReis: true,
      });

      build();
      server.onboardingHandler = () => ({ destroySocket: true });
      expect(await fail(onboarding.onboard(individualRequest))).toBeInstanceOf(ReisNetworkError);
    });

    it('does not retry a failed onboarding request', async () => {
      server.onboardingHandler = () => ({ status: 500, body: {} });
      await fail(onboarding.onboard(individualRequest));
      expect(server.requestsTo('/onboarding/v2/searchOnboardCustomer')).toHaveLength(1);
      expect(server.requestsTo('/xauth/authenticate/')).toHaveLength(1);
    });

    it('does not call onboarding when authentication fails', async () => {
      server.authHandler = () => ({ status: 401, body: {} });
      expect(await fail(onboarding.onboard(individualRequest))).toBeInstanceOf(
        ReisAuthenticationError,
      );
      expect(server.requestsTo('/onboarding/v2/searchOnboardCustomer')).toHaveLength(0);
    });
  });

  describe('token lifecycle: a fresh token for every onboarding call (no caching)', () => {
    it('two onboarding calls trigger two authentications and use different tokens', async () => {
      await onboarding.onboard(individualRequest);
      await onboarding.onboard(corporateRequest);
      expect(server.requestsTo('/xauth/authenticate/')).toHaveLength(2);
      expect(server.requestsTo('/onboarding/v2/searchOnboardCustomer')).toHaveLength(2);
      expect(server.requests.map((r) => r.path)).toEqual([
        '/xauth/authenticate/',
        '/onboarding/v2/searchOnboardCustomer',
        '/xauth/authenticate/',
        '/onboarding/v2/searchOnboardCustomer',
      ]);
      const tokens = server
        .requestsTo('/onboarding/v2/searchOnboardCustomer')
        .map((r) => r.headers['x-auth-token']);
      expect(tokens).toEqual(['fake-token-1', 'fake-token-2']);
    });

    it('each authenticate() call requests a new token', async () => {
      expect(await auth.authenticate()).toBe('fake-token-1');
      expect(await auth.authenticate()).toBe('fake-token-2');
      expect(server.requestsTo('/xauth/authenticate/')).toHaveLength(2);
    });
  });

  describe('sensitive data protection', () => {
    const captureLogs = () => {
      const lines: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
          lines.push(inspect(args, { depth: 6 }));
        });
      }
      return lines;
    };
    const assertClean = (text: string) => {
      for (const secret of [
        PASSWORD,
        USER,
        'fake-token-',
        'SensitiveFirst',
        'SensitiveLast',
        'RelFirst',
        'RelLast',
        '123456789',
        'amgr@example.test',
        'KYC-0001',
      ]) {
        expect(text).not.toContain(secret);
      }
    };

    it('never logs credentials, tokens, or customer data on success', async () => {
      const lines = captureLogs();
      await onboarding.onboard(individualRequest, { correlationId: 'corr-1' });
      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join('\n');
      assertClean(all);
      expect(all).toContain('corr-1');
      expect(all).toContain('searchOnboardCustomer');
      expect(all).toContain('CLEAN');
    });

    it('never logs secrets on failures, and errors carry no secrets or Axios internals', async () => {
      const lines = captureLogs();
      const errors: unknown[] = [];
      server.onboardingHandler = () => ({ status: 500, body: {} });
      errors.push(await fail(onboarding.onboard(individualRequest)));
      server.authHandler = () => ({ status: 401, body: {} });
      errors.push(await fail(onboarding.onboard(individualRequest)));
      server.authHandler = () => ({ destroySocket: true });
      errors.push(await fail(onboarding.onboard(individualRequest)));
      build(100);
      server.authHandler = () => ({ status: 200, body: { token: 't' }, delayMs: 600 });
      errors.push(await fail(onboarding.onboard(individualRequest)));

      const all = lines.join('\n') + errors.map((e) => inspect(e, { depth: 8 })).join('\n');
      assertClean(all);
      for (const e of errors) {
        expect(e).toBeInstanceOf(ReisClientError);
        expect((e as Error).cause).toBeUndefined();
      }
    });

    it('keeps the password out of the validated config when serialized', () => {
      expect(JSON.stringify(config)).not.toContain(PASSWORD);
      expect(inspect(config)).not.toContain(PASSWORD);
    });
  });
});
