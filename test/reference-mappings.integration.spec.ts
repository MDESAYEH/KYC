import 'reflect-metadata';
import { HttpService } from '@nestjs/axios';
import axios from 'axios';
import { DataSource } from 'typeorm';
import { FlexcubeCustomerRequest } from '../src/flexcube/dto/flexcube-customer.request';
import { StrictIsoFlexcubeDateNormalizer } from '../src/flexcube/flexcube-date-normalizer';
import { YesNoResidentParser } from '../src/flexcube/flexcube-resident-parser';
import { FlexcubeToCanonicalMapper } from '../src/flexcube/flexcube-to-canonical.mapper';
import { MockFlexcubeStatusUpdater } from '../src/flexcube/mock-flexcube-status-updater';
import { KycWorkflow } from '../src/kyc/kyc.workflow';
import { KycSubmissionResult } from '../src/kyc/kyc-submission.result';
import { ReferenceMappingService } from '../src/mapping/reference-mapping.service';
import {
  agreedReferenceMappings,
  seedReferenceMappings,
} from '../src/mapping/seed/agreed-reference-mappings';
import { SingleSelectionSourceOfIncomeStrategy } from '../src/mapping/single-source-of-income.strategy';
import { buildDataSourceOptions } from '../src/persistence/database.config';
import { TypeOrmKycCaseRepository } from '../src/persistence/typeorm-kyc-case.repository';
import { TypeOrmReferenceMappingRepository } from '../src/persistence/typeorm-reference-mapping.repository';
import { CanonicalToReisTransformer } from '../src/reis/canonical-to-reis.transformer';
import { ReisAuthClient } from '../src/reis/reis-auth.client';
import { ReisOnboardingClient } from '../src/reis/reis-onboarding.client';
import { ReisConfig } from '../src/reis/reis.config';
import { ReisHttpTransport } from '../src/reis/transport/reis-http.transport';
import { FakeReisServer } from './support/fake-reis-server';

/**
 * Task 4 - integration test of the agreed reference lists (Appendix V1.4) on the real stack:
 * empty SQLite database -> migrations -> mappings:seed -> FLEXCUBE request -> mapper ->
 * transformer -> REIS client (against a fake REIS HTTP server). Synthetic data only.
 */
const ONBOARDING = '/onboarding/v2/searchOnboardCustomer';
const AUTH = '/xauth/authenticate/';
const PASSWORD = 'synthetic-password-123';

/** V1.4 formId 1 keys (Postman V1.4 SC-002 + optional fields we send). */
const V14_INDIVIDUAL_KEYS = [
  'account_manager_email',
  'account_manager_login',
  'account_purpose_individual',
  'birth_place',
  'citizenship',
  'citizenship_customer',
  'cus_birth_date',
  'distribution_channel',
  'entity_type',
  'expiry_date',
  'first_name',
  'last_name',
  'm_income',
  'nationality',
  'nationality_customer',
  'nid',
  'pep',
  'product',
  'profession',
  'relation_pep',
  'resident',
  'source_income_individual',
  'tin',
];

const V14_CORPORATE_KEYS = [
  'account_manager_email',
  'account_manager_login',
  'account_purpose_organization',
  'activity',
  'business_name',
  'distribution_channel',
  'entity_type',
  'fin_info',
  'incorp_country',
  'legal_entity',
  'nationality',
  'operation_country',
  'pep',
  'product',
  'source_income_organization',
  'trade_no',
];

const individualReq = (
  kyc: string,
  over: Partial<FlexcubeCustomerRequest> = {},
  ind: Record<string, unknown> = {},
): FlexcubeCustomerRequest => ({
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
    BIRTH_PLACE: 'Tripoli',
    NID: 'P10000001',
    EXPIRY_DATE: '2030-01-09',
    RELATION_PEP: 'N',
    NATIONALITY: 'LY',
    CITIZENSHIP: 'LY',
    PROFESSION: 'PRSE',
    ACC_PURPOSE: 'JOBS',
    RESIDENT: 'Y',
    FUND_SOURCE: 'BUSN',
    MONTHLY_INCOME: 3000,
    ...ind,
  },
  ...over,
});

const corporateReq = (
  kyc: string,
  corp: Record<string, unknown> = {},
): FlexcubeCustomerRequest => ({
  KYC_REF_NO: kyc,
  CUSTOMER_TYPE: 'CORPORATE',
  ACCOUNT_MANAGER_LOGIN: 'account_manager',
  ACCOUNT_MANAGER_EMAIL: 'KYC@aiib.ly',
  PEP: 'N',
  PRODUCT_CODES: ['FX01', 'LC01'],
  DISTRIBUTION_CHANNEL: '04',
  corporate: {
    CRP_BUSINESS_NAME: 'SYNTHETIC FX SERVICES',
    PARENT_CMPNY_COUNTRY: 'DZ',
    OPERATION_COUNTRY: ['DZ', 'LB'],
    LEGAL_ENTITY: 'NNPFT',
    ACTIVITY: 'NOPO',
    ACC_PURPOSE: 'NOPO',
    SOURCE_OF_INCOME: 'CENB',
    FIN_INFO: 500000,
    TRADE_NO: 'RC-2026-0016',
    ...corp,
  },
});

describe('Task 4 - reference lists integration (empty DB -> seed -> REIS V1.4 payload)', () => {
  let ds: DataSource;
  let mappingRepo: TypeOrmReferenceMappingRepository;
  let server: FakeReisServer;
  let workflow: KycWorkflow;

  const mappingRows = async () =>
    (await ds.query(
      'SELECT mapping_type AS t, flexcube_value AS v, reis_value AS r, active AS a FROM reference_mapping',
    )) as { t: string; v: string; r: string; a: number }[];
  const onboardingBodies = () =>
    server.requestsTo(ONBOARDING).map((q) => q.json as Record<string, unknown>);
  const submit = (req: FlexcubeCustomerRequest): Promise<KycSubmissionResult> =>
    workflow.submit(req);

  beforeAll(async () => {
    // Scenario 1: a brand-new, EMPTY database (no tables at all).
    ds = new DataSource(buildDataSourceOptions({ type: 'sqlite', sqlitePath: ':memory:' }, 'test'));
    await ds.initialize();
    const before = (await ds.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )) as { name: string }[];
    expect(before).toEqual([]);
    await ds.runMigrations({ transaction: 'all' });
    mappingRepo = new TypeOrmReferenceMappingRepository(ds);
    await seedReferenceMappings(mappingRepo);

    server = new FakeReisServer();
    await server.start();
    const config = Object.defineProperty(
      {
        baseUrl: server.baseUrl,
        tenant: 'public',
        userName: 'synthetic-user',
        timeoutMs: 2000,
        systemName: 'Flexcube',
      } as ReisConfig,
      'password',
      { value: PASSWORD, enumerable: false },
    );
    const transport = new ReisHttpTransport(new HttpService(axios.create()), config);
    const mappings = new ReferenceMappingService(mappingRepo);
    workflow = new KycWorkflow(
      new FlexcubeToCanonicalMapper(
        new StrictIsoFlexcubeDateNormalizer(),
        new YesNoResidentParser(),
      ),
      new CanonicalToReisTransformer(
        mappings,
        new SingleSelectionSourceOfIncomeStrategy(mappings),
        config,
      ),
      new TypeOrmKycCaseRepository(ds),
      new ReisOnboardingClient(new ReisAuthClient(transport, config), transport),
      new MockFlexcubeStatusUpdater(),
    );
  });

  afterAll(async () => {
    await server.stop();
    await ds.destroy();
  });

  beforeEach(() => {
    server.requests.length = 0;
    server.onboardingHandler = (req, tokens) =>
      tokens.includes(String(req.headers['x-auth-token']))
        ? { status: 200, body: { status: 'CLEAN', riskCalculationId: 1, reisId: 'R-1' } }
        : { status: 401, body: {} };
  });

  describe('1. empty database', () => {
    it('creates every table and loads the 414 agreed codes', async () => {
      const tables = (
        (await ds.query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'migrations' ORDER BY name",
        )) as { name: string }[]
      ).map((t) => t.name);
      expect(tables).toEqual([
        'kyc_case',
        'kyc_resume_attempt',
        'kyc_resume_event',
        'kyc_resume_reservation',
        'reference_mapping',
        'webhook_event',
      ]);
      const rows = await mappingRows();
      expect(rows).toHaveLength(414);
      expect(rows.every((r) => r.a === 1 && r.r === r.v)).toBe(true);
      const byType = rows.reduce<Record<string, number>>(
        (acc, r) => ({ ...acc, [r.t]: (acc[r.t] ?? 0) + 1 }),
        {},
      );
      expect(byType).toEqual({
        NATIONALITY: 247,
        PROFESSION: 7,
        ACCOUNT_PURPOSE_INDIVIDUAL: 7,
        ACCOUNT_PURPOSE_CORPORATE: 5,
        PRODUCT: 117,
        LEGAL_ENTITY: 8,
        ACTIVITY: 5,
        DISTRIBUTION_CHANNEL: 7,
        SOURCE_OF_INCOME: 10,
        DOCUMENT_TYPE: 1,
      });
    });
  });

  describe('2. running mappings:seed again', () => {
    it('creates no duplicate codes and keeps every row identical', async () => {
      const before = await mappingRows();
      await seedReferenceMappings(mappingRepo);
      await seedReferenceMappings(mappingRepo);
      const after = await mappingRows();
      expect(after).toHaveLength(414);
      const keys = after.map((r) => `${r.t}|${r.v}`);
      expect(new Set(keys).size).toBe(keys.length);
      const sort = (x: typeof before) =>
        [...x].sort((a, b) => `${a.t}${a.v}`.localeCompare(`${b.t}${b.v}`));
      expect(sort(after)).toEqual(sort(before));
      expect(agreedReferenceMappings()).toHaveLength(414);
    });

    it('uniqueness is per list: the same code in two lists is two rows, never one', async () => {
      const rows = await mappingRows();
      const inBoth = ['COMM', 'PUEN', 'SERV', 'NOPO', 'PRIS'];
      for (const code of inBoth) {
        expect(
          rows
            .filter((r) => r.v === code)
            .map((r) => r.t)
            .sort(),
        ).toEqual(['ACCOUNT_PURPOSE_CORPORATE', 'ACTIVITY']);
      }
      // COMP appears in three different lists with three different meanings.
      expect(
        rows
          .filter((r) => r.v === 'COMP')
          .map((r) => r.t)
          .sort(),
      ).toEqual(['ACCOUNT_PURPOSE_INDIVIDUAL', 'PRODUCT', 'SOURCE_OF_INCOME']);
      // The database itself refuses a duplicate (type, code).
      await expect(
        ds.query(
          "INSERT INTO reference_mapping (mapping_type, flexcube_value, reis_value, active) VALUES ('PROFESSION', 'PRSE', 'PRSE', 1)",
        ),
      ).rejects.toThrow(/UNIQUE/);
    });

    it('keeps a code an administrator switched off, unless --reactivate is explicit', async () => {
      await mappingRepo.setActive('PROFESSION' as never, 'BANE', false);
      const s = await seedReferenceMappings(mappingRepo);
      expect(s).toMatchObject({ total: 414, inserted: 0, updated: 414, keptInactive: 1 });
      expect((await mappingRepo.find('PROFESSION' as never, 'BANE'))?.active).toBe(false);
      const blocked = await submit(individualReq('KYC-T4-OFF', {}, { PROFESSION: 'BANE' }));
      expect(blocked).toMatchObject({ outcome: 'FAILED', code: 'UNMAPPED_REFERENCE' });
      expect(server.requests).toHaveLength(0);

      await seedReferenceMappings(mappingRepo, undefined, { reactivate: true });
      expect((await mappingRepo.find('PROFESSION' as never, 'BANE'))?.active).toBe(true);
    });
  });

  describe('3. valid individual customer', () => {
    it('produces exactly the V1.4 formId 1 payload', async () => {
      const r = await submit(individualReq('KYC-T4-IND'));
      expect(r.outcome).toBe('ONBOARDED');
      const [body] = onboardingBodies();
      expect(Object.keys(body).sort()).toEqual([
        'formId',
        'items',
        'relations',
        'systemId',
        'systemName',
      ]);
      expect(body).toMatchObject({ systemName: 'Flexcube', systemId: 'KYC-T4-IND', formId: 1 });
      expect(body.relations).toEqual([]);
      const items = body.items as Record<string, unknown>;
      expect(Object.keys(items).sort()).toEqual(V14_INDIVIDUAL_KEYS);
      expect(items).toEqual({
        entity_type: 'PP',
        first_name: 'Synthetic',
        last_name: 'Person',
        birth_place: 'Tripoli',
        cus_birth_date: '1985-03-15',
        tin: 'PASS',
        nid: 'P10000001',
        expiry_date: '2030-01-09',
        account_manager_login: 'account_manager',
        account_manager_email: 'KYC@aiib.ly',
        pep: false,
        relation_pep: false,
        nationality_customer: 'LY',
        nationality: 'LY',
        citizenship_customer: 'LY',
        citizenship: 'LY',
        profession: 'PRSE',
        account_purpose_individual: 'JOBS',
        resident: '1',
        distribution_channel: '00',
        product: ['SALR'],
        source_income_individual: 'BUSN',
        m_income: 3000,
      });
      // V1.4 types: booleans, numeric income, product array, "1"/"2" resident, no issue_date.
      expect(items).not.toHaveProperty('issue_date');
      expect(typeof items.pep).toBe('boolean');
      expect(typeof items.m_income).toBe('number');
      expect(Array.isArray(items.product)).toBe(true);
    });

    it('sends several products as an array in FLEXCUBE order and a non-resident as "2"', async () => {
      await submit(
        individualReq(
          'KYC-T4-IND2',
          { PRODUCT_CODES: ['SALR', 'ATMC', 'MASB'] },
          { RESIDENT: 'N' },
        ),
      );
      const items = onboardingBodies()[0].items as Record<string, unknown>;
      expect(items.product).toEqual(['SALR', 'ATMC', 'MASB']);
      expect(items.resident).toBe('2');
    });
  });

  describe('4. corporate customer with agreed values', () => {
    it('translates every corporate reference field (formId 2, V1.4)', async () => {
      const r = await submit(corporateReq('KYC-T4-CORP'));
      expect(r.outcome).toBe('ONBOARDED');
      const [body] = onboardingBodies();
      expect(body).toMatchObject({ systemId: 'KYC-T4-CORP', formId: 2, relations: [] });
      const items = body.items as Record<string, unknown>;
      expect(Object.keys(items).sort()).toEqual(V14_CORPORATE_KEYS);
      expect(items).toEqual({
        entity_type: 'PM',
        business_name: 'SYNTHETIC FX SERVICES',
        trade_no: 'RC-2026-0016',
        account_manager_login: 'account_manager',
        account_manager_email: 'KYC@aiib.ly',
        pep: false,
        incorp_country: 'DZ',
        nationality: 'DZ',
        operation_country: ['DZ', 'LB'],
        legal_entity: 'NNPFT',
        activity: 'NOPO',
        account_purpose_organization: 'NOPO',
        source_income_organization: 'CENB',
        distribution_channel: '04',
        product: ['FX01', 'LC01'],
        fin_info: 500000,
      });
    });

    it.each(['FRNGC', 'GOVEN', 'LIMCO', 'NNPFT', 'PARTN', 'PRICO', 'PUBCO', 'SOLEP'])(
      'accepts the agreed legal entity %s',
      async (code) => {
        const r = await submit(corporateReq(`KYC-T4-LE-${code}`, { LEGAL_ENTITY: code }));
        expect(r.outcome).toBe('ONBOARDED');
      },
    );
  });

  describe('5. old / unknown codes are rejected before REIS is called', () => {
    it.each([
      ['profession EMPL (V1.2)', individualReq('KYC-T4-OLD1', {}, { PROFESSION: 'EMPL' })],
      ['account purpose CURSTF', individualReq('KYC-T4-OLD2', {}, { ACC_PURPOSE: 'CURSTF' })],
      ['distribution channel "1"', individualReq('KYC-T4-OLD3', { DISTRIBUTION_CHANNEL: '1' })],
      ['account class as product', individualReq('KYC-T4-OLD4', { PRODUCT_CODES: ['CURPAL'] })],
      ['deactivated country EU', individualReq('KYC-T4-OLD5', {}, { NATIONALITY: 'EU' })],
      ['lower-case code', individualReq('KYC-T4-OLD6', {}, { PROFESSION: 'prse' })],
      ['old corporate purpose 203', corporateReq('KYC-T4-OLD7', { ACC_PURPOSE: '203' })],
      ['old corporate purpose 236', corporateReq('KYC-T4-OLD8', { ACC_PURPOSE: '236' })],
      ['country with spaces', corporateReq('KYC-T4-OLD9', { OPERATION_COUNTRY: ['LY', ' TN'] })],
    ])('%s', async (_name, request) => {
      const r = await submit(request);
      expect(r).toMatchObject({
        outcome: 'FAILED',
        stage: 'VALIDATION',
        code: 'UNMAPPED_REFERENCE',
        requestMayHaveReachedReis: false,
      });
      expect(server.requests).toHaveLength(0); // not even authenticate
    });
  });

  describe('6. sending the customer', () => {
    it('makes one authentication and exactly one correct onboarding request', async () => {
      await submit(individualReq('KYC-T4-SEND'));
      expect(server.requestsTo(AUTH)).toHaveLength(1);
      const calls = server.requestsTo(ONBOARDING);
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call.method).toBe('POST');
      expect(call.headers['x-auth-tenant']).toBe('public');
      expect(typeof call.headers['x-auth-token']).toBe('string');
      expect(call.headers).not.toHaveProperty('authorization');
      expect(String(call.headers['content-type'])).toMatch(/application\/json/);
      expect((call.json as { systemId: string }).systemId).toBe('KYC-T4-SEND');
    });

    it('never sends the same KYC twice', async () => {
      await submit(individualReq('KYC-T4-ONCE'));
      const again = await submit(individualReq('KYC-T4-ONCE'));
      expect(again.outcome).toBe('DUPLICATE');
      expect(server.requestsTo(ONBOARDING)).toHaveLength(1);
    });
  });
});
