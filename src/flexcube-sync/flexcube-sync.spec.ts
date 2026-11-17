import { loadConfiguration } from '../config/configuration';
import { Logger } from '@nestjs/common';
import {
  FlexcubeKycSource,
  normalizeSyncStartDate,
  oracleDate,
  PendingKyc,
} from '../flexcube/source/flexcube-kyc-source';
import { SqlRow } from '../flexcube/staging/flexcube-staging';
import {
  StagingProcessStatus,
  StagingSubmissionRepository,
} from '../flexcube/staging/staging-submission.repository';
import { FakeFlexcubeDb } from '../../test/support/fake-flexcube-db';
import { INDIVIDUAL_ROW, onboarded, SINCE } from '../../test/support/sync-fixtures';
import { IKycWorkflow } from '../kyc/kyc.interfaces';
import { createFlexcubeSync, FlexcubeSyncConfigError } from './flexcube-sync.module';
import { FlexcubeSyncScheduler } from './flexcube-sync.scheduler';
import { FlexcubeSyncService } from './flexcube-sync.service';

describe('FlexcubeKycSource (provisional STTM queries)', () => {
  let db: FakeFlexcubeDb;
  let source: FlexcubeKycSource;
  beforeEach(async () => {
    db = new FakeFlexcubeDb();
    source = new FlexcubeKycSource(db, 'STTM_KYC_REIS_PAYLOAD_CUSTOM', SINCE);
    await source.refreshCorporateSupport();
  });

  it('finds open KYCs of any AUTH_STAT whose current MOD_NO has no staging row', async () => {
    db.master = [
      { KYC_REF_NO: 'K1', KYC_CUST_TYPE: 'R', MOD_NO: 1, AUTH_STAT: 'U' },
      { KYC_REF_NO: 'K2', KYC_CUST_TYPE: 'C', MOD_NO: 3, AUTH_STAT: 'U' },
      // already authorized (FLEXCUBE no longer blocks authorization): still selected
      { KYC_REF_NO: 'K3', KYC_CUST_TYPE: 'R', MOD_NO: 1, AUTH_STAT: 'A' },
      { KYC_REF_NO: 'K4', KYC_CUST_TYPE: 'R', MOD_NO: 1, AUTH_STAT: 'U', RECORD_STAT: 'C' },
      { KYC_REF_NO: 'K5', KYC_CUST_TYPE: 'X', MOD_NO: 1, AUTH_STAT: 'U' },
    ];
    expect(await source.findPending(10)).toEqual([
      { kycRefNo: 'K1', seqNo: 1, customerType: 'INDIVIDUAL' },
      { kycRefNo: 'K2', seqNo: 3, customerType: 'CORPORATE' },
      { kycRefNo: 'K3', seqNo: 1, customerType: 'INDIVIDUAL' },
    ]);
  });

  it('does not filter on AUTH_STAT and applies the cut-off as a bind variable', async () => {
    db.master = [
      {
        KYC_REF_NO: 'OLD',
        KYC_CUST_TYPE: 'R',
        MOD_NO: 1,
        AUTH_STAT: 'A',
        MAKER_DT_STAMP: '2026-11-15T23:59:59',
      },
      {
        KYC_REF_NO: 'NEW',
        KYC_CUST_TYPE: 'R',
        MOD_NO: 1,
        AUTH_STAT: 'A',
        MAKER_DT_STAMP: '2026-11-16T00:00:00',
      },
    ];
    expect((await source.findPending(7)).map((p) => p.kycRefNo)).toEqual(['NEW']);
    const { sql, binds } = db.pendingCalls[0];
    expect(sql).not.toContain('AUTH_STAT');
    expect(sql).toContain("m.RECORD_STAT = 'O'");
    expect(sql).toContain('m.MAKER_DT_STAMP >= TO_DATE(:since');
    expect(sql).not.toContain(SINCE);
    expect(binds).toEqual({ since: '2026-11-16T00:00:00', maxRows: 7 });
  });

  it('normalizes and validates the cut-off', () => {
    expect(normalizeSyncStartDate('2026-11-16')).toBe('2026-11-16T00:00:00');
    expect(normalizeSyncStartDate(' 2026-11-16T08:30 ')).toBe('2026-11-16T08:30:00');
    expect(normalizeSyncStartDate('2026-11-16T08:30:15')).toBe('2026-11-16T08:30:15');
    for (const bad of [
      undefined,
      '',
      'yesterday',
      '2026-02-30',
      '2026-11-16T25:00',
      '2026-11-16T08:00:00Z',
      '16/11/2026',
    ]) {
      expect(normalizeSyncStartDate(bad)).toBeUndefined();
    }
    expect(() => new FlexcubeKycSource(db, 'STAGE', 'nope')).toThrow('FLEXCUBE_SYNC_START_DATE');
  });

  it('builds the FLEXCUBE individual request from the STTM rows (dates as YYYY-MM-DD)', async () => {
    db.details.set('K1', INDIVIDUAL_ROW);
    db.products.set('K1', ['SALR', 'ATMC']);
    const r = await source.load({ kycRefNo: 'K1', seqNo: 1, customerType: 'INDIVIDUAL' });
    expect(r).toMatchObject({
      KYC_REF_NO: 'K1',
      CUSTOMER_TYPE: 'INDIVIDUAL',
      PEP: 'N',
      PRODUCT_CODES: ['SALR', 'ATMC'],
      DISTRIBUTION_CHANNEL: '00',
      individual: {
        FIRST_NAME: 'Testfirst',
        BIRTH_DATE: '1990-01-31',
        NID: 'P123',
        EXPIRY_DATE: '2030-12-01',
        CITIZENSHIP: 'LY',
        PROFESSION: 'PRSE',
        FUND_SOURCE: 'BUSN',
        MONTHLY_INCOME: 3000,
      },
    });
    expect(r.individual?.BIRTH_PLACE).toBeUndefined();
  });

  it('builds the corporate request with every product and operation country', async () => {
    db.details.set('K2', {
      CRP_BUSINESS_NAME: 'Test Co',
      PARENT_CMPNY_COUNTRY: 'LY',
      LEGAL_ENTITY: 'LIMCO',
      ACTIVITY: 'COMM',
      ACC_PURPOSE: 'COMM',
      FUNDS_SOURCE: 'CCMP',
      ANNUAL_TURNOVER: 500000,
      TRADE_LICENCE_NO: ' ',
      PEP: 'N',
      ACCOUNT_MANAGER_LOGIN: 'amgr',
      ACCOUNT_MANAGER_EMAIL: 'amgr@example.test',
      DISTRIBUTION_CHANNEL: '00',
    });
    db.products.set('K2', ['AFIC']);
    db.countries.set('K2', ['LY', 'TN']);
    const r = await source.load({ kycRefNo: 'K2', seqNo: 1, customerType: 'CORPORATE' });
    expect(r.corporate).toMatchObject({
      CRP_BUSINESS_NAME: 'Test Co',
      OPERATION_COUNTRY: ['LY', 'TN'],
      SOURCE_OF_INCOME: 'CCMP',
      FIN_INFO: 500000,
    });
    expect(r.corporate?.TRADE_NO).toBeUndefined();
  });

  describe('corporate key persons (related parties)', () => {
    const CORPORATE_ROW: SqlRow = {
      CRP_BUSINESS_NAME: 'Test Co',
      PARENT_CMPNY_COUNTRY: 'LY',
      LEGAL_ENTITY: 'LIMCO',
      ACTIVITY: 'COMM',
      ACC_PURPOSE: 'COMM',
      FUNDS_SOURCE: 'CCMP',
      ANNUAL_TURNOVER: 500000,
      PEP: 'N',
      ACCOUNT_MANAGER_LOGIN: 'amgr',
      ACCOUNT_MANAGER_EMAIL: 'amgr@example.test',
      DISTRIBUTION_CHANNEL: '00',
    };
    const KEY_I: SqlRow = {
      KYC_ID: ' P1 ',
      NAME: 'Synthetic Arabic Name',
      KYC_KEYPERSON_TYPE: 'I',
      RELATIONSHIP: 'CEO',
      DATE_OF_BIRTH: new Date(1980, 4, 6),
      NATIONALITY: 'LY',
      ADDRESS_COUNTRY: 'LY',
      PLACE_OF_BIRTH: 'Testville',
      TIN: null,
      CUSTOM_KYC_REF_NO: 'K2',
      FIRST_NAME: ' Relfirst ',
      LAST_NAME: 'Rellast',
      PASSPORT_NUMBER: 'PX1',
      PASSPORT_ISSUE_DATE: new Date(2020, 0, 2),
      PASSPORT_EXPIRY_DATE: new Date(2030, 0, 1),
      PLACE_OF_ISSUE: null,
      NATIONAL_ID: '',
    };
    const KEY_C: SqlRow = {
      KYC_ID: 'C1',
      NAME: 'Sub Co',
      KYC_KEYPERSON_TYPE: 'C',
      RELATIONSHIP: 'OWNER',
      DATE_OF_BIRTH: null,
      NATIONALITY: null,
      ADDRESS_COUNTRY: 'TN',
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
    const load = () => source.load({ kycRefNo: 'K2', seqNo: 1, customerType: 'CORPORATE' });
    beforeEach(() => {
      db.details.set('K2', CORPORATE_ROW);
      db.products.set('K2', ['AFIC']);
      db.countries.set('K2', ['LY']);
    });

    it('reads individual (I) and company (C) key persons as raw values', async () => {
      db.keyPersons.set('K2', [KEY_I, KEY_C]);
      const r = await load();
      expect(r.corporate?.RELATED_PARTIES).toEqual([
        {
          KYC_ID: 'P1',
          NAME: 'Synthetic Arabic Name',
          KYC_KEYPERSON_TYPE: 'I',
          RELATIONSHIP: 'CEO',
          DATE_OF_BIRTH: '1980-05-06',
          NATIONALITY: 'LY',
          ADDRESS_COUNTRY: 'LY',
          PLACE_OF_BIRTH: 'Testville',
          TIN: undefined,
          HAS_CUSTOM_ROW: true,
          FIRST_NAME: 'Relfirst',
          LAST_NAME: 'Rellast',
          PASSPORT_NUMBER: 'PX1',
          PASSPORT_ISSUE_DATE: '2020-01-02',
          PASSPORT_EXPIRY_DATE: '2030-01-01',
          PLACE_OF_ISSUE: undefined,
          NATIONAL_ID: undefined,
        },
        expect.objectContaining({
          KYC_ID: 'C1',
          KYC_KEYPERSON_TYPE: 'C',
          RELATIONSHIP: 'OWNER',
          ADDRESS_COUNTRY: 'TN',
          TIN: 'TRD-9',
          HAS_CUSTOM_ROW: false,
        }),
      ]);
    });

    it('uses a read-only SELECT with a bind variable, LEFT JOINed on KYC_REF_NO + KYC_ID + NAME', async () => {
      db.keyPersons.set('K2', [KEY_I]);
      await load();
      const call = db.allSql.find((c) => c.sql.includes('STTM_KYC_CORP_KEYPERSONS'))!;
      expect(call.sql.trim()).toMatch(/^SELECT/);
      expect(call.sql).toContain('LEFT JOIN STTM_KYC_CORP_KEYPERSONS_CUSTOM');
      expect(call.sql).toContain(
        'cu.KYC_REF_NO = k.KYC_REF_NO AND cu.KYC_ID = k.KYC_ID AND cu.NAME = k.NAME',
      );
      expect(call.sql).toContain('k.KYC_REF_NO = :kycRefNo');
      expect(call.sql).not.toContain("'K2'");
      expect(call.binds).toEqual({ kycRefNo: 'K2' });
      expect(db.allSql.every((c) => /^\s*SELECT/i.test(c.sql))).toBe(true);
    });

    it('reads the key-person type from the configured column, aliased back to KYC_KEYPERSON_TYPE', async () => {
      const custom = new FlexcubeKycSource(db, 'STAGE', SINCE, 'OWNERSHIP_TYPE');
      db.keyPersons.set('K2', [KEY_I]);
      const r = await custom.load({ kycRefNo: 'K2', seqNo: 1, customerType: 'CORPORATE' });
      const sql = db.allSql.find((c) => c.sql.includes('STTM_KYC_CORP_KEYPERSONS'))!.sql;
      expect(sql).toContain('k.OWNERSHIP_TYPE AS KYC_KEYPERSON_TYPE');
      expect(sql).not.toContain('k.KYC_KEYPERSON_TYPE');
      expect(r.corporate?.RELATED_PARTIES?.[0]).toMatchObject({ KYC_KEYPERSON_TYPE: 'I' });
    });

    it('defaults to the KYC_KEYPERSON_TYPE column', async () => {
      db.keyPersons.set('K2', [KEY_I]);
      await load();
      const sql = db.allSql.find((c) => c.sql.includes('STTM_KYC_CORP_KEYPERSONS'))!.sql;
      expect(sql).toContain('k.KYC_KEYPERSON_TYPE AS KYC_KEYPERSON_TYPE');
    });

    it('rejects an unsafe key-person type column name', () => {
      for (const bad of ['', 'A;DROP TABLE X', 'A B', '1X', 'X"', "X'", 'X--', 'K.X']) {
        expect(() => new FlexcubeKycSource(db, 'STAGE', SINCE, bad)).toThrow(
          /FLEXCUBE_KEYPERSON_TYPE_COLUMN/,
        );
      }
    });

    it('has no related parties when the company has no key persons', async () => {
      expect((await load()).corporate?.RELATED_PARTIES).toEqual([]);
    });

    it('does not read key persons for an individual', async () => {
      db.details.set('K1', INDIVIDUAL_ROW);
      await source.load({ kycRefNo: 'K1', seqNo: 1, customerType: 'INDIVIDUAL' });
      expect(db.allSql.some((c) => c.sql.includes('KEYPERSONS'))).toBe(false);
    });
  });

  it('fails clearly when the detail row is missing', async () => {
    await expect(
      source.load({ kycRefNo: 'NOPE', seqNo: 1, customerType: 'INDIVIDUAL' }),
    ).rejects.toThrow('KYC details not found');
  });

  it('formats Oracle dates without time-zone shifts', () => {
    expect(oracleDate(new Date(2024, 1, 29, 23, 59))).toBe('2024-02-29');
    expect(oracleDate(null)).toBeUndefined();
  });
});

describe('FlexcubeSyncService (one polling pass)', () => {
  let db: FakeFlexcubeDb;
  let workflow: { submit: jest.Mock };
  let sync: FlexcubeSyncService;

  beforeEach(() => {
    db = new FakeFlexcubeDb();
    db.master = [{ KYC_REF_NO: 'K1', KYC_CUST_TYPE: 'R', MOD_NO: 2, AUTH_STAT: 'U' }];
    db.details.set('K1', INDIVIDUAL_ROW);
    db.products.set('K1', ['SALR']);
    workflow = { submit: jest.fn().mockResolvedValue(onboarded()) };
    sync = new FlexcubeSyncService(
      new FlexcubeKycSource(db, 'STAGE', SINCE),
      new StagingSubmissionRepository(db, 'STAGE'),
      workflow as unknown as IKycWorkflow,
      20,
    );
  });

  it('sends a saved KYC once with its SEQ_NO and stores S with the request / response', async () => {
    expect(await sync.runOnce()).toEqual({ found: 1, sent: 1, failed: 0, skipped: 0 });
    expect(workflow.submit).toHaveBeenCalledWith(expect.objectContaining({ KYC_REF_NO: 'K1' }), {
      seqNo: 2,
    });
    expect(db.staging).toEqual([
      expect.objectContaining({
        KYC_REF_NO: 'K1',
        SEQ_NO: 2,
        PROCESS_STATUS: StagingProcessStatus.SUCCESS,
        REQUEST: JSON.stringify({ systemId: 'X' }),
        RESPONSE: JSON.stringify({ status: 'CLEAN' }),
        RETRY_COUNT: 0,
      }),
    ]);
    expect(db.staging[0].MSGID).toMatch(/^[0-9a-f-]{36}$/);
    // Monitoring columns (Finexta): request time when claimed, response time when completed.
    expect(db.staging[0]).toMatchObject({ REQ_DATE: 'SYSDATE', RES_DATE: 'SYSDATE' });
    // Next pass: nothing left to do.
    expect(await sync.runOnce()).toEqual({ found: 0, sent: 0, failed: 0, skipped: 0 });
    expect(workflow.submit).toHaveBeenCalledTimes(1);
  });

  it('a workflow failure is stored as E with only a technical code', async () => {
    workflow.submit.mockResolvedValue({
      outcome: 'FAILED',
      stage: 'VALIDATION',
      code: 'UNMAPPED_REFERENCE',
      reisRequest: undefined,
    });
    expect(await sync.runOnce()).toMatchObject({ failed: 1 });
    expect(db.staging[0]).toMatchObject({
      PROCESS_STATUS: 'E',
      RETRY_COUNT: 1,
      REQUEST: null,
      RESPONSE: JSON.stringify({ error: 'UNMAPPED_REFERENCE', stage: 'VALIDATION' }),
    });
  });

  it('a duplicate (previous submission still open) is stored as E', async () => {
    workflow.submit.mockResolvedValue({ outcome: 'DUPLICATE', reason: 'AWAITING_FINAL_STATUS' });
    await sync.runOnce();
    expect(db.staging[0]).toMatchObject({
      PROCESS_STATUS: 'E',
      RESPONSE: JSON.stringify({ error: 'DUPLICATE', reason: 'AWAITING_FINAL_STATUS' }),
    });
  });

  it('an unexpected error is stored as E and does not stop the other KYCs', async () => {
    db.master.push({ KYC_REF_NO: 'K9', KYC_CUST_TYPE: 'R', MOD_NO: 1, AUTH_STAT: 'U' });
    db.details.set('K9', INDIVIDUAL_ROW);
    workflow.submit.mockRejectedValueOnce(new TypeError('boom'));
    expect(await sync.runOnce()).toEqual({ found: 2, sent: 1, failed: 1, skipped: 0 });
    expect(db.staging.map((r) => [r.KYC_REF_NO, r.PROCESS_STATUS])).toEqual([
      ['K1', 'E'],
      ['K9', 'S'],
    ]);
    expect(db.staging[0].RESPONSE).toBe(
      JSON.stringify({ error: 'TypeError', delivery: 'UNCERTAIN' }),
    );
  });

  it('missing KYC details end as E without calling REIS', async () => {
    db.details.clear();
    expect(await sync.runOnce()).toMatchObject({ failed: 1 });
    expect(workflow.submit).not.toHaveBeenCalled();
    expect(db.staging[0].PROCESS_STATUS).toBe('E');
  });

  it('a row already created by someone else is skipped', async () => {
    const pending: PendingKyc[] = [{ kycRefNo: 'K1', seqNo: 2, customerType: 'INDIVIDUAL' }];
    jest.spyOn(FlexcubeKycSource.prototype, 'findPending').mockResolvedValueOnce(pending);
    db.staging.push({
      KYC_REF_NO: 'K1',
      SEQ_NO: 2,
      MSGID: 'm',
      PROCESS_STATUS: 'W',
      REQUEST: null,
      RESPONSE: null,
      RETRY_COUNT: 0,
    });
    expect(await sync.runOnce()).toEqual({ found: 1, sent: 0, failed: 0, skipped: 1 });
    expect(workflow.submit).not.toHaveBeenCalled();
  });

  it('claims with the configured in-progress status, still only from N', async () => {
    const seen: unknown[] = [];
    const spy = jest.spyOn(db, 'execute');
    const custom = new FlexcubeSyncService(
      new FlexcubeKycSource(db, 'STAGE', SINCE),
      new StagingSubmissionRepository(db, 'STAGE', 'P'),
      workflow as unknown as IKycWorkflow,
      20,
    );
    expect(await custom.runOnce()).toMatchObject({ sent: 1, failed: 0 });
    for (const [sql, binds] of spy.mock.calls) {
      if (sql.includes('REQ_DATE = SYSDATE')) seen.push(binds);
    }
    expect(seen).toEqual([{ targetStatus: 'P', sourceStatus: 'N', kycRefNo: 'K1', seqNo: 2 }]);
    expect(db.staging[0].PROCESS_STATUS).toBe('S'); // completed from P, not from W
    // the default is untouched
    expect(StagingProcessStatus.IN_PROGRESS).toBe('W');
  });

  it('a row claimed by someone else (any status but N) is not claimed again', async () => {
    const repo = new StagingSubmissionRepository(db, 'STAGE', 'P');
    db.staging.push({
      KYC_REF_NO: 'KX',
      SEQ_NO: 1,
      MSGID: 'm',
      PROCESS_STATUS: 'P',
      REQUEST: null,
      RESPONSE: null,
      RETRY_COUNT: 0,
    });
    expect(await repo.claim({ kycRefNo: 'KX', seqNo: 1 })).toBe(false);
  });
});

describe('FLEXCUBE polling configuration and scheduler', () => {
  const cfg = (over = {}) => ({
    dbUser: undefined,
    dbPassword: undefined,
    dbConnectString: undefined,
    dbSchema: undefined,
    stagingTable: 'STAGE',
    pollEnabled: false,
    pollIntervalMs: 120000,
    pollBatchSize: 20,
    syncStartDate: '2026-11-16' as string | undefined,
    stagingStatusInProgress: 'W',
    keypersonTypeColumn: 'KYC_KEYPERSON_TYPE',
    finalStatusVocabulary: 'approved-blocked',
    ...over,
  });
  const wf = {} as IKycWorkflow;

  it('is off by default and refuses to start enabled without the FLEXCUBE database', () => {
    expect(createFlexcubeSync(new FakeFlexcubeDb(), wf, cfg())).toBeNull();
    expect(() => createFlexcubeSync(null, wf, cfg({ pollEnabled: true }))).toThrow(
      FlexcubeSyncConfigError,
    );
    expect(createFlexcubeSync(new FakeFlexcubeDb(), wf, cfg({ pollEnabled: true }))).toBeInstanceOf(
      FlexcubeSyncService,
    );
  });

  it('refuses to start enabled without a valid FLEXCUBE_SYNC_START_DATE (no default cut-off)', () => {
    for (const syncStartDate of [undefined, '', 'not-a-date', '2026-13-01']) {
      expect(() =>
        createFlexcubeSync(new FakeFlexcubeDb(), wf, cfg({ pollEnabled: true, syncStartDate })),
      ).toThrow(/FLEXCUBE_SYNC_START_DATE/);
    }
    // disabled polling does not need it
    expect(
      createFlexcubeSync(new FakeFlexcubeDb(), wf, cfg({ syncStartDate: undefined })),
    ).toBeNull();
  });

  it('the in-progress status defaults to W and must be one uppercase letter', () => {
    expect(loadConfiguration({}).flexcube.stagingStatusInProgress).toBe('W');
    expect(
      loadConfiguration({ FLEXCUBE_STAGING_STATUS_IN_PROGRESS: 'P' }).flexcube
        .stagingStatusInProgress,
    ).toBe('P');
    for (const bad of ['w', 'WW', '1', ' ', "W'", 'W;']) {
      expect(() =>
        createFlexcubeSync(
          new FakeFlexcubeDb(),
          wf,
          cfg({ pollEnabled: true, stagingStatusInProgress: bad }),
        ),
      ).toThrow(/FLEXCUBE_STAGING_STATUS_IN_PROGRESS/);
      expect(() => new StagingSubmissionRepository(new FakeFlexcubeDb(), 'STAGE', bad)).toThrow(
        /FLEXCUBE_STAGING_STATUS_IN_PROGRESS/,
      );
    }
  });

  it('the key-person type column defaults to KYC_KEYPERSON_TYPE and is validated at startup', () => {
    expect(loadConfiguration({}).flexcube.keypersonTypeColumn).toBe('KYC_KEYPERSON_TYPE');
    expect(
      loadConfiguration({ FLEXCUBE_KEYPERSON_TYPE_COLUMN: 'OWNERSHIP_TYPE' }).flexcube
        .keypersonTypeColumn,
    ).toBe('OWNERSHIP_TYPE');
    expect(
      createFlexcubeSync(
        new FakeFlexcubeDb(),
        wf,
        cfg({ pollEnabled: true, keypersonTypeColumn: 'OWNERSHIP_TYPE' }),
      ),
    ).toBeInstanceOf(FlexcubeSyncService);
    for (const bad of ['A;B', 'a b', '']) {
      expect(() =>
        createFlexcubeSync(
          new FakeFlexcubeDb(),
          wf,
          cfg({ pollEnabled: true, keypersonTypeColumn: bad }),
        ),
      ).toThrow(FlexcubeSyncConfigError);
    }
  });

  it('loadConfiguration reads FLEXCUBE_SYNC_START_DATE (blank = unset)', () => {
    expect(
      loadConfiguration({ FLEXCUBE_SYNC_START_DATE: '2026-11-16' }).flexcube.syncStartDate,
    ).toBe('2026-11-16');
    expect(
      loadConfiguration({ FLEXCUBE_SYNC_START_DATE: '  ' }).flexcube.syncStartDate,
    ).toBeUndefined();
  });

  it('logs a failed pass with the Oracle code only, never the message', async () => {
    const logged: unknown[] = [];
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
      logged.push(m);
    });
    const service = {
      runOnce: jest
        .fn()
        .mockRejectedValue(new Error('ORA-00942: table or view SECRET_T does not exist')),
    };
    const scheduler = new FlexcubeSyncScheduler(service as unknown as FlexcubeSyncService, 60000);
    await scheduler.tick();
    spy.mockRestore();
    expect(logged).toEqual([{ event: 'flexcube.sync.failed', error: 'ORA-00942' }]);
    expect(JSON.stringify(logged)).not.toContain('SECRET_T');
    await scheduler.onModuleDestroy();
  });

  it('a failing pass is logged and the scheduler keeps going', async () => {
    const service = { runOnce: jest.fn().mockRejectedValue(new Error('db down')) };
    const scheduler = new FlexcubeSyncScheduler(service as unknown as FlexcubeSyncService, 60000);
    await expect(scheduler.tick()).resolves.toBeUndefined();
    await scheduler.onModuleDestroy();
  });

  it('does nothing when polling is disabled', async () => {
    const scheduler = new FlexcubeSyncScheduler(null, 60000);
    scheduler.onApplicationBootstrap();
    await scheduler.onModuleDestroy();
  });
});
