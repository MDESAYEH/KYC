import { HttpService } from '@nestjs/axios';
import axios from 'axios';
import { DataSource } from 'typeorm';
import { FlexcubeSyncService } from '../src/flexcube-sync/flexcube-sync.service';
import { StrictIsoFlexcubeDateNormalizer } from '../src/flexcube/flexcube-date-normalizer';
import { YesNoResidentParser } from '../src/flexcube/flexcube-resident-parser';
import { FlexcubeToCanonicalMapper } from '../src/flexcube/flexcube-to-canonical.mapper';
import { MockFlexcubeStatusUpdater } from '../src/flexcube/mock-flexcube-status-updater';
import { FlexcubeKycSource } from '../src/flexcube/source/flexcube-kyc-source';
import { SqlRow } from '../src/flexcube/staging/flexcube-staging';
import { StagingSubmissionRepository } from '../src/flexcube/staging/staging-submission.repository';
import { KycWorkflow } from '../src/kyc/kyc.workflow';
import { SingleSelectionSourceOfIncomeStrategy } from '../src/mapping/single-source-of-income.strategy';
import { TypeOrmKycCaseRepository } from '../src/persistence/typeorm-kyc-case.repository';
import { CanonicalToReisTransformer } from '../src/reis/canonical-to-reis.transformer';
import { ReisAuthClient } from '../src/reis/reis-auth.client';
import { ReisOnboardingClient } from '../src/reis/reis-onboarding.client';
import { ReisConfig } from '../src/reis/reis.config';
import { ReisHttpTransport } from '../src/reis/transport/reis-http.transport';
import { FakeFlexcubeKycDb } from './support/fake-flexcube-kyc-db';
import { FakeReisServer } from './support/fake-reis-server';
import { seededMappings } from './support/in-memory-reference-mappings';
import { createTestDataSource } from './support/test-database';

/**
 * Corporate KYC with key persons, end to end and without a local .env: fake FLEXCUBE (STTM rows +
 * staging table) -> real poller / source / mapper / transformer / workflow -> fake REIS server.
 * Synthetic data only.
 */
const ONBOARDING = '/onboarding/v2/searchOnboardCustomer';

const CORPORATE_ROW: SqlRow = {
  CRP_BUSINESS_NAME: 'Test trading business',
  PARENT_CMPNY_COUNTRY: 'T-INC',
  LEGAL_ENTITY: 'T-LEGAL',
  ACTIVITY: 'T-ACT',
  ACC_PURPOSE: 'T-APCORP',
  FUNDS_SOURCE: 'T-CORP-INC',
  ANNUAL_TURNOVER: 250000,
  TRADE_LICENCE_NO: 'TL-1',
  PEP: 'N',
  ACCOUNT_MANAGER_LOGIN: 'amgr',
  ACCOUNT_MANAGER_EMAIL: 'amgr@example.test',
  DISTRIBUTION_CHANNEL: 'T-CHAN',
};

const KEY_PERSON_I: SqlRow = {
  KYC_ID: 'P1',
  NAME: 'Synthetic Arabic Name',
  KYC_KEYPERSON_TYPE: 'I',
  RELATIONSHIP: 'CEO',
  DATE_OF_BIRTH: new Date(1980, 4, 6),
  NATIONALITY: 'T-REL-NAT',
  ADDRESS_COUNTRY: 'T-REL-CIT',
  PLACE_OF_BIRTH: 'Testville',
  TIN: null,
  CUSTOM_KYC_REF_NO: 'KYC-C1',
  FIRST_NAME: 'Relfirst',
  LAST_NAME: 'Rellast',
  PASSPORT_NUMBER: 'PX1',
  PASSPORT_ISSUE_DATE: new Date(2020, 0, 2),
  PASSPORT_EXPIRY_DATE: new Date(2030, 0, 1),
  PLACE_OF_ISSUE: 'Testburg',
  NATIONAL_ID: 'NAT-1',
};

const KEY_PERSON_C: SqlRow = {
  KYC_ID: 'C1',
  NAME: 'Sub Co',
  KYC_KEYPERSON_TYPE: 'C',
  RELATIONSHIP: 'OWNER',
  DATE_OF_BIRTH: null,
  NATIONALITY: null,
  ADDRESS_COUNTRY: 'T-REL-NAT',
  PLACE_OF_BIRTH: null,
  TIN: 'TRD-9',
  CUSTOM_KYC_REF_NO: null,
  FIRST_NAME: null,
  LAST_NAME: null,
  PASSPORT_NUMBER: null,
  PASSPORT_ISSUE_DATE: null,
  PASSPORT_EXPIRY_DATE: null,
  PLACE_OF_ISSUE: null,
  NATIONAL_ID: null,
};

describe('FLEXCUBE poller -> REIS: corporate KYC with key persons', () => {
  let ds: DataSource;
  let server: FakeReisServer;
  let db: FakeFlexcubeKycDb;
  let sync: FlexcubeSyncService;

  beforeEach(async () => {
    ds = await createTestDataSource();
    server = new FakeReisServer();
    await server.start();
    const mappings = await seededMappings();
    const config = Object.defineProperty(
      {
        baseUrl: server.baseUrl,
        tenant: 'test-tenant',
        userName: 'synthetic-user',
        timeoutMs: 2000,
        systemName: 'Flexcube',
      } as ReisConfig,
      'password',
      { value: 'synthetic-password-123', enumerable: false },
    );
    const transport = new ReisHttpTransport(new HttpService(axios.create()), config);
    const workflow = new KycWorkflow(
      new FlexcubeToCanonicalMapper(
        new StrictIsoFlexcubeDateNormalizer(),
        new YesNoResidentParser(),
      ),
      new CanonicalToReisTransformer(
        mappings.service,
        new SingleSelectionSourceOfIncomeStrategy(mappings.service),
        config,
      ),
      new TypeOrmKycCaseRepository(ds),
      new ReisOnboardingClient(new ReisAuthClient(transport, config), transport),
      new MockFlexcubeStatusUpdater(),
    );
    db = new FakeFlexcubeKycDb();
    db.master = [{ KYC_REF_NO: 'KYC-C1', KYC_CUST_TYPE: 'C', MOD_NO: 1, AUTH_STAT: 'A' }];
    db.details.set('KYC-C1', CORPORATE_ROW);
    db.products.set('KYC-C1', ['T-PROD']);
    db.countries.set('KYC-C1', ['T-OP1', 'T-OP2']);
    db.keyPersons.set('KYC-C1', [KEY_PERSON_I, KEY_PERSON_C]);
    sync = new FlexcubeSyncService(
      new FlexcubeKycSource(db, 'STTM_KYC_REIS_PAYLOAD_CUSTOM', '2026-11-16'),
      new StagingSubmissionRepository(db, 'STTM_KYC_REIS_PAYLOAD_CUSTOM'),
      workflow,
      20,
    );
  });
  afterEach(async () => {
    await server.stop();
    await ds.destroy();
  });

  it('sends the company and both related parties in one REIS call (V1.5 formId 3 / 4)', async () => {
    server.onboardingHandler = () => ({ status: 200, body: { status: 'PENDING' } });
    expect(await sync.runOnce()).toEqual({ found: 1, sent: 1, failed: 0, skipped: 0 });

    const calls = server.requestsTo(ONBOARDING);
    expect(calls).toHaveLength(1);
    expect(calls[0].json).toEqual({
      systemName: 'Flexcube',
      systemId: 'KYC-C1',
      formId: 2,
      items: {
        entity_type: 'PM',
        business_name: 'Test trading business',
        account_manager_login: 'amgr',
        account_manager_email: 'amgr@example.test',
        pep: false,
        incorp_country: 'R-INC',
        nationality: 'R-INC',
        operation_country: ['R-OP1', 'R-OP2'],
        legal_entity: 'R-LEGAL',
        activity: 'R-ACT',
        account_purpose_organization: 'R-APCORP',
        source_income_organization: 'R-CORP-INC',
        distribution_channel: 'R-CHAN',
        product: ['R-PROD'],
        fin_info: 250000,
        trade_no: 'TL-1',
      },
      relations: [
        {
          formId: 3,
          items: {
            entity_type: 'PP',
            first_name: 'Relfirst',
            last_name: 'Rellast',
            cus_birth_date: '1980-05-06',
            nationality: 'R-REL-NAT',
            citizenship: 'R-REL-CIT',
            nid: 'PX1',
            tin: 'PASS',
            issue_date: '2020-01-02',
            valid_until: '2030-01-01',
            national_id: 'NAT-1',
            birth_place: 'Testville',
            issue_place: 'Testburg',
          },
          relationshipId: 3,
          systemName: 'Flexcube',
          systemId: 'KYC-C1-P1',
        },
        {
          formId: 4,
          items: {
            entity_type: 'PM',
            business_name: 'Sub Co',
            nationality: 'R-REL-NAT',
            trade_no: 'TRD-9',
          },
          relationshipId: 7,
          systemName: 'Flexcube',
          systemId: 'KYC-C1-C1',
        },
      ],
    });
    expect(db.staging).toEqual([
      expect.objectContaining({ KYC_REF_NO: 'KYC-C1', SEQ_NO: 1, PROCESS_STATUS: 'S' }),
    ]);
    expect(JSON.parse(db.staging[0].REQUEST!)).toEqual(calls[0].json);
    // read-only on the STTM tables: only SELECTs, INSERT / UPDATE on the staging table
    expect(db.statements.filter((s) => /DELETE/i.test(s))).toEqual([]);
  });

  it('rejects a key person with a relationship not allowed for a company before calling REIS', async () => {
    db.keyPersons.set('KYC-C1', [{ ...KEY_PERSON_C, RELATIONSHIP: 'CEO' }]);
    expect(await sync.runOnce()).toMatchObject({ found: 1, sent: 0, failed: 1 });
    expect(server.requests).toHaveLength(0);
    expect(db.staging[0]).toMatchObject({ PROCESS_STATUS: 'E', REQUEST: null });
    expect(db.staging[0].RESPONSE).toContain('VALIDATION');
    // field names only: no customer data in the staging response
    expect(db.staging[0].RESPONSE).not.toMatch(/Sub Co|CEO|KYC-C1/);
  });

  it('rejects a key person whose CUSTOM row is missing before calling REIS', async () => {
    db.keyPersons.set('KYC-C1', [{ ...KEY_PERSON_I, CUSTOM_KYC_REF_NO: null, FIRST_NAME: null }]);
    expect(await sync.runOnce()).toMatchObject({ failed: 1, sent: 0 });
    expect(server.requests).toHaveLength(0);
    expect(db.staging[0].PROCESS_STATUS).toBe('E');
  });

  it('rejects the whole request when two key persons share a systemId or KYC_ID is blank', async () => {
    db.keyPersons.set('KYC-C1', [KEY_PERSON_I, { ...KEY_PERSON_C, KYC_ID: ' P1 ' }]);
    expect(await sync.runOnce()).toMatchObject({ failed: 1, sent: 0 });
    expect(server.requests).toHaveLength(0);

    db.master = [{ KYC_REF_NO: 'KYC-C1', KYC_CUST_TYPE: 'C', MOD_NO: 2, AUTH_STAT: 'A' }];
    db.keyPersons.set('KYC-C1', [{ ...KEY_PERSON_I, KYC_ID: '  ' }]);
    expect(await sync.runOnce()).toMatchObject({ failed: 1, sent: 0 });
    expect(server.requests).toHaveLength(0);
  });
});
