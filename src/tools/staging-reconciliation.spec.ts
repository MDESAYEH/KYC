import { FakeFlexcubeDb, StagingRow } from '../../test/support/fake-flexcube-db';
import { SINCE } from '../../test/support/sync-fixtures';
import { StagingSubmissionRepository } from '../flexcube/staging/staging-submission.repository';
import {
  reconcileNeverSent,
  RECONCILE_CONFIRMATION,
  ReconciliationDeps,
  ReconciliationRefusedError,
} from './staging-reconciliation';

/** The 58 rows of the ORA-01745 incident: E, never claimed, nothing stored but the technical marker. */
const OWN = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const MARKER = JSON.stringify({ error: 'ORA-01745' });

describe('reconciliation of rows closed as E although nothing was sent', () => {
  let db: FakeFlexcubeDb;
  let cases: Set<string>;
  let backups: string[][];

  const incidentRow = (ref: string, over: Partial<StagingRow> = {}): StagingRow => ({
    KYC_REF_NO: ref,
    SEQ_NO: 1,
    MSGID: OWN,
    PROCESS_STATUS: 'E',
    REQUEST: null,
    RESPONSE: MARKER,
    RETRY_COUNT: 1,
    RES_DATE: 'SYSDATE',
    ...over,
  });
  const addKyc = (ref: string, over: Partial<FakeFlexcubeDb['master'][number]> = {}) =>
    db.master.push({ KYC_REF_NO: ref, KYC_CUST_TYPE: 'R', MOD_NO: 1, AUTH_STAT: 'A', ...over });
  const deps = (over: Partial<ReconciliationDeps> = {}): ReconciliationDeps => ({
    repo: new StagingSubmissionRepository(db, 'STAGE'),
    hasLocalCase: async (ref) => cases.has(ref),
    writeBackup: async (rows) => {
      backups.push(rows.map((r) => r.kycRefNo));
    },
    ...over,
  });
  const dry = { since: SINCE, errorCodes: ['ORA-01745'], maxRows: 500, apply: false };
  const apply = { ...dry, apply: true, confirmation: RECONCILE_CONFIRMATION };
  const snapshot = () => JSON.stringify(db.staging);

  beforeEach(() => {
    db = new FakeFlexcubeDb();
    cases = new Set();
    backups = [];
    for (const ref of ['K1', 'K2', 'K3']) {
      addKyc(ref);
      db.staging.push(incidentRow(ref));
    }
  });

  it('a dry run (the default) changes nothing, writes no backup, and only counts', async () => {
    const before = snapshot();
    expect(await reconcileNeverSent(deps(), dry)).toEqual({
      mode: 'dry-run',
      candidates: 3,
      eligible: 3,
      excludedLocalCase: 0,
      restored: 0,
      notRestored: 0,
    });
    expect(snapshot()).toBe(before);
    expect(backups).toEqual([]);
    expect(db.statements.every((s) => /^\s*SELECT/i.test(s))).toBe(true);
  });

  it('refuses to apply without the confirmation word or without a backup', async () => {
    const before = snapshot();
    await expect(
      reconcileNeverSent(deps(), { ...apply, confirmation: undefined }),
    ).rejects.toBeInstanceOf(ReconciliationRefusedError);
    await expect(
      reconcileNeverSent(deps(), { ...apply, confirmation: 'yes' }),
    ).rejects.toBeInstanceOf(ReconciliationRefusedError);
    await expect(
      reconcileNeverSent(deps({ writeBackup: undefined }), apply),
    ).rejects.toBeInstanceOf(ReconciliationRefusedError);
    await expect(reconcileNeverSent(deps(), { ...apply, errorCodes: [] })).rejects.toThrow(
      'no error code',
    );
    expect(snapshot()).toBe(before);
  });

  it('applies only to proven never-sent rows: backup first, E -> N, error state reset', async () => {
    const order: string[] = [];
    const base = deps();
    const report = await reconcileNeverSent(
      {
        ...base,
        writeBackup: async (rows) => {
          order.push(`backup:${rows.length}`);
          backups.push(rows.map((r) => r.kycRefNo));
          expect(db.staging.every((r) => r.PROCESS_STATUS === 'E')).toBe(true); // not changed yet
        },
      },
      apply,
    );
    expect(report).toEqual({
      mode: 'applied',
      candidates: 3,
      eligible: 3,
      excludedLocalCase: 0,
      restored: 3,
      notRestored: 0,
    });
    expect(order).toEqual(['backup:3']);
    for (const r of db.staging) {
      expect(r).toMatchObject({ PROCESS_STATUS: 'N', RESPONSE: null, RETRY_COUNT: 0 });
      expect(r.RES_DATE).toBeUndefined();
    }
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    await reconcileNeverSent(deps(), apply);
    expect(await reconcileNeverSent(deps(), apply)).toMatchObject({ candidates: 0, restored: 0 });
  });

  it('never restores a row whose KYC has a case in the integration layer (REIS may have been called)', async () => {
    cases.add('K2');
    const report = await reconcileNeverSent(deps(), apply);
    expect(report).toMatchObject({ candidates: 3, eligible: 2, excludedLocalCase: 1, restored: 2 });
    expect(db.staging.find((r) => r.KYC_REF_NO === 'K2')).toMatchObject({
      PROCESS_STATUS: 'E',
      RESPONSE: MARKER,
      RETRY_COUNT: 1,
    });
    expect(backups).toEqual([['K1', 'K3']]);
  });

  it('stops when the local database cannot be read: no proof, no restore', async () => {
    const before = snapshot();
    await expect(
      reconcileNeverSent(
        deps({
          hasLocalCase: async () => {
            throw new Error('SQLITE_ERROR: no such table: kyc_case');
          },
        }),
        apply,
      ),
    ).rejects.toThrow();
    expect(snapshot()).toBe(before);
    expect(backups).toEqual([]);
  });

  it('leaves every other kind of row alone', async () => {
    db.staging.length = 0;
    const others: StagingRow[] = [
      incidentRow('S1', { PROCESS_STATUS: 'N', RESPONSE: null, RETRY_COUNT: 0 }), // never failed
      incidentRow('S2', { REQUEST: '{"x":1}' }), // a request was stored
      incidentRow('S3', { REQ_DATE: 'SYSDATE' }), // it was claimed
      incidentRow('S4', { REIS_FINAL_STATUS: 'APPROVED' }), // has a final status
      incidentRow('S5', { RETRY_COUNT: 2 }), // failed more than once
      incidentRow('S6', { RESPONSE: JSON.stringify({ error: 'ORA-02290' }) }), // other code
      incidentRow('S7', { RESPONSE: JSON.stringify({ error: 'KycDetailsNotFoundError' }) }), // data failure
      incidentRow('S8', {
        RESPONSE: JSON.stringify({ error: 'ORA-01745', delivery: 'UNCERTAIN' }),
      }),
      incidentRow('TEST123', { MSGID: 'TEST123' }), // Finexta's row, not ours
      incidentRow('S9', { PROCESS_STATUS: 'S' }),
      incidentRow('S10', { SEQ_NO: 1 }), // its KYC changed MOD_NO
      incidentRow('S11'), // its KYC is closed
      incidentRow('S12'), // its KYC is before the cut-off
      incidentRow('S13'), // its KYC type is not supported
      incidentRow('S14'), // its KYC no longer exists
    ];
    db.staging.push(...others);
    for (const ref of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'TEST123', 'S9'])
      addKyc(ref);
    addKyc('S10', { MOD_NO: 2 });
    addKyc('S11', { RECORD_STAT: 'C' });
    addKyc('S12', { MAKER_DT_STAMP: '2026-05-01T00:00:00' });
    addKyc('S13', { KYC_CUST_TYPE: 'X' });
    const before = snapshot();
    expect(await reconcileNeverSent(deps(), apply)).toMatchObject({ candidates: 0, restored: 0 });
    expect(snapshot()).toBe(before);
  });

  it('a row that changed after the SELECT is not restored (the UPDATE re-checks every condition)', async () => {
    const base = deps();
    const report = await reconcileNeverSent(
      {
        ...base,
        writeBackup: async () => {
          // someone claimed K1 between the SELECT and the UPDATE
          const r = db.staging.find((x) => x.KYC_REF_NO === 'K1')!;
          r.REQ_DATE = 'SYSDATE';
        },
      },
      apply,
    );
    expect(report).toMatchObject({ eligible: 3, restored: 2, notRestored: 1 });
    expect(db.staging.find((r) => r.KYC_REF_NO === 'K1')!.PROCESS_STATUS).toBe('E');
  });

  it('only Oracle / driver codes can be allowed: no free text', async () => {
    await expect(
      reconcileNeverSent(deps(), { ...dry, errorCodes: ['KycDetailsNotFoundError'] }),
    ).rejects.toThrow('Not an Oracle / driver error code');
    await expect(
      reconcileNeverSent(deps(), { ...dry, errorCodes: ["ORA-01745'} OR 1=1 --"] }),
    ).rejects.toThrow();
  });

  it('every statement passes the bind guard and the report holds counts only', async () => {
    const report = await reconcileNeverSent(deps(), apply);
    expect(Object.values(report).every((v) => typeof v === 'number' || typeof v === 'string')).toBe(
      true,
    );
    expect(JSON.stringify(report)).not.toMatch(/K1|K2|K3/);
    expect(db.statements.some((s) => /DELETE|INSERT/i.test(s))).toBe(false);
  });
});
