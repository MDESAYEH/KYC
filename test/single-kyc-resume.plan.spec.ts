import { createTestDataSource } from './support/test-database';
import {
  assertResumeApproval,
  planSingleKycResume,
  ReisAbsenceConfirmation,
  ResumeApproval,
  ResumeSnapshot,
} from '../src/tools/single-kyc-resume.plan';
import { SINGLE_KYC_TRIAL as TARGET, trialHash } from '../src/tools/single-kyc-trial.contract';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const state = (): ResumeSnapshot => ({
  cif: TARGET.expectedCif,
  kycRefNo: TARGET.kycRefNo,
  seqNo: 1,
  modNo: 1,
  msgId: 'synthetic-msg-id',
  processStatus: 'E',
  readyToScan: 'E',
  reisFinalStatus: null,
  request: '{"synthetic":"request"}',
  response: '{"wire":null,"delivery":"UNCERTAIN"}',
  payloadSha256: trialHash('synthetic payload'),
  stateSha256: trialHash('full synthetic snapshot'),
  open: true,
  higherRevisionExists: false,
  callbackCount: 0,
  reservationId: null,
  attempts: [
    { id: 'attempt-one', evidenceSha256: trialHash('original attempt one') },
    { id: 'attempt-two', evidenceSha256: trialHash('original attempt two') },
  ],
});
const confirmation = (s: ResumeSnapshot): ReisAbsenceConfirmation => ({
  reference: 'synthetic-provider-ticket',
  confirmedBy: 'Synthetic REIS Operator',
  confirmedAt: new Date(NOW).toISOString(),
  documentSha256: trialHash('synthetic signed document'),
  cif: s.cif,
  kycRefNo: s.kycRefNo,
  seqNo: s.seqNo,
  attempts: structuredClone(s.attempts),
  noOnboardingCreated: true,
  noOnboardingProcessed: true,
});
const plan = (s = state()) => planSingleKycResume(s, confirmation(s), NOW);
const approval = (p: ReturnType<typeof plan>): ResumeApproval => ({
  approvedBy: 'Synthetic Bank Operator',
  approvedAt: new Date(NOW).toISOString(),
  planSha256: p.planSha256,
  executionApproved: true,
});

describe('offline resume policy; synthetic evidence only, no Oracle or HTTP', () => {
  it('pins both historical attempts and never authorizes sending by planning', () => {
    const p = plan();
    expect(p.sendingAuthorized).toBe(false);
    expect(p.plan.snapshot.attempts).toHaveLength(2);
    expect(() => assertResumeApproval(p, state(), approval(p), NOW)).not.toThrow();
  });
  it.each([
    { modNo: 2 },
    { seqNo: 2 },
    { cif: 'another-cif' },
    { kycRefNo: 'another-kyc' },
    { readyToScan: 'U' },
    { processStatus: 'S' },
    { reisFinalStatus: 'CLEAN' },
    { open: false },
    { higherRevisionExists: true },
    { request: '' },
    { response: '' },
    { callbackCount: 1 },
    { reservationId: 'reserved-before-crash' },
    { attempts: [] },
  ])('refuses changed or unsafe state %j', (over) => {
    const s = { ...state(), ...over };
    expect(() => plan(s)).toThrow();
  });
  it.each([
    { noOnboardingCreated: false },
    { noOnboardingProcessed: false },
    { reference: '' },
    { documentSha256: '' },
    { confirmedBy: '' },
    { confirmedAt: 'invalid' },
    { confirmedAt: new Date(NOW - 3_600_001).toISOString() },
    { confirmedAt: new Date(NOW + 1).toISOString() },
    { cif: 'different-cif' },
    { seqNo: 2 },
    { attempts: [state().attempts[0]] },
  ])('requires fresh documented REIS absence for BOTH attempts %j', (over) => {
    const s = state();
    expect(() => planSingleKycResume(s, { ...confirmation(s), ...over }, NOW)).toThrow();
  });
  it('rejects a confirmation for different evidence with the same attempt identifiers', () => {
    const s = state(),
      c = confirmation(s);
    c.attempts[1].evidenceSha256 = trialHash('different evidence');
    expect(() => planSingleKycResume(s, c, NOW)).toThrow('SCOPE_MISMATCH');
  });
  it.each([
    { payloadSha256: trialHash('changed payload') },
    { stateSha256: trialHash('new audit') },
    { response: 'changed response' },
    { msgId: 'replacement-row' },
    { callbackCount: 1 },
    { modNo: 2 },
  ])('invalidates approval after any pinned state changes %j', (over) => {
    const p = plan();
    expect(() => assertResumeApproval(p, { ...state(), ...over }, approval(p), NOW)).toThrow();
  });
  it.each([
    { executionApproved: false },
    { approvedBy: '' },
    { planSha256: trialHash('wrong plan') },
    { approvedAt: new Date(NOW - 3_600_001).toISOString() },
  ])('requires separate explicit execution approval %j', (over) => {
    const p = plan();
    expect(() => assertResumeApproval(p, state(), { ...approval(p), ...over }, NOW)).toThrow();
  });
});

describe('isolated SQLite reservation experiment (NOT a production recovery adapter)', () => {
  let ds: Awaited<ReturnType<typeof createTestDataSource>>;
  beforeEach(async () => {
    ds = await createTestDataSource();
    await ds.query(
      'CREATE TABLE resume_reservation (scope TEXT PRIMARY KEY, plan_hash TEXT NOT NULL)',
    );
    await ds.query('CREATE TABLE resume_history (id INTEGER PRIMARY KEY, evidence TEXT NOT NULL)');
    for (const a of state().attempts)
      await ds.query('INSERT INTO resume_history(evidence) VALUES (?)', [JSON.stringify(a)]);
  });
  afterEach(async () => {
    await ds.destroy();
  });
  async function reserve(s = state(), failBackup = false) {
    const p = plan();
    await ds.transaction(async (tx) => {
      assertResumeApproval(p, s, approval(p), NOW);
      await tx.query('INSERT INTO resume_reservation(scope, plan_hash) VALUES (?, ?)', [
        `${s.cif}:${s.kycRefNo}:${s.seqNo}`,
        p.planSha256,
      ]);
      if (failBackup) throw Error('durable evidence write failed');
      await tx.query('INSERT INTO resume_history(evidence) VALUES (?)', [JSON.stringify(p)]);
    });
  }
  it('consumes approval once and preserves the original attempts byte for byte', async () => {
    const before = await ds.query('SELECT * FROM resume_history');
    await reserve();
    await expect(reserve()).rejects.toBeDefined();
    expect(await ds.query('SELECT * FROM resume_history WHERE id <= 2')).toEqual(before);
    expect(await ds.query('SELECT * FROM resume_reservation')).toHaveLength(1);
  });
  it('a new repository/caller after crash cannot acquire a second reservation', async () => {
    await reserve(); // simulate crash before HTTP or after lost response; do not release
    await expect(reserve()).rejects.toBeDefined();
  });
  it('backup failure rolls back reservation and creates no new attempt', async () => {
    await expect(reserve(state(), true)).rejects.toThrow('durable evidence');
    expect(await ds.query('SELECT * FROM resume_reservation')).toHaveLength(0);
    expect(await ds.query('SELECT * FROM resume_history')).toHaveLength(2);
  });
  it.each([{ modNo: 2 }, { callbackCount: 1 }])(
    'version/callback change before reservation blocks everything %j',
    async (over) => {
      await expect(reserve({ ...state(), ...over })).rejects.toThrow();
      expect(await ds.query('SELECT * FROM resume_reservation')).toHaveLength(0);
      expect(await ds.query('SELECT * FROM resume_history')).toHaveLength(2);
    },
  );
});
