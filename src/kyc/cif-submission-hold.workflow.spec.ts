import { FakeFlexcubeDb } from '../../test/support/fake-flexcube-db';
import { FlexcubeSyncService } from '../flexcube-sync/flexcube-sync.service';
import { FlexcubeCustomerRequest } from '../flexcube/dto/flexcube-customer.request';
import { FlexcubeKycSource } from '../flexcube/source/flexcube-kyc-source';
import { StagingSubmissionRepository } from '../flexcube/staging/staging-submission.repository';
import { CifSubmissionHoldWorkflow } from './cif-submission-hold.workflow';
import { createFlexcubeSync } from '../flexcube-sync/flexcube-sync.module';
import { AppConfig } from '../config/configuration';

describe('CIF submission hold: no persistence or external clients', () => {
  const workflow = new CifSubmissionHoldWorkflow();
  it('keeps disabled polling inert and refuses enabled polling before any source/staging work', () => {
    expect(
      createFlexcubeSync(null, workflow, { pollEnabled: false } as AppConfig['flexcube']),
    ).toBeNull();
    expect(() =>
      createFlexcubeSync(null, workflow, { pollEnabled: true } as AppConfig['flexcube']),
    ).toThrow('Polling must remain disabled');
  });
  it.each([null, undefined, '', '   '])(
    'refuses missing CIF (%s), without reference fallback',
    async (value) => {
      const request = { KYC_REF_NO: 'PRIVATE-KYC', CUSTOMER_NO: value } as FlexcubeCustomerRequest;
      expect(await workflow.submit(request)).toMatchObject({
        outcome: 'FAILED',
        code: 'MISSING_CIF',
        requestMayHaveReachedReis: false,
        kycCase: null,
      });
    },
  );
  it.each([123, ['0001', '0002'], { cif: '0001' }])(
    'refuses ambiguous/non-string CIF (%j)',
    async (value) => {
      expect(
        await workflow.submit({ CUSTOMER_NO: value } as unknown as FlexcubeCustomerRequest),
      ).toMatchObject({ code: 'INVALID_CIF' });
    },
  );
  it.each(['INDIVIDUAL', 'CORPORATE'])(
    'holds even a valid %s CIF until the cutover is verified',
    async (type) => {
      const request = {
        KYC_REF_NO: 'PRIVATE-KYC',
        CUSTOMER_NO: '000045',
        CUSTOMER_TYPE: type,
      } as FlexcubeCustomerRequest;
      const result = await workflow.submit(request);
      expect(result).toMatchObject({
        code: 'CIF_CUTOVER_NOT_APPROVED',
        kycCase: null,
        requestMayHaveReachedReis: false,
      });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE-KYC|000045/);
    },
  );

  it('does not requeue or alter any of 58 historical E rows, even in a simulated poll pass', async () => {
    const db = new FakeFlexcubeDb();
    for (let i = 0; i < 58; i++) {
      const ref = `SYNTHETIC-${i}`;
      db.master.push({
        KYC_REF_NO: ref,
        KYC_CUST_TYPE: 'R',
        MOD_NO: 1,
        AUTH_STAT: 'A',
        RECORD_STAT: 'O',
      });
      db.staging.push({
        KYC_REF_NO: ref,
        SEQ_NO: 1,
        MSGID: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        PROCESS_STATUS: 'E',
        REQUEST: null,
        RESPONSE: '{"error":"ORA-01745"}',
        RETRY_COUNT: 1,
      });
    }
    const original = JSON.stringify(db.staging);
    const service = new FlexcubeSyncService(
      new FlexcubeKycSource(db, 'STAGE', '2026-11-16'),
      new StagingSubmissionRepository(db, 'STAGE'),
      workflow,
      100,
    );
    expect(await service.runOnce()).toMatchObject({ found: 0, sent: 0 });
    expect(JSON.stringify(db.staging)).toBe(original);
    expect(db.statements.every((sql) => sql.trim().startsWith('SELECT'))).toBe(true);
  });
});
