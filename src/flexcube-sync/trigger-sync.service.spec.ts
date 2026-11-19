import { Logger } from '@nestjs/common';
import { ReadyCustomer } from '../flexcube/source/customer-trigger.source';
import { KycSubmissionResult } from '../kyc/kyc-submission.result';
import { KycRequestStatus } from '../common/kyc-status';
import { AppConfig } from '../config/configuration';
import {
  createTriggerSync,
  FlexcubeSyncConfigError,
  TriggerSyncDeps,
} from './flexcube-sync.module';
import { TriggerSyncService } from './trigger-sync.service';

const oraError = (code: string) => Object.assign(new Error(`${code}: synthetic`), { errorNum: 1 });

const customer = (over: Partial<ReadyCustomer> = {}): ReadyCustomer => ({
  customerNo: '00009999',
  kycRefNo: 'KYC-NEW-1',
  seqNo: 1,
  kycModNo: 1,
  customerType: 'INDIVIDUAL',
  stagingRows: 0,
  higherRows: 0,
  ...over,
});

const onboarded = (): KycSubmissionResult =>
  ({
    outcome: 'ONBOARDED',
    reisOnboardingStatus: 'CLEAN',
    kycCase: {},
    reisRequest: { systemId: '00009999' },
    reisResponse: { status: 'CLEAN' },
  }) as unknown as KycSubmissionResult;

describe('TriggerSyncService (STTM_CUSTOMER_CUSTOM U -> REIS -> S / E)', () => {
  let ready: ReadyCustomer[];
  let triggers: { findReady: jest.Mock; markPicked: jest.Mock; markError: jest.Mock };
  let details: { refreshCorporateSupport: jest.Mock; load: jest.Mock };
  let staging: Record<string, jest.Mock>;
  let workflow: { submit: jest.Mock };
  const make = (allow: string[] = []) =>
    new TriggerSyncService(
      triggers as never,
      details as never,
      staging as never,
      workflow as never,
      20,
      { cifAllowlist: new Set(allow) },
    );

  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const)
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    ready = [customer()];
    triggers = {
      findReady: jest.fn(async () => ready),
      markPicked: jest.fn(async () => true),
      markError: jest.fn(async () => true),
    };
    details = {
      refreshCorporateSupport: jest.fn(async () => false),
      load: jest.fn(async () => ({ KYC_REF_NO: 'KYC-NEW-1', CUSTOMER_TYPE: 'INDIVIDUAL' })),
    };
    staging = {
      findDeliveryRisk: jest.fn(async () => []),
      insertNew: jest.fn(async () => true),
      claim: jest.fn(async () => true),
      release: jest.fn(async () => true),
      fail: jest.fn(async () => true),
      complete: jest.fn(async () => undefined),
    };
    workflow = { submit: jest.fn(async () => onboarded()) };
  });
  afterEach(() => jest.restoreAllMocks());

  it('new CIF: N -> W -> details -> trigger P -> REIS with CUSTOMER_NO = CIF and SEQ_NO = CIF MOD_NO -> S', async () => {
    expect(await make().runOnce()).toEqual({ found: 1, sent: 1, failed: 0, skipped: 0 });
    const calls = {
      findDeliveryRisk: staging.findDeliveryRisk,
      findReady: triggers.findReady,
      insertNew: staging.insertNew,
      claim: staging.claim,
      load: details.load,
      markPicked: triggers.markPicked,
      submit: workflow.submit,
      complete: staging.complete,
    };
    const order = Object.entries(calls)
      .sort(([, x], [, y]) => x.mock.invocationCallOrder[0] - y.mock.invocationCallOrder[0])
      .map(([name]) => name);
    expect(order).toEqual(Object.keys(calls));
    expect(workflow.submit).toHaveBeenCalledWith(
      expect.objectContaining({ KYC_REF_NO: 'KYC-NEW-1', CUSTOMER_NO: '00009999' }),
      { seqNo: 1 },
    );
    expect(staging.insertNew.mock.calls[0][0]).toEqual({ kycRefNo: 'KYC-NEW-1', seqNo: 1 });
    expect(triggers.markError).not.toHaveBeenCalled();
  });

  it('only CIFs of the allow-list are taken; the others stay U untouched', async () => {
    expect(await make(['00001111']).runOnce()).toMatchObject({ found: 0 });
    expect(staging.insertNew).not.toHaveBeenCalled();
    expect(triggers.markPicked).not.toHaveBeenCalled();
    expect(triggers.markError).not.toHaveBeenCalled();
  });

  it('a higher SEQ_NO for the KYC: not sent, trigger E', async () => {
    ready = [customer({ higherRows: 1 })];
    expect(await make().runOnce()).toMatchObject({ skipped: 1, sent: 0 });
    expect(staging.insertNew).not.toHaveBeenCalled();
    expect(triggers.markError).toHaveBeenCalledTimes(1);
  });

  it('revision already staged and not an untouched N row: not sent again, trigger E', async () => {
    ready = [customer({ stagingRows: 1 })];
    staging.claim.mockResolvedValueOnce(false);
    expect(await make().runOnce()).toMatchObject({ skipped: 1 });
    expect(staging.insertNew).not.toHaveBeenCalled();
    expect(workflow.submit).not.toHaveBeenCalled();
    expect(triggers.markError).toHaveBeenCalled();
  });

  it('our own untouched N row (an earlier pass died before REIS) is claimed and sent', async () => {
    ready = [customer({ stagingRows: 1 })];
    expect(await make().runOnce()).toMatchObject({ sent: 1 });
    expect(staging.insertNew).not.toHaveBeenCalled();
  });

  it('trigger no longer U (FCUBS changed it / CIF modified): claim given back, nothing sent', async () => {
    triggers.markPicked.mockResolvedValueOnce(false);
    expect(await make().runOnce()).toMatchObject({ skipped: 1 });
    expect(staging.release).toHaveBeenCalled();
    expect(workflow.submit).not.toHaveBeenCalled();
  });

  it('a database error while reading the KYC: claim released, trigger stays U (next pass retries)', async () => {
    details.load.mockRejectedValueOnce(oraError('ORA-03113'));
    expect(await make().runOnce()).toMatchObject({ failed: 1 });
    expect(staging.release).toHaveBeenCalled();
    expect(triggers.markPicked).not.toHaveBeenCalled();
    expect(triggers.markError).not.toHaveBeenCalled();
    expect(workflow.submit).not.toHaveBeenCalled();
  });

  it('KYC data that cannot be processed: staging E with the error class only, trigger E', async () => {
    class KycDetailsNotFoundError extends Error {
      name = 'KycDetailsNotFoundError';
    }
    details.load.mockRejectedValueOnce(new KycDetailsNotFoundError('Ali Ahmed not found'));
    expect(await make().runOnce()).toMatchObject({ failed: 1 });
    expect(staging.fail).toHaveBeenCalledWith(expect.anything(), {
      error: 'KycDetailsNotFoundError',
    });
    expect(JSON.stringify(staging.fail.mock.calls)).not.toContain('Ali');
    expect(triggers.markError).toHaveBeenCalled();
  });

  it('CUSTOMER_NO in the KYC details differs from the trigger row: not sent, E', async () => {
    details.load.mockResolvedValueOnce({ KYC_REF_NO: 'KYC-NEW-1', CUSTOMER_NO: '00000001' });
    expect(await make().runOnce()).toMatchObject({ failed: 1 });
    expect(workflow.submit).not.toHaveBeenCalled();
    expect(staging.fail).toHaveBeenCalledWith(expect.anything(), {
      error: 'CifSourcesDisagreeError',
    });
  });

  it('REIS rejected (FAILED, not reached / validation): staging E, trigger E, the pass continues', async () => {
    ready = [customer(), customer({ customerNo: '00009998', kycRefNo: 'KYC-NEW-2' })];
    workflow.submit.mockResolvedValueOnce({
      outcome: 'FAILED',
      stage: 'REIS_ONBOARDING',
      code: 'REIS_ONBOARDING_HTTP_400',
      requestMayHaveReachedReis: false,
      persistedStatus: KycRequestStatus.FAILED_PERMANENT,
      kycCase: null,
    } as unknown as KycSubmissionResult);
    expect(await make().runOnce()).toEqual({ found: 2, sent: 1, failed: 1, skipped: 0 });
    expect(triggers.markError).toHaveBeenCalledTimes(1);
  });

  it('an uncertain delivery (timeout) stops the pass and every later pass until acknowledged', async () => {
    ready = [customer(), customer({ customerNo: '00009998', kycRefNo: 'KYC-NEW-2' })];
    workflow.submit.mockRejectedValueOnce(new Error('socket hang up'));
    const sync = make();
    expect(await sync.runOnce()).toMatchObject({ failed: 1, sent: 0 });
    expect(staging.fail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ delivery: 'UNCERTAIN' }),
    );
    expect(workflow.submit).toHaveBeenCalledTimes(1);
    expect(await sync.runOnce()).toMatchObject({ found: 0 });
    expect(sync.getStatus().sendingHalted).toBe(true);
  });

  it('nothing is sent while the staging table holds an unresolved delivery, or when that cannot be checked', async () => {
    staging.findDeliveryRisk.mockResolvedValueOnce([{ kycRefNo: 'OLD', seqNo: 1 }]);
    expect(await make().runOnce()).toMatchObject({ found: 0 });
    staging.findDeliveryRisk.mockRejectedValueOnce(oraError('ORA-12541'));
    expect(await make().runOnce()).toMatchObject({ found: 0 });
    expect(triggers.findReady).not.toHaveBeenCalled();
  });
});

describe('createTriggerSync (startup checks)', () => {
  const base = {
    pollEnabled: true,
    syncStartDate: '2026-11-19',
    stagingStatusInProgress: 'W',
    keypersonTypeColumn: 'KYC_KEYPERSON_TYPE',
    stagingTable: 'STAGE',
    pollBatchSize: 5,
    finalStatusVocabulary: 'clean-pending-blocked',
    syncUncertainAck: [],
    syncCifAllowlist: ['00009999'],
    syncAllCifs: false,
  } as unknown as AppConfig['flexcube'];
  const db = { query: jest.fn(), execute: jest.fn() };
  const deps = {} as TriggerSyncDeps;
  const make = (over: Partial<AppConfig['flexcube']>) =>
    createTriggerSync(db, deps, { ...base, ...over } as AppConfig['flexcube']);

  it('returns null when polling is disabled, a service with an allow-list', () => {
    expect(make({ pollEnabled: false })).toBeNull();
    expect(make({})).toBeInstanceOf(TriggerSyncService);
    expect(make({ syncCifAllowlist: [], syncAllCifs: true })).toBeInstanceOf(TriggerSyncService);
  });

  it.each([
    [{ syncCifAllowlist: [] }, 'FLEXCUBE_SYNC_CIF_ALLOWLIST'],
    [{ syncCifAllowlist: ["0001' OR 1=1"] }, 'must list CIFs'],
    [{ finalStatusVocabulary: 'approved-blocked' }, 'clean-pending-blocked'],
    [{ syncStartDate: undefined }, 'FLEXCUBE_SYNC_START_DATE'],
    [{ syncUncertainAck: ['bad'] }, 'KYC_REF_NO:SEQ_NO'],
  ])('refuses %j', (over, message) => {
    expect(() => make(over as never)).toThrow(FlexcubeSyncConfigError);
    expect(() => make(over as never)).toThrow(message);
  });

  it('refuses without a FLEXCUBE database', () => {
    expect(() => createTriggerSync(null, deps, base)).toThrow('FLEXCUBE_DB_');
  });
});
