import { Logger } from '@nestjs/common';
import { FakeFlexcubeDb, StagingRow } from '../../test/support/fake-flexcube-db';
import { INDIVIDUAL_ROW, onboarded, SINCE } from '../../test/support/sync-fixtures';
import { FlexcubeKycSource } from '../flexcube/source/flexcube-kyc-source';
import {
  StagingKey,
  StagingSubmissionRepository,
} from '../flexcube/staging/staging-submission.repository';
import { IKycWorkflow } from '../kyc/kyc.interfaces';
import { KycSubmissionResult } from '../kyc/kyc-submission.result';
import { KycRequestStatus } from '../common/kyc-status';
import { AppConfig } from '../config/configuration';
import { createFlexcubeSync, FlexcubeSyncConfigError } from './flexcube-sync.module';
import { FlexcubeSyncService } from './flexcube-sync.service';

/**
 * Send guard of the polling service: once a delivery to REIS is uncertain, NOTHING is sent
 * automatically (also after a restart) until an operator reconciles and acknowledges the row.
 */
const OWN = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const timeoutResult = (): KycSubmissionResult =>
  ({
    outcome: 'FAILED',
    stage: 'REIS_ONBOARDING',
    code: 'REIS_ONBOARDING_TIMEOUT',
    requestMayHaveReachedReis: true,
    persistedStatus: KycRequestStatus.DELIVERY_UNCERTAIN,
    kycCase: null,
    reisRequest: { systemId: 'X' },
  }) as unknown as KycSubmissionResult;

describe('FlexcubeSyncService guards', () => {
  let db: FakeFlexcubeDb;
  let workflow: { submit: jest.Mock };
  let logged: Record<string, unknown>[];

  const service = (ack: StagingKey[] = []) =>
    new FlexcubeSyncService(
      new FlexcubeKycSource(db, 'STAGE', SINCE, 'KYC_KEYPERSON_TYPE'),
      new StagingSubmissionRepository(db, 'STAGE'),
      workflow as unknown as IKycWorkflow,
      20,
      { acknowledgedUncertain: ack },
    );
  const addKyc = (ref: string) => {
    db.master.push({ KYC_REF_NO: ref, KYC_CUST_TYPE: 'R', MOD_NO: 1, AUTH_STAT: 'A' });
    db.details.set(ref, INDIVIDUAL_ROW);
    db.products.set(ref, ['SALR']);
  };
  const own = (ref: string, over: Partial<StagingRow> = {}): StagingRow => ({
    KYC_REF_NO: ref,
    SEQ_NO: 1,
    MSGID: OWN,
    PROCESS_STATUS: 'N',
    REQUEST: null,
    RESPONSE: null,
    RETRY_COUNT: 0,
    ...over,
  });
  const sentRefs = () =>
    workflow.submit.mock.calls.map((c) => (c[0] as { KYC_REF_NO: string }).KYC_REF_NO);

  beforeEach(() => {
    db = new FakeFlexcubeDb();
    workflow = { submit: jest.fn().mockResolvedValue(onboarded()) };
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((m: unknown, ..._rest: unknown[]) => {
        logged.push(m as Record<string, unknown>);
      });
    }
  });
  afterEach(() => jest.restoreAllMocks());

  describe('uncertain delivery stops all sending until reconciled', () => {
    beforeEach(() => {
      for (const ref of ['K1', 'K2', 'K3']) addKyc(ref);
    });

    it('a REIS timeout (request may have reached REIS): E marked UNCERTAIN, the pass stops', async () => {
      workflow.submit.mockResolvedValueOnce(timeoutResult());
      const sync = service();
      expect(await sync.runOnce()).toEqual({ found: 3, sent: 0, failed: 1, skipped: 0 });
      expect(db.staging).toHaveLength(1);
      expect(JSON.parse(db.staging[0].RESPONSE as string)).toMatchObject({
        error: 'REIS_ONBOARDING_TIMEOUT',
        delivery: 'UNCERTAIN',
      });
      expect(await sync.runOnce()).toMatchObject({ found: 0 });
      expect(workflow.submit).toHaveBeenCalledTimes(1);
      expect(sync.getStatus().sendingHalted).toBe(true);
    });

    it('stays stopped after a restart: the staging table remembers the uncertain row', async () => {
      workflow.submit.mockResolvedValueOnce(timeoutResult());
      await service().runOnce();
      const restarted = service();
      expect(await restarted.runOnce()).toMatchObject({ found: 0, sent: 0 });
      expect(workflow.submit).toHaveBeenCalledTimes(1);
      expect(logged.some((l) => l.reason === 'DELIVERY_UNCERTAIN')).toBe(true);
    });

    it('a row claimed too long (pass died, maybe after the REIS call) also stops sending', async () => {
      db.staging.push(own('K1', { PROCESS_STATUS: 'W', REQ_DATE: 'SYSDATE', AGE_MIN: 6 }));
      expect(await service().runOnce()).toMatchObject({ sent: 0 });
      expect(workflow.submit).not.toHaveBeenCalled();
    });

    it('an operator acknowledgement (after reconciliation) lets sending resume', async () => {
      db.staging.push(
        own('K1', {
          PROCESS_STATUS: 'E',
          RESPONSE: JSON.stringify({ error: 'REIS_ONBOARDING_TIMEOUT', delivery: 'UNCERTAIN' }),
          RETRY_COUNT: 1,
        }),
      );
      expect(await service().runOnce()).toMatchObject({ sent: 0 });
      const acked = service([{ kycRefNo: 'K1', seqNo: 1 }]);
      expect(await acked.runOnce()).toMatchObject({ sent: 2 }); // K2, K3; K1 itself is never resent
      expect(sentRefs()).toEqual(['K2', 'K3']);
    });

    it('if the guard cannot be checked (database down), nothing is sent', async () => {
      db.queryHook = (sql) =>
        sql.includes(':uncertainMarker') ? new Error('NJS-503: connection refused') : undefined;
      const sync = service();
      expect(await sync.runOnce()).toMatchObject({ sent: 0 });
      expect(workflow.submit).not.toHaveBeenCalled();
      expect(logged.some((l) => l.reason === 'CHECK_FAILED')).toBe(true);
    });

    it('REIS answered but the result could not be stored: the row stays in progress, sending stops', async () => {
      db.executeHook = (sql) =>
        sql.includes('REQUEST = COALESCE') ? new Error('ORA-03113: end-of-file') : undefined;
      const sync = service();
      expect(await sync.runOnce()).toMatchObject({ sent: 0, failed: 1 });
      expect(db.staging[0].PROCESS_STATUS).toBe('W');
      db.executeHook = null;
      expect(await sync.runOnce()).toMatchObject({ found: 0 });
      expect(workflow.submit).toHaveBeenCalledTimes(1);
    });

    it('a duplicate whose earlier delivery is uncertain is treated the same way', async () => {
      workflow.submit.mockResolvedValueOnce({
        outcome: 'DUPLICATE',
        reason: 'DELIVERY_UNCERTAIN',
        kycCase: {},
      } as unknown as KycSubmissionResult);
      const sync = service();
      expect(await sync.runOnce()).toMatchObject({ failed: 1, sent: 0 });
      expect(JSON.parse(db.staging[0].RESPONSE as string)).toMatchObject({
        delivery: 'UNCERTAIN',
      });
      expect(await service().runOnce()).toMatchObject({ found: 0 });
    });

    it('config: acknowledgements must be KYC_REF_NO:SEQ_NO entries', () => {
      const base = {
        pollEnabled: true,
        syncStartDate: SINCE,
        stagingStatusInProgress: 'W',
        keypersonTypeColumn: 'KYC_KEYPERSON_TYPE',
        stagingTable: 'STAGE',
        pollBatchSize: 20,
        syncUncertainAck: [],
      } as unknown as AppConfig['flexcube'];
      const make = (ack: string[]) =>
        createFlexcubeSync(db, workflow as unknown as IKycWorkflow, {
          ...base,
          syncUncertainAck: ack,
        });
      expect(make(['K1:1', '001ZKYC26151003Y:2'])).toBeInstanceOf(FlexcubeSyncService);
      for (const bad of [['K1'], ['k1:1'], ["K1:1' OR 1=1"], ['K1:x']]) {
        expect(() => make(bad)).toThrow(FlexcubeSyncConfigError);
      }
    });

    it('a failure known to be BEFORE REIS (validation) does not stop the others', async () => {
      workflow.submit.mockResolvedValueOnce({
        outcome: 'FAILED',
        stage: 'VALIDATION',
        code: 'MissingRequiredFieldError',
        requestMayHaveReachedReis: false,
        persistedStatus: KycRequestStatus.VALIDATION_FAILED,
        kycCase: null,
      } as unknown as KycSubmissionResult);
      expect(await service().runOnce()).toEqual({ found: 3, sent: 2, failed: 1, skipped: 0 });
    });
  });
});
