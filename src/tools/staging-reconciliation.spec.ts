import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeFlexcubeDb, StagingRow } from '../../test/support/fake-flexcube-db';
import { SINCE } from '../../test/support/sync-fixtures';
import { StagingSubmissionRepository } from '../flexcube/staging/staging-submission.repository';
import { readBackupFile, writeBackupFile } from './staging-backup-file';
import {
  Attestation,
  attestationProblems,
  BackupBundle,
  candidateListSha256,
  LocalEvidence,
  planReconciliation,
  RECONCILE_CONFIRMATION,
  ReconciliationDeps,
  ReconciliationOptions,
  ReconciliationRefusedError,
  reconcileNeverSent,
  ROLLBACK_CONFIRMATION,
  rollbackReconciliation,
  verifyBundle,
} from './staging-reconciliation';

/** The 58 rows of the ORA-01745 incident: E, never claimed, nothing stored but the technical marker. */
const OWN = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const MARKER = JSON.stringify({ error: 'ORA-01745' });
const NOW = Date.parse('2026-11-17T12:00:00Z');

describe('reconciliation of rows closed as E although the claim never succeeded', () => {
  let db: FakeFlexcubeDb;
  let repo: StagingSubmissionRepository;
  let cases: Set<string>;
  let callbacks: Set<string>;
  let caseCount: number;
  let bundles: BackupBundle[];
  let atBackup: string[];

  const incidentRow = (ref: string, over: Partial<StagingRow> = {}): StagingRow => ({
    KYC_REF_NO: ref,
    SEQ_NO: 1,
    MSGID: OWN,
    PROCESS_STATUS: 'E',
    REQUEST: null,
    RESPONSE: MARKER,
    RETRY_COUNT: 1,
    RES_DATE: '2026-11-17T02:21:05',
    ...over,
  });
  const addKyc = (ref: string, over: Partial<FakeFlexcubeDb['master'][number]> = {}) =>
    db.master.push({ KYC_REF_NO: ref, KYC_CUST_TYPE: 'R', MOD_NO: 1, AUTH_STAT: 'A', ...over });
  const local: LocalEvidence = {
    hasCase: async (ref) => cases.has(ref),
    hasWebhookEvent: async (ref) => callbacks.has(ref),
    summary: async () => ({ caseCount, oldestCaseAt: caseCount ? '2026-11-10T08:00:00' : null }),
  };
  const deps = (over: Partial<ReconciliationDeps> = {}): ReconciliationDeps => ({
    repo,
    local,
    now: () => NOW,
    writeBackup: async (bundle) => {
      atBackup = db.staging.map((r) => r.PROCESS_STATUS); // nothing may have changed yet
      bundles.push(bundle);
    },
    ...over,
  });
  const keys = (...refs: string[]) => refs.map((kycRefNo) => ({ kycRefNo, seqNo: 1 }));
  const HASH = candidateListSha256(keys('K1', 'K2', 'K3'));
  const attestation = (over: Partial<Attestation> = {}): Attestation => ({
    approvedBy: 'Reviewer Name',
    approvedAt: '2026-11-17T10:00:00Z',
    candidateListSha256: HASH,
    reisChecked: true,
    reisCheckMethod: 'REIS portal search by systemId, 17/11/2026',
    noOtherSender: true,
    localDatabaseIsContinuous: true,
    ...over,
  });
  const dry: ReconciliationOptions = {
    since: SINCE,
    errorCodes: ['ORA-01745'],
    maxRows: 500,
    apply: false,
  };
  const apply = (over: Partial<ReconciliationOptions> = {}): ReconciliationOptions => ({
    ...dry,
    apply: true,
    confirmation: RECONCILE_CONFIRMATION,
    attestation: attestation(),
    ...over,
  });
  const snapshot = () => JSON.stringify(db.staging);

  beforeEach(() => {
    db = new FakeFlexcubeDb();
    repo = new StagingSubmissionRepository(db, 'STAGE');
    cases = new Set();
    callbacks = new Set();
    caseCount = 5;
    bundles = [];
    atBackup = [];
    for (const ref of ['K1', 'K2', 'K3']) {
      addKyc(ref);
      db.staging.push(incidentRow(ref));
    }
  });

  describe('dry run (the default)', () => {
    it('changes nothing, writes no backup, and reports counts, evidence and the list hash only', async () => {
      const before = snapshot();
      const report = await reconcileNeverSent(deps(), dry);
      expect(report).toEqual({
        mode: 'dry-run',
        evidence: {
          programmatic: {
            stagingConditions: 3,
            noLocalCaseNoCallback: 3,
            excludedLocalCase: 0,
            excludedWebhookEvent: 0,
          },
          localDatabase: { caseCount: 5, oldestCaseAt: '2026-11-10T08:00:00', empty: false },
          operational: {
            attestationProvided: false,
            attestationValid: false,
            problems: ['no attestation file'],
          },
        },
        eligible: 3,
        eligibleListSha256: HASH,
        restored: 0,
        notRestored: 0,
      });
      expect(snapshot()).toBe(before);
      expect(bundles).toEqual([]);
      expect(db.statements.every((s) => /^\s*SELECT/i.test(s))).toBe(true);
      expect(JSON.stringify(report)).not.toMatch(/K1|K2|K3/);
    });

    it('the list hash does not depend on the order', () => {
      expect(candidateListSha256(keys('K3', 'K1', 'K2'))).toBe(HASH);
      expect(candidateListSha256(keys('K1', 'K2'))).not.toBe(HASH);
    });

    it('programmatic evidence excludes a KYC with a local case or a REIS callback', async () => {
      cases.add('K2');
      callbacks.add('K3');
      const { report, eligible } = await planReconciliation(deps(), dry);
      expect(report.evidence.programmatic).toEqual({
        stagingConditions: 3,
        noLocalCaseNoCallback: 1,
        excludedLocalCase: 1,
        excludedWebhookEvent: 1,
      });
      expect(eligible).toEqual(keys('K1'));
    });

    it('stops when the local database cannot be read: no evidence, nothing restored', async () => {
      const before = snapshot();
      const broken: LocalEvidence = {
        ...local,
        summary: async () => {
          throw new Error('SQLITE_ERROR: no such table: kyc_case');
        },
      };
      await expect(reconcileNeverSent(deps({ local: broken }), apply())).rejects.toThrow();
      expect(snapshot()).toBe(before);
      expect(bundles).toEqual([]);
    });
  });

  describe('applying needs explicit confirmation, a valid attestation and a backup', () => {
    it('refuses without the confirmation word or without a backup writer', async () => {
      const before = snapshot();
      await expect(
        reconcileNeverSent(deps(), apply({ confirmation: undefined })),
      ).rejects.toBeInstanceOf(ReconciliationRefusedError);
      await expect(
        reconcileNeverSent(deps(), apply({ confirmation: 'yes' })),
      ).rejects.toBeInstanceOf(ReconciliationRefusedError);
      await expect(reconcileNeverSent(deps({ writeBackup: undefined }), apply())).rejects.toThrow(
        'backup',
      );
      await expect(reconcileNeverSent(deps(), apply({ errorCodes: [] }))).rejects.toThrow(
        'no error code',
      );
      expect(snapshot()).toBe(before);
    });

    it.each<[string, Partial<Attestation> | 'none', string]>([
      ['no attestation', 'none', 'no attestation file'],
      [
        'a different list of rows',
        { candidateListSha256: candidateListSha256(keys('K1')) },
        'different list',
      ],
      ['REIS not checked', { reisChecked: false }, 'REIS was not checked'],
      ['no check method', { reisCheckMethod: 'x' }, 'reisCheckMethod'],
      ['other senders not excluded', { noOtherSender: false }, 'no-other-sender'],
      ['local database not continuous', { localDatabaseIsContinuous: false }, 'continuous'],
      ['no approver', { approvedBy: ' ' }, 'approvedBy'],
      ['stale (older than 72 h)', { approvedAt: '2026-11-13T10:00:00Z' }, '72 hours'],
      ['dated in the future', { approvedAt: '2026-11-18T10:00:00Z' }, 'future'],
      ['not a date', { approvedAt: 'yesterday' }, 'valid timestamp'],
    ])('refuses %s: nothing is backed up or changed', async (_name, att, problem) => {
      const before = snapshot();
      await expect(
        reconcileNeverSent(
          deps(),
          apply({ attestation: att === 'none' ? undefined : attestation(att) }),
        ),
      ).rejects.toThrow(problem);
      expect(snapshot()).toBe(before);
      expect(bundles).toEqual([]);
    });

    it('an empty local database proves nothing: refused unless the attestation acknowledges it', async () => {
      caseCount = 0;
      await expect(reconcileNeverSent(deps(), apply())).rejects.toThrow('no case at all');
      const report = await reconcileNeverSent(
        deps(),
        apply({ attestation: attestation({ localDatabaseEmptyAcknowledged: true }) }),
      );
      expect(report.restored).toBe(3);
      expect(report.evidence.localDatabase.empty).toBe(true);
    });

    it('attestationProblems is empty only for a complete, fresh, matching attestation', () => {
      expect(attestationProblems(attestation(), HASH, NOW, false)).toEqual([]);
      expect(attestationProblems(attestation(), 'other', NOW, false)).not.toEqual([]);
    });

    it('applies to the proven rows: the full backup exists BEFORE any UPDATE, E -> N, error state reset', async () => {
      const original = JSON.parse(snapshot()) as StagingRow[];
      const report = await reconcileNeverSent(deps(), apply());
      expect(atBackup).toEqual(['E', 'E', 'E']); // not changed when the backup was written
      expect(report).toMatchObject({ mode: 'applied', eligible: 3, restored: 3, notRestored: 0 });
      expect(report.backupRowsSha256).toMatch(/^[0-9a-f]{64}$/);
      // the backup holds EVERY value needed to go back
      expect(bundles[0].rows[0]).toEqual({
        kycRefNo: 'K1',
        seqNo: 1,
        msgId: original[0].MSGID,
        processStatus: 'E',
        request: null,
        response: MARKER,
        retryCount: 1,
        reqDate: null,
        resDate: '2026-11-17T02:21:05',
        reisFinalStatus: null,
      });
      expect(bundles[0].manifest).toMatchObject({
        version: 1,
        rowCount: 3,
        candidateListSha256: HASH,
        since: SINCE,
        errorCodes: ['ORA-01745'],
      });
      expect(() => verifyBundle(bundles[0])).not.toThrow();
      for (const r of db.staging) {
        expect(r).toMatchObject({ PROCESS_STATUS: 'N', RESPONSE: null, RETRY_COUNT: 0 });
        expect(r.RES_DATE).toBeUndefined();
      }
    });

    it('is idempotent: a second run finds nothing to do', async () => {
      await reconcileNeverSent(deps(), apply());
      const again = await reconcileNeverSent(
        deps(),
        apply({ attestation: attestation({ candidateListSha256: candidateListSha256([]) }) }),
      );
      expect(again).toMatchObject({ eligible: 0, restored: 0 });
    });

    it('leaves every other kind of row alone', async () => {
      db.staging.length = 0;
      db.master.length = 0;
      const others: [string, Partial<StagingRow>][] = [
        ['S1', { PROCESS_STATUS: 'N', RESPONSE: null, RETRY_COUNT: 0 }],
        ['S2', { REQUEST: '{"x":1}' }],
        ['S3', { REQ_DATE: 'SYSDATE' }],
        ['S4', { REIS_FINAL_STATUS: 'APPROVED' }],
        ['S5', { RETRY_COUNT: 2 }],
        ['S6', { RESPONSE: JSON.stringify({ error: 'ORA-02290' }) }],
        ['S7', { RESPONSE: JSON.stringify({ error: 'KycDetailsNotFoundError' }) }],
        ['S8', { RESPONSE: JSON.stringify({ error: 'ORA-01745', delivery: 'UNCERTAIN' }) }],
        ['TEST123', { MSGID: 'TEST123' }],
        ['S9', { PROCESS_STATUS: 'S' }],
      ];
      for (const [ref, over] of others) {
        db.staging.push(incidentRow(ref, over));
        addKyc(ref);
      }
      db.staging.push(
        incidentRow('S10'),
        incidentRow('S11'),
        incidentRow('S12'),
        incidentRow('S13'),
        incidentRow('S14'),
      );
      addKyc('S10', { MOD_NO: 2 });
      addKyc('S11', { RECORD_STAT: 'C' });
      addKyc('S12', { MAKER_DT_STAMP: '2026-05-01T00:00:00' });
      addKyc('S13', { KYC_CUST_TYPE: 'X' });
      const before = snapshot();
      expect((await planReconciliation(deps(), dry)).report.eligible).toBe(0);
      expect(snapshot()).toBe(before);
    });

    it('only Oracle / driver codes can be allowed: no free text, no injection', async () => {
      await expect(
        planReconciliation(deps(), { ...dry, errorCodes: ['KycDetailsNotFoundError'] }),
      ).rejects.toThrow('Not an Oracle / driver error code');
      await expect(
        planReconciliation(deps(), { ...dry, errorCodes: ["ORA-01745'} OR 1=1 --"] }),
      ).rejects.toThrow();
    });
  });

  describe('a row that loses ANY eligibility condition between the SELECT and the UPDATE is not changed', () => {
    const changes: [string, (db: FakeFlexcubeDb) => void][] = [
      ['MSGID is not ours (e.g. TEST123)', (d) => void (d.staging[0].MSGID = 'TEST123')],
      [
        'RES_DATE changed after backup',
        (d) => void (d.staging[0].RES_DATE = '2026-11-17T12:00:00'),
      ],
      [
        'the row was replaced by another of ours (different MSGID)',
        (d) => void (d.staging[0].MSGID = '0a1b2c3d-1111-4222-8333-444455556666'),
      ],
      ['the KYC has a new MOD_NO', (d) => void (d.master[0].MOD_NO = 2)],
      ['the KYC is no longer open (RECORD_STAT)', (d) => void (d.master[0].RECORD_STAT = 'C')],
      [
        'the KYC is before the start date',
        (d) => void (d.master[0].MAKER_DT_STAMP = '2026-05-01T00:00:00'),
      ],
      ['the KYC type is not supported', (d) => void (d.master[0].KYC_CUST_TYPE = 'X')],
      [
        'the row was claimed (REQ_DATE)',
        (d) => void (d.staging[0].REQ_DATE = '2026-11-17T12:00:00'),
      ],
      ['a request was stored', (d) => void (d.staging[0].REQUEST = '{"sent":true}')],
      ['a final status was written', (d) => void (d.staging[0].REIS_FINAL_STATUS = 'APPROVED')],
      ['RETRY_COUNT changed', (d) => void (d.staging[0].RETRY_COUNT = 2)],
      [
        'RESPONSE changed',
        (d) => void (d.staging[0].RESPONSE = JSON.stringify({ error: 'ORA-02290' })),
      ],
      [
        'the status changed (someone processed it)',
        (d) => void (d.staging[0].PROCESS_STATUS = 'W'),
      ],
    ];

    it.each(changes)('%s', async (_name, change) => {
      const original = repo.restoreNeverSent.bind(repo);
      jest
        .spyOn(repo, 'restoreNeverSent')
        .mockImplementationOnce(async (key, code, since, msgId, originalResDate) => {
          change(db); // happens after the SELECT and the backup, right before this row's UPDATE
          return original(key, code, since, msgId, originalResDate);
        });
      const first = JSON.stringify(db.staging[0]);
      const report = await reconcileNeverSent(deps(), apply());
      expect(report).toMatchObject({ eligible: 3, restored: 2, notRestored: 1 });
      // K1 kept every value it had after the concurrent change; K2 and K3 were restored
      const k1 = db.staging.find((r) => r.KYC_REF_NO === 'K1')!;
      expect(k1.PROCESS_STATUS).not.toBe('N');
      expect(k1.RESPONSE === null).toBe(false);
      expect(JSON.stringify(k1)).not.toBe(
        JSON.stringify({ ...JSON.parse(first), PROCESS_STATUS: 'N', RESPONSE: null }),
      );
      expect(db.staging.filter((r) => r.PROCESS_STATUS === 'N').map((r) => r.KYC_REF_NO)).toEqual([
        'K2',
        'K3',
      ]);
    });
  });

  describe('rollback to the saved values', () => {
    const reconcile = async () => {
      const before = snapshot();
      await reconcileNeverSent(deps(), apply());
      return { before, bundle: bundles[0] };
    };
    const rollback = { apply: true, confirmation: ROLLBACK_CONFIRMATION };

    it('a dry run counts what can be rolled back and changes nothing', async () => {
      const { bundle } = await reconcile();
      const after = snapshot();
      expect(await rollbackReconciliation({ repo }, bundle, { apply: false })).toEqual({
        mode: 'dry-run',
        rows: 3,
        rollbackable: 3,
        rolledBack: 0,
        notRolledBack: 0,
      });
      expect(snapshot()).toBe(after);
    });

    it('restores EXACTLY the original rows (status, response, retry count, RES_DATE)', async () => {
      const { before, bundle } = await reconcile();
      expect(snapshot()).not.toBe(before);
      expect(await rollbackReconciliation({ repo }, bundle, rollback)).toMatchObject({
        mode: 'applied',
        rolledBack: 3,
        notRolledBack: 0,
      });
      expect(snapshot()).toBe(before);
    });

    it('needs its own confirmation word', async () => {
      const { bundle } = await reconcile();
      await expect(
        rollbackReconciliation({ repo }, bundle, { apply: true }),
      ).rejects.toBeInstanceOf(ReconciliationRefusedError);
      await expect(
        rollbackReconciliation({ repo }, bundle, {
          apply: true,
          confirmation: RECONCILE_CONFIRMATION,
        }),
      ).rejects.toBeInstanceOf(ReconciliationRefusedError);
    });

    it('leaves rows alone that moved on since the restore (claimed, sent): a person must decide', async () => {
      const { bundle } = await reconcile();
      const k1 = db.staging.find((r) => r.KYC_REF_NO === 'K1')!;
      Object.assign(k1, { PROCESS_STATUS: 'W', REQ_DATE: '2026-11-17T13:00:00' });
      const k2 = db.staging.find((r) => r.KYC_REF_NO === 'K2')!;
      Object.assign(k2, {
        PROCESS_STATUS: 'S',
        REQUEST: '{"x":1}',
        RESPONSE: '{"status":"CLEAN"}',
      });
      const k1Before = JSON.stringify(k1);
      const k2Before = JSON.stringify(k2);
      expect(await rollbackReconciliation({ repo }, bundle, rollback)).toMatchObject({
        rolledBack: 1,
        notRolledBack: 2,
      });
      expect(JSON.stringify(k1)).toBe(k1Before);
      expect(JSON.stringify(k2)).toBe(k2Before);
      expect(db.staging.find((r) => r.KYC_REF_NO === 'K3')).toMatchObject({
        PROCESS_STATUS: 'E',
        RETRY_COUNT: 1,
      });
    });

    it('is idempotent', async () => {
      const { bundle } = await reconcile();
      await rollbackReconciliation({ repo }, bundle, rollback);
      expect(await rollbackReconciliation({ repo }, bundle, rollback)).toMatchObject({
        rolledBack: 0,
        notRolledBack: 3,
      });
    });

    it('refuses an edited or damaged backup', async () => {
      const { bundle } = await reconcile();
      const edited = (mutate: (b: BackupBundle) => void) => {
        const copy = JSON.parse(JSON.stringify(bundle)) as BackupBundle;
        mutate(copy);
        return copy;
      };
      for (const bad of [
        edited((b) => void (b.rows[0].response = '{"error":"x"}')),
        edited((b) => void b.rows.pop()),
        edited((b) => void (b.manifest.rowCount = 99)),
        edited((b) => void (b.manifest.attestation.approvedBy = 'Someone Else')),
        { manifest: { version: 2 }, rows: [] } as unknown as BackupBundle,
      ]) {
        await expect(rollbackReconciliation({ repo }, bad, rollback)).rejects.toBeInstanceOf(
          ReconciliationRefusedError,
        );
      }
    });
  });

  describe('the backup file (isolated restore test, nothing touches UAT1)', () => {
    let dir: string;
    beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'kyc-reconcile-'))));
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('is written once with restricted permissions, read back and verified', async () => {
      const file = join(dir, 'backup.json');
      await reconcileNeverSent(
        deps({ writeBackup: async (b) => writeBackupFile(file, b) }),
        apply(),
      );
      const bundle = readBackupFile(file);
      expect(bundle.rows).toHaveLength(3);
      expect(bundle.manifest.attestation.approvedBy).toBe('Reviewer Name'); // the audit trail
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(() => writeBackupFile(file, bundle)).toThrow(); // never overwritten
    });

    it('apply -> file -> rollback from the file gives back exactly the original table', async () => {
      const file = join(dir, 'backup.json');
      const before = snapshot();
      await reconcileNeverSent(
        deps({ writeBackup: async (b) => writeBackupFile(file, b) }),
        apply(),
      );
      expect(snapshot()).not.toBe(before);
      const report = await rollbackReconciliation({ repo }, readBackupFile(file), {
        apply: true,
        confirmation: ROLLBACK_CONFIRMATION,
      });
      expect(report.rolledBack).toBe(3);
      expect(snapshot()).toBe(before);
    });

    it('refuses a file that was edited after it was written', async () => {
      const file = join(dir, 'backup.json');
      await reconcileNeverSent(
        deps({ writeBackup: async (b) => writeBackupFile(file, b) }),
        apply(),
      );
      chmodSync(file, 0o600);
      writeFileSync(
        file,
        readFileSync(file, 'utf8')
          .replace('"ORA-01745"', '"ORA-00001"')
          .replace('ORA-01745', 'ORA-00001'),
      );
      expect(() => readBackupFile(file)).toThrow(ReconciliationRefusedError);
      writeFileSync(file, 'not json');
      expect(() => readBackupFile(file)).toThrow('cannot be read');
      expect(existsSync(file)).toBe(true);
    });

    it('a backup that cannot be written stops the whole run before any UPDATE', async () => {
      const before = snapshot();
      await expect(
        reconcileNeverSent(
          deps({
            writeBackup: async () => {
              throw new Error('disk full');
            },
          }),
          apply(),
        ),
      ).rejects.toThrow('disk full');
      expect(snapshot()).toBe(before);
    });
  });

  it('every statement passes the bind guard and nothing but SELECT / the two UPDATEs is issued', async () => {
    await reconcileNeverSent(deps(), apply());
    await rollbackReconciliation({ repo }, bundles[0], {
      apply: true,
      confirmation: ROLLBACK_CONFIRMATION,
    });
    expect(db.statements.some((s) => /DELETE|INSERT|DROP|ALTER/i.test(s))).toBe(false);
    expect(db.statements.filter((s) => /^\s*UPDATE/i.test(s)).length).toBe(6); // 3 restores + 3 rollbacks
  });
});
