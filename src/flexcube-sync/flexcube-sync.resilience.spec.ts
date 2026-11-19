import { Logger } from '@nestjs/common';
import { FakeFlexcubeDb, StagingRow } from '../../test/support/fake-flexcube-db';
import { CORPORATE_ROW, INDIVIDUAL_ROW, onboarded, SINCE } from '../../test/support/sync-fixtures';
import { FlexcubeKycSource } from '../flexcube/source/flexcube-kyc-source';
import { SqlBinds } from '../flexcube/staging/flexcube-staging';
import { InvalidSqlBindsError } from '../flexcube/staging/sql-binds';
import { StagingSubmissionRepository } from '../flexcube/staging/staging-submission.repository';
import { IKycWorkflow } from '../kyc/kyc.interfaces';
import { FlexcubeSyncScheduler } from './flexcube-sync.scheduler';
import {
  BREAKER_BASE_COOLDOWN_MS,
  classifyFailure,
  FlexcubeSyncService,
  SyncCycleError,
} from './flexcube-sync.service';

/**
 * Safety of the staging rows under failure (UAT1, 17/11/2026: a claim UPDATE with `:from` / `:to`
 * failed with ORA-01745 and the first design then turned 58 untouched rows into E). Rules tested:
 * a TECHNICAL failure (database, SQL, connection) never turns a row into E and never resends;
 * only a failure of the KYC itself closes its row; an uncertain delivery is never retried; a
 * circuit breaker stops repeating a systemic failure; logs carry no customer identifiers.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWN = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const T0 = Date.parse('2026-11-17T08:00:00Z');
const MIN = 60_000;

const isClaim = (sql: string) => sql.includes('REQ_DATE = SYSDATE');
const isRelease = (sql: string) => sql.includes('REQ_DATE = NULL');
const isMarkError = (sql: string) => sql.includes('PROCESS_STATUS IN (:sourceStatusNew');
const isComplete = (sql: string) => sql.includes('+ :retryIncrement');

describe('FlexcubeSyncService under failure', () => {
  let db: FakeFlexcubeDb;
  let workflow: { submit: jest.Mock };
  let now: number;
  let logged: {
    error: Record<string, unknown>[];
    warn: Record<string, unknown>[];
    log: Record<string, unknown>[];
  };

  const service = (over: { batch?: number } = {}) =>
    new FlexcubeSyncService(
      new FlexcubeKycSource(db, 'STAGE', SINCE),
      new StagingSubmissionRepository(db, 'STAGE'),
      workflow as unknown as IKycWorkflow,
      over.batch ?? 20,
      { now: () => now },
    );

  /** An open individual KYC with its detail rows. */
  const addKyc = (ref: string, type: 'R' | 'C' = 'R', mod = 1) => {
    db.master.push({ KYC_REF_NO: ref, KYC_CUST_TYPE: type, MOD_NO: mod, AUTH_STAT: 'A' });
    db.details.set(ref, type === 'R' ? INDIVIDUAL_ROW : CORPORATE_ROW);
    db.products.set(ref, ['SALR']);
  };
  const row = (ref: string, seq = 1) =>
    db.staging.find((r) => r.KYC_REF_NO === ref && r.SEQ_NO === seq)!;
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
  const failing = (code: string) => new Error(`${code}: message with SECRET detail`);

  beforeEach(() => {
    db = new FakeFlexcubeDb();
    workflow = { submit: jest.fn().mockResolvedValue(onboarded()) };
    now = T0;
    logged = { error: [], warn: [], log: [] };
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
      logged.error.push(m as Record<string, unknown>);
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => {
      logged.warn.push(m as Record<string, unknown>);
    });
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
      logged.log.push(m as Record<string, unknown>);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  describe('a technical failure at the claim never damages a row (ORA-01745 on UAT1)', () => {
    it.each([
      ['ORA-01745', 'invalid host/bind variable name (UAT1)'],
      ['ORA-02290', 'CHECK constraint on PROCESS_STATUS'],
      ['ORA-01031', 'insufficient privileges'],
      ['ORA-00942', 'table or view does not exist'],
      ['ORA-03113', 'connection lost during the claim'],
      ['NJS-503', 'cannot connect'],
    ])('%s (%s): rows stay N, nothing becomes E, nothing is sent', async (code) => {
      for (const ref of ['K1', 'K2', 'K3', 'K4', 'K5']) addKyc(ref);
      db.executeHook = (sql) => (isClaim(sql) ? failing(code) : undefined);

      expect(await service().runOnce()).toEqual({ found: 5, sent: 0, failed: 3, skipped: 0 });

      // the breaker opened after 3 technical failures: K4 and K5 were not even touched
      expect(db.staging.map((r) => [r.KYC_REF_NO, r.PROCESS_STATUS])).toEqual([
        ['K1', 'N'],
        ['K2', 'N'],
        ['K3', 'N'],
      ]);
      expect(db.staging.every((r) => r.REQ_DATE === undefined && r.RETRY_COUNT === 0)).toBe(true);
      expect(db.staging.every((r) => r.RESPONSE === null && r.REQUEST === null)).toBe(true);
      expect(db.statements.some(isMarkError)).toBe(false); // fail() (-> E) was never issued
      expect(workflow.submit).not.toHaveBeenCalled();
      expect(logged.error.filter((l) => l.event === 'flexcube.sync.kycFailed')).toEqual([
        expect.objectContaining({
          step: 'claim',
          kind: 'technical',
          action: 'row_left_new',
          error: code,
        }),
        expect.objectContaining({
          step: 'claim',
          kind: 'technical',
          action: 'row_left_new',
          error: code,
        }),
        expect.objectContaining({
          step: 'claim',
          kind: 'technical',
          action: 'row_left_new',
          error: code,
        }),
      ]);
      expect(logged.error.filter((l) => l.event === 'flexcube.sync.circuitOpened')).toHaveLength(1);
    });

    it('waits while the breaker is open (no database access), then recovers the N rows exactly once', async () => {
      for (const ref of ['K1', 'K2', 'K3', 'K4']) addKyc(ref);
      db.executeHook = (sql) => (isClaim(sql) ? failing('ORA-01745') : undefined);
      const sync = service();
      await sync.runOnce();
      expect(sync.getStatus().circuitOpenUntil).not.toBeNull();

      // inside the cooldown: nothing is read or written, a clear log says why
      now = T0 + MIN;
      const before = db.statements.length;
      expect(await sync.runOnce()).toEqual({ found: 0, sent: 0, failed: 0, skipped: 0 });
      expect(db.statements).toHaveLength(before);
      expect(logged.warn.at(-1)).toMatchObject({
        event: 'flexcube.sync.circuitOpen',
        lastError: 'ORA-01745',
      });

      // after the cooldown, with the fault fixed: the 3 N rows are recovered, K4 is new
      db.executeHook = null;
      now = T0 + BREAKER_BASE_COOLDOWN_MS + 1;
      expect(await sync.runOnce()).toEqual({ found: 4, sent: 4, failed: 0, skipped: 0 });
      expect(db.staging.map((r) => r.PROCESS_STATUS)).toEqual(['S', 'S', 'S', 'S']);
      expect(workflow.submit).toHaveBeenCalledTimes(4); // once per KYC, never twice
      expect(sync.getStatus()).toMatchObject({
        consecutiveTechnicalFailures: 0,
        circuitOpenUntil: null,
      });
    });

    it('a probe that fails again reopens the breaker with a doubled cooldown', async () => {
      for (const ref of ['K1', 'K2', 'K3', 'K4']) addKyc(ref);
      db.executeHook = (sql) => (isClaim(sql) ? failing('ORA-02290') : undefined);
      const sync = service();
      await sync.runOnce();
      now = T0 + BREAKER_BASE_COOLDOWN_MS + 1;
      await sync.runOnce(); // the probe fails at once
      const opened = logged.error.filter((l) => l.event === 'flexcube.sync.circuitOpened');
      expect(opened.map((l) => l.cooldownMs)).toEqual([
        BREAKER_BASE_COOLDOWN_MS,
        2 * BREAKER_BASE_COOLDOWN_MS,
      ]);
      expect(db.staging.every((r) => r.PROCESS_STATUS === 'N')).toBe(true);
    });

    it('an insert failure leaves no row and counts as technical', async () => {
      addKyc('K1');
      db.executeHook = (sql) => (sql.startsWith('INSERT') ? failing('ORA-00942') : undefined);
      expect(await service().runOnce()).toMatchObject({ failed: 1 });
      expect(db.staging).toEqual([]);
      expect(logged.error[0]).toMatchObject({
        step: 'insert',
        kind: 'technical',
        action: 'no_row',
      });
    });
  });

  describe('a technical failure after the claim gives the claim back (never E, never resent)', () => {
    it('an Oracle error while reading the KYC releases W -> N', async () => {
      addKyc('K1');
      db.queryHook = (sql) =>
        sql.includes('FROM STTM_KYC_RETAIL r') ? failing('ORA-00942') : undefined;
      const sync = service();
      expect(await sync.runOnce()).toMatchObject({ failed: 1, sent: 0 });
      expect(row('K1')).toMatchObject({
        PROCESS_STATUS: 'N',
        REQUEST: null,
        RESPONSE: null,
        RETRY_COUNT: 0,
      });
      expect(row('K1').REQ_DATE).toBeUndefined();
      expect(logged.error[0]).toMatchObject({
        step: 'load',
        kind: 'technical',
        action: 'row_released',
      });
      expect(workflow.submit).not.toHaveBeenCalled();

      // the next pass recovers it (same row, no second INSERT) and sends it once
      db.queryHook = null;
      expect(await sync.runOnce()).toMatchObject({ found: 1, sent: 1 });
      expect(db.staging).toHaveLength(1);
      expect(row('K1').PROCESS_STATUS).toBe('S');
      expect(workflow.submit).toHaveBeenCalledTimes(1);
    });

    it('if the release fails too the row stays in progress: reported once as stuck, never resent', async () => {
      addKyc('K1');
      db.queryHook = (sql) =>
        sql.includes('FROM STTM_KYC_RETAIL r') ? failing('ORA-00942') : undefined;
      db.executeHook = (sql) => (isRelease(sql) ? failing('ORA-02290') : undefined);
      const sync = service();
      await sync.runOnce();
      expect(row('K1').PROCESS_STATUS).toBe('W');
      expect(logged.error[0]).toMatchObject({ action: 'release_failed' });

      db.queryHook = null;
      db.executeHook = null;
      row('K1').AGE_MIN = 20;
      await sync.runOnce();
      await sync.runOnce();
      expect(workflow.submit).not.toHaveBeenCalled();
      expect(row('K1').PROCESS_STATUS).toBe('W');
      expect(logged.warn.filter((l) => l.event === 'flexcube.sync.stuckInProgress')).toEqual([
        expect.objectContaining({ newlyReported: 1, total: 1, olderThanMinutes: 15 }),
      ]);
    });

    it('a key-person query error on a corporate KYC is technical: released, not E, individuals still flow', async () => {
      addKyc('KC', 'C');
      addKyc('K1');
      db.queryHook = (sql) =>
        sql.includes('LEFT JOIN STTM_KYC_CORP_KEYPERSONS_CUSTOM')
          ? failing('ORA-00904')
          : undefined;
      expect(await service().runOnce()).toEqual({ found: 2, sent: 1, failed: 1, skipped: 0 });
      expect(row('KC')).toMatchObject({ PROCESS_STATUS: 'N', RESPONSE: null });
      expect(row('K1').PROCESS_STATUS).toBe('S');
      expect(logged.error[0]).toMatchObject({
        step: 'load',
        kind: 'technical',
        error: 'ORA-00904',
      });
    });
  });

  describe('only a failure of the KYC itself (or an uncertain delivery) closes its row as E', () => {
    it('missing KYC details are a data failure: E with the technical code', async () => {
      addKyc('K1');
      db.details.delete('K1');
      expect(await service().runOnce()).toMatchObject({ failed: 1 });
      expect(row('K1')).toMatchObject({
        PROCESS_STATUS: 'E',
        RESPONSE: JSON.stringify({ error: 'KycDetailsNotFoundError' }),
        RETRY_COUNT: 1,
      });
      expect(logged.error[0]).toMatchObject({
        step: 'load',
        kind: 'data',
        action: 'row_marked_error',
      });
    });

    it('marking E fails too: logged, the pass continues, the row is not left half-changed', async () => {
      addKyc('K1');
      addKyc('K2');
      db.details.delete('K1');
      db.executeHook = (sql) => (isMarkError(sql) ? failing('ORA-02290') : undefined);
      expect(await service().runOnce()).toEqual({ found: 2, sent: 1, failed: 1, skipped: 0 });
      expect(row('K1').PROCESS_STATUS).toBe('W'); // visible as stuck after 15 minutes
      expect(row('K2').PROCESS_STATUS).toBe('S');
      expect(logged.error[0]).toMatchObject({
        kind: 'data',
        action: 'mark_error_failed',
        error: 'KycDetailsNotFoundError',
      });
    });

    it('an unexpected exception from the submission is an uncertain delivery: E, never retried', async () => {
      addKyc('K1');
      workflow.submit.mockRejectedValueOnce(new TypeError('socket hang up'));
      const sync = service();
      await sync.runOnce();
      expect(row('K1')).toMatchObject({
        PROCESS_STATUS: 'E',
        RESPONSE: JSON.stringify({ error: 'TypeError', delivery: 'UNCERTAIN' }),
      });
      expect(logged.error[0]).toMatchObject({ step: 'submit', kind: 'uncertain' });
      await sync.runOnce();
      await sync.runOnce();
      expect(workflow.submit).toHaveBeenCalledTimes(1); // no blind resend
    });

    it('REIS answered but the result cannot be stored: the row stays in progress, not E, not resent', async () => {
      addKyc('K1');
      db.executeHook = (sql) => (isComplete(sql) ? failing('ORA-01400') : undefined);
      const sync = service();
      expect(await sync.runOnce()).toMatchObject({ failed: 1 });
      expect(row('K1').PROCESS_STATUS).toBe('W');
      expect(logged.error[0]).toMatchObject({
        step: 'complete',
        kind: 'recording',
        action: 'row_left_in_progress',
      });
      db.executeHook = null;
      await sync.runOnce();
      expect(workflow.submit).toHaveBeenCalledTimes(1);
      expect(db.statements.some(isMarkError)).toBe(false);
    });

    it('a workflow FAILED / DUPLICATE result still closes the row as E with its stage', async () => {
      addKyc('K1');
      workflow.submit.mockResolvedValue({
        outcome: 'FAILED',
        stage: 'VALIDATION',
        code: 'UNMAPPED_REFERENCE',
      });
      await service().runOnce();
      expect(row('K1')).toMatchObject({
        PROCESS_STATUS: 'E',
        RESPONSE: JSON.stringify({ error: 'UNMAPPED_REFERENCE', stage: 'VALIDATION' }),
      });
    });

    it('a REIS timeout (delivery uncertain) closes the row as E and is never resent by the poller', async () => {
      addKyc('K1');
      workflow.submit.mockResolvedValue({
        outcome: 'FAILED',
        stage: 'ONBOARDING',
        code: 'DELIVERY_UNCERTAIN',
      });
      const sync = service();
      expect(await sync.runOnce()).toMatchObject({ failed: 1, sent: 0 });
      expect(row('K1')).toMatchObject({
        PROCESS_STATUS: 'E',
        RESPONSE: JSON.stringify({ error: 'DELIVERY_UNCERTAIN', stage: 'ONBOARDING' }),
      });
      await sync.runOnce();
      await sync.runOnce();
      expect(workflow.submit).toHaveBeenCalledTimes(1);
    });

    it('classification table', () => {
      const ora = new Error('ORA-00942: x');
      expect(classifyFailure('insert', new Error('x'))).toBe('technical');
      expect(classifyFailure('claim', ora)).toBe('technical');
      expect(classifyFailure('load', ora)).toBe('technical');
      expect(classifyFailure('load', new Error('missing'))).toBe('data');
      expect(classifyFailure('load', new InvalidSqlBindsError(['x']))).toBe('technical');
      expect(classifyFailure('submit', ora)).toBe('uncertain');
      expect(classifyFailure('complete', ora)).toBe('recording');
    });
  });

  describe('restart during processing, MOD_NO changes and parallel instances', () => {
    it('a crash after the INSERT (row N): the restarted service recovers and sends it exactly once', async () => {
      addKyc('K1');
      db.staging.push(own('K1'));
      expect(await service().runOnce()).toMatchObject({ found: 1, sent: 1 });
      expect(await service().runOnce()).toMatchObject({ found: 0 });
      expect(workflow.submit).toHaveBeenCalledTimes(1);
      expect(db.staging).toHaveLength(1);
    });

    it('a crash after the claim (row W): the restarted service never resends it, only reports it', async () => {
      addKyc('K1');
      db.staging.push(own('K1', { PROCESS_STATUS: 'W', REQ_DATE: 'SYSDATE', AGE_MIN: 30 }));
      const restarted = service();
      expect(await restarted.runOnce()).toMatchObject({ found: 0, sent: 0 });
      expect(workflow.submit).not.toHaveBeenCalled();
      expect(row('K1')).toMatchObject({ PROCESS_STATUS: 'W' });
      expect(logged.warn.filter((l) => l.event === 'flexcube.sync.stuckInProgress')).toHaveLength(
        1,
      );
    });

    it('a new MOD_NO is a new submission (SEQ_NO); the old one is never resent', async () => {
      addKyc('K1');
      const sync = service();
      await sync.runOnce();
      db.master[0].MOD_NO = 2;
      expect(await sync.runOnce()).toMatchObject({ found: 1, sent: 1 });
      expect(await sync.runOnce()).toMatchObject({ found: 0 });
      expect(workflow.submit.mock.calls.map((c) => c[1])).toEqual([{ seqNo: 1 }, { seqNo: 2 }]);
      expect(db.staging.map((r) => [r.SEQ_NO, r.PROCESS_STATUS])).toEqual([
        [1, 'S'],
        [2, 'S'],
      ]);
    });

    it('two instances at the same time send every KYC once (insert and claim are conditional)', async () => {
      for (const ref of ['K1', 'K2', 'K3']) addKyc(ref);
      const [a, b] = await Promise.all([service().runOnce(), service().runOnce()]);
      expect(a.sent + b.sent).toBe(3);
      expect(workflow.submit).toHaveBeenCalledTimes(3);
      expect(db.staging.map((r) => r.PROCESS_STATUS)).toEqual(['S', 'S', 'S']);
    });

    it('never touches a row that is not ours (Finexta TEST123), even at N', async () => {
      addKyc('TEST123');
      db.staging.push(own('TEST123', { MSGID: 'TEST123' }));
      expect(await service().runOnce()).toEqual({ found: 0, sent: 0, failed: 0, skipped: 0 });
      expect(workflow.submit).not.toHaveBeenCalled();
      expect(row('TEST123')).toMatchObject({
        PROCESS_STATUS: 'N',
        MSGID: 'TEST123',
      });
      expect(row('TEST123').REQ_DATE).toBeUndefined();
    });

    it('does not recover rows already claimed, holding a request, closed in E, or before the cut-off', async () => {
      for (const ref of ['K1', 'K2', 'K3', 'K4']) addKyc(ref);
      db.master[3].MAKER_DT_STAMP = '2026-05-01T00:00:00';
      db.staging.push(
        own('K1', { REQ_DATE: 'SYSDATE' }),
        own('K2', { REQUEST: '{"x":1}' }),
        own('K3', { PROCESS_STATUS: 'E', RESPONSE: '{"error":"x"}', RETRY_COUNT: 1 }),
        own('K4'),
      );
      expect(await service().runOnce()).toEqual({ found: 0, sent: 0, failed: 0, skipped: 0 });
      expect(workflow.submit).not.toHaveBeenCalled();
    });
  });

  describe('corporate KYCs need a proven key-person type column', () => {
    it('without the column no corporate KYC is selected: no row, no error, nothing sent', async () => {
      addKyc('KC', 'C');
      addKyc('K1');
      db.keypersonColumnPresent = false;
      const sync = service();
      expect(await sync.runOnce()).toEqual({ found: 1, sent: 1, failed: 0, skipped: 0 });
      expect(db.staging.map((r) => r.KYC_REF_NO)).toEqual(['K1']);
      expect(db.pendingCalls[0].sql).toContain("KYC_CUST_TYPE IN ('R')");
      await sync.runOnce();
      expect(logged.warn.filter((l) => l.event === 'flexcube.sync.corporateDisabled')).toEqual([
        expect.objectContaining({ reason: 'KEYPERSON_TYPE_COLUMN_NOT_FOUND' }),
      ]);
    });

    it('is re-checked every 10 minutes: once the column exists corporates are taken', async () => {
      addKyc('KC', 'C');
      db.keypersonColumnPresent = false;
      const sync = service();
      expect(await sync.runOnce()).toMatchObject({ found: 0 });
      db.keypersonColumnPresent = true;
      now = T0 + 5 * MIN;
      expect(await sync.runOnce()).toMatchObject({ found: 0 }); // cached
      now = T0 + 11 * MIN;
      expect(await sync.runOnce()).toMatchObject({ found: 1, sent: 1 });
      expect(db.pendingCalls.at(-1)!.sql).toContain("KYC_CUST_TYPE IN ('R', 'C')");
    });

    it('a failing metadata check disables corporates (safe default) and records the Oracle code', async () => {
      addKyc('KC', 'C');
      db.queryHook = (sql) =>
        sql.includes('FROM ALL_TAB_COLUMNS') ? failing('ORA-00942') : undefined;
      const source = new FlexcubeKycSource(db, 'STAGE', SINCE);
      expect(await source.refreshCorporateSupport(T0)).toBe(false);
      expect(source.corporateSupportReason).toBe('ORA-00942');
      expect(await source.findPending(10)).toEqual([]);
    });

    it('a configured column that does not exist is never replaced by another one', async () => {
      db.queryHook = (_sql, b) => (b.columnName === 'OWNERSHIP_TYPE' ? undefined : undefined);
      const source = new FlexcubeKycSource(db, 'STAGE', SINCE, 'KYC_KEYPERSON_TYPE');
      const seen: SqlBinds[] = [];
      jest.spyOn(db, 'query').mockImplementation(async (_s, b) => {
        seen.push(b);
        return [{ N: 0 }];
      });
      expect(await source.refreshCorporateSupport(T0)).toBe(false);
      expect(seen).toEqual([{ columnName: 'KYC_KEYPERSON_TYPE' }]);
      expect(source.corporateSupportReason).toBe('COLUMN_NOT_FOUND');
    });
  });

  describe('structured logs without customer data', () => {
    it('every pass logs runId, duration, counts and the last successful pass', async () => {
      addKyc('K1');
      const sync = service();
      await sync.runOnce();
      const run = logged.log.find((l) => l.event === 'flexcube.sync.run')!;
      expect(run).toMatchObject({
        found: 1,
        sent: 1,
        failed: 0,
        skipped: 0,
        technicalFailures: 0,
        recovered: 0,
      });
      expect(String(run.runId)).toMatch(UUID);
      expect(typeof run.durationMs).toBe('number');
      expect(run.lastSuccessfulRunAt).toBe(new Date(T0).toISOString());
      expect(sync.getStatus()).toMatchObject({
        lastRunAt: new Date(T0).toISOString(),
        lastSuccessfulRunAt: new Date(T0).toISOString(),
      });
    });

    it('a pass with technical failures is not a successful pass', async () => {
      addKyc('K1');
      const sync = service();
      await sync.runOnce(); // success at T0
      addKyc('K2');
      now = T0 + 2 * MIN;
      db.executeHook = (sql) => (isClaim(sql) ? failing('ORA-01745') : undefined);
      await sync.runOnce();
      expect(sync.getStatus().lastSuccessfulRunAt).toBe(new Date(T0).toISOString());
      expect(sync.getStatus().lastRunAt).toBe(new Date(T0 + 2 * MIN).toISOString());
    });

    it('never logs a KYC reference, a name, a payload, a message, SQL or a bind value', async () => {
      for (const ref of ['KYC-SECRET-9', 'KYC-SECRET-8', 'KYC-SECRET-7']) addKyc(ref);
      db.executeHook = (sql) => (isClaim(sql) ? failing('ORA-02290') : undefined);
      const sync = service();
      await sync.runOnce();
      db.executeHook = null;
      workflow.submit.mockRejectedValueOnce(new Error('Testfirst Testlast leaked'));
      now = T0 + BREAKER_BASE_COOLDOWN_MS + 1;
      await sync.runOnce();
      const text = JSON.stringify(logged);
      expect(text).not.toMatch(
        /KYC-SECRET|SECRET detail|Testfirst|Testlast|amgr|UPDATE|SELECT|STAGE|:kycRefNo/,
      );
      expect(logged.error.length).toBeGreaterThan(0);
      for (const l of [...logged.error, ...logged.warn, ...logged.log]) {
        expect(l).not.toHaveProperty('kycRefNo');
        expect(l).not.toHaveProperty('seqNo');
      }
    });

    it('a failing pending query raises a SyncCycleError with the run id, phase, duration and code only', async () => {
      addKyc('K1');
      db.queryHook = (sql) =>
        sql.includes('FROM STTM_KYC_MASTER m') && !sql.includes('s.REQ_DATE IS NULL')
          ? failing('ORA-12541')
          : undefined;
      const sync = service();
      const err = await sync.runOnce().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SyncCycleError);
      expect(err).toMatchObject({ phase: 'pending', code: 'ORA-12541' });
      expect(String((err as SyncCycleError).runId)).toMatch(UUID);
      expect((err as Error).message).not.toContain('SECRET');

      const scheduler = new FlexcubeSyncScheduler(sync, 60_000);
      await scheduler.tick();
      expect(logged.error.at(-1)).toMatchObject({
        event: 'flexcube.sync.failed',
        phase: 'pending',
        error: 'ORA-12541',
        runId: expect.stringMatching(UUID),
        durationMs: expect.any(Number),
      });
      await scheduler.onModuleDestroy();
    });

    it('repeated pending-query failures open the breaker so the same fault is not hammered', async () => {
      db.queryHook = (sql) =>
        sql.includes('FROM STTM_KYC_MASTER m') && !sql.includes('s.REQ_DATE IS NULL')
          ? failing('ORA-12541')
          : undefined;
      const sync = service();
      for (let i = 0; i < 3; i++) await sync.runOnce().catch(() => undefined);
      expect(logged.error.filter((l) => l.event === 'flexcube.sync.circuitOpened')).toHaveLength(1);
      const before = db.statements.length;
      expect(await sync.runOnce()).toMatchObject({ found: 0 });
      expect(db.statements).toHaveLength(before);
    });
  });

  describe('SQL bind variables (ORA-01745 can not come back)', () => {
    it('the fake database, like the Oracle executor, rejects reserved-word binds before running them', async () => {
      await expect(
        db.execute('UPDATE T SET S = :to WHERE S = :from', { to: 'W', from: 'N' }),
      ).rejects.toBeInstanceOf(InvalidSqlBindsError);
      await expect(
        db.query('SELECT 1 FROM T WHERE A = :a', { a: 1, extra: 2 }),
      ).rejects.toBeInstanceOf(InvalidSqlBindsError);
    });

    it('every statement of a full pass (all repository methods and source queries) passes the guard', async () => {
      addKyc('K1');
      addKyc('KC', 'C');
      addKyc('K2');
      db.staging.push(own('K3'));
      db.master.push({ KYC_REF_NO: 'K3', KYC_CUST_TYPE: 'R', MOD_NO: 1, AUTH_STAT: 'A' });
      db.details.set('K3', INDIVIDUAL_ROW);
      db.products.set('K3', ['SALR']);
      db.details.delete('K2'); // fail()
      workflow.submit.mockResolvedValueOnce(onboarded()).mockResolvedValueOnce({
        outcome: 'FAILED',
        stage: 'VALIDATION',
        code: 'X',
      });
      await service().runOnce(); // insert, claim, complete S / E, fail, release paths, stuck + recovery queries
      expect(db.statements.length).toBeGreaterThan(10);
      expect(workflow.submit).toHaveBeenCalled();
    });
  });
});
