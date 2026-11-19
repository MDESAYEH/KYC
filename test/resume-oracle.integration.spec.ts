import { randomBytes } from 'node:crypto';
import { assertDisposableDatabase, isolatedOracleConfig } from './support/isolated-oracle';
import { OracleSqlExecutor } from '../src/flexcube/staging/oracle-sql-executor';
import {
  ResumeOracleAdapter,
  resumeReceiptDdl,
  resumeReceiptProtectionDdl,
} from '../src/resume/resume-oracle.adapter';
import { SINGLE_KYC_TRIAL as TARGET, trialHash } from '../src/tools/single-kyc-trial.contract';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/persistence/database.config';
import { TypeOrmKycCaseRepository } from '../src/persistence/typeorm-kyc-case.repository';
import { TypeOrmWebhookEventRepository } from '../src/persistence/typeorm-webhook-event.repository';
import { CustomerType } from '../src/canonical';
import { ResumeJournal } from '../src/resume/resume-journal';
import {
  ResumeCoordinator,
  buildResumeBundle,
  ResumeExecutionApproval,
  ResumePorts,
} from '../src/resume/resume-coordinator';
import { CustomerStatusService } from '../src/webhook/customer-status.service';
import { ReisOnboardingRequest } from '../src/reis/dto';

const cfg = isolatedOracleConfig(
  'KYC_RESUME_ORACLE_TEST',
  'CREATE_AND_DROP_ISOLATED_RESUME_TABLES',
);
(cfg ? describe : describe.skip)('resume adapter on REAL disposable Oracle (no REIS)', () => {
  const suffix = randomBytes(4).toString('hex').toUpperCase();
  const names = {
    customer: `KRR_C_${suffix}`,
    master: `KRR_M_${suffix}`,
    trigger: `KRR_T_${suffix}`,
    stage: `KRR_S_${suffix}`,
    receipt: `KRR_R_${suffix}`,
  };
  let db: OracleSqlExecutor, adapter: ResumeOracleAdapter;
  const created: string[] = [];
  const key = { cif: TARGET.expectedCif, kycRefNo: TARGET.kycRefNo, seqNo: 1 };
  beforeAll(async () => {
    db = new OracleSqlExecutor(cfg!);
    await assertDisposableDatabase(db);
    const definitions = [
      `CREATE TABLE ${names.customer}(CUSTOMER_NO VARCHAR2(64) PRIMARY KEY, MOD_NO NUMBER)`,
      `CREATE TABLE ${names.master}(KYC_REF_NO VARCHAR2(64) PRIMARY KEY, RECORD_STAT CHAR(1))`,
      `CREATE TABLE ${names.trigger}(CUSTOMER_NO VARCHAR2(64), KYC_REF_NO VARCHAR2(64), READY_TO_SCAN CHAR(1), PRIMARY KEY(CUSTOMER_NO,KYC_REF_NO))`,
      `CREATE TABLE ${names.stage}(KYC_REF_NO VARCHAR2(64),SEQ_NO NUMBER,MSGID VARCHAR2(64),PROCESS_STATUS CHAR(1) CHECK(PROCESS_STATUS IN ('E','W','S')),REQUEST CLOB,RESPONSE CLOB,REIS_FINAL_STATUS VARCHAR2(20),RETRY_COUNT NUMBER,REQ_DATE DATE,RES_DATE DATE,PRIMARY KEY(KYC_REF_NO,SEQ_NO))`,
      resumeReceiptDdl(names.receipt),
    ];
    for (const [i, ddl] of definitions.entries()) {
      await db.execute(ddl, {});
      created.push(Object.values(names)[i]);
    }
    adapter = new ResumeOracleAdapter(db, names);
  }, 30_000);
  afterAll(async () => {
    for (const table of created.reverse()) await db.execute(`DROP TABLE ${table} PURGE`, {});
    await db?.onModuleDestroy();
  });
  beforeEach(async () => {
    for (const table of Object.values(names)) await db.execute(`DELETE FROM ${table}`, {});
    await db.execute(`INSERT INTO ${names.customer} VALUES (:cif,1)`, { cif: key.cif });
    await db.execute(`INSERT INTO ${names.master} VALUES (:kycRefNo,'O')`, {
      kycRefNo: key.kycRefNo,
    });
    await db.execute(`INSERT INTO ${names.trigger} VALUES (:cif,:kycRefNo,'E')`, {
      cif: key.cif,
      kycRefNo: key.kycRefNo,
    });
    await db.execute(
      `INSERT INTO ${names.stage} VALUES (:kycRefNo,1,'original-msg','E',:requestJson,:responseJson,NULL,2,SYSDATE-1,SYSDATE-1)`,
      {
        kycRefNo: key.kycRefNo,
        requestJson: '{"synthetic":"previous request"}',
        responseJson: '{"delivery":"UNCERTAIN"}',
      },
    );
  });
  it('claims once under simultaneous callers and a new adapter cannot claim again', async () => {
    const before = await adapter.read();
    const results = await Promise.allSettled([
      adapter.claim(before, 'resume-one', 'plan-hash'),
      adapter.claim(before, 'resume-two', 'plan-hash'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.query(`SELECT * FROM ${names.receipt}`, {})).toHaveLength(1);
    await expect(
      new ResumeOracleAdapter(db, names).claim(before, 'resume-three', 'hash'),
    ).rejects.toBeDefined();
    const receipt = (await db.query(`SELECT ORIGINAL_SNAPSHOT FROM ${names.receipt}`, {}))[0];
    expect(JSON.parse(String(receipt.ORIGINAL_SNAPSHOT))).toEqual(before);
    expect((await adapter.read()).stage.RETRY_COUNT).toBe(3);
  });
  it.each(['MOD_NO', 'MSGID', 'RESPONSE', 'FINAL', 'TRIGGER', 'MASTER'])(
    'rejects drift in %s with no partial writes',
    async (field) => {
      const before = await adapter.read();
      const updates: Record<string, string> = {
        MOD_NO: `UPDATE ${names.customer} SET MOD_NO=2`,
        MSGID: `UPDATE ${names.stage} SET MSGID='changed'`,
        RESPONSE: `UPDATE ${names.stage} SET RESPONSE='changed'`,
        FINAL: `UPDATE ${names.stage} SET REIS_FINAL_STATUS='CLEAN'`,
        TRIGGER: `UPDATE ${names.trigger} SET READY_TO_SCAN='U'`,
        MASTER: `UPDATE ${names.master} SET RECORD_STAT='C'`,
      };
      await db.execute(updates[field], {});
      await expect(adapter.claim(before, 'resume-one', 'hash')).rejects.toBeDefined();
      expect(await db.query(`SELECT * FROM ${names.receipt}`, {})).toHaveLength(0);
      expect((await adapter.read()).stage.PROCESS_STATUS).toBe('E');
    },
  );
  it('rolls back receipt, staging and trigger together on a real Oracle constraint error', async () => {
    const before = await adapter.read();
    await db.execute(
      `ALTER TABLE ${names.trigger} ADD CONSTRAINT KRR_FAIL_${suffix} CHECK(READY_TO_SCAN <> 'P')`,
      {},
    );
    try {
      await expect(adapter.claim(before, 'resume-one', 'hash')).rejects.toBeDefined();
    } finally {
      await db.execute(`ALTER TABLE ${names.trigger} DROP CONSTRAINT KRR_FAIL_${suffix}`, {});
    }
    expect(await adapter.read()).toEqual(before);
    expect(await db.query(`SELECT * FROM ${names.receipt}`, {})).toHaveLength(0);
  });
  it('saves PENDING from actual captured wire, preserves revision and recovers writeback idempotently', async () => {
    await adapter.claim(await adapter.read(), 'resume-one', 'hash');
    await adapter.prepareDispatch('resume-one', { systemId: key.cif });
    const wire = { status: 200, body: '{"status":"PENDING"}' };
    await adapter.withDispatchFence('resume-one', async () => undefined);
    await adapter.writeback('resume-one', wire, false);
    await new ResumeOracleAdapter(db, names).writeback('resume-one', wire, false);
    expect(await adapter.read()).toMatchObject({
      modNo: 1,
      readyToScan: 'P',
      stage: { SEQ_NO: 1, PROCESS_STATUS: 'S', REIS_FINAL_STATUS: 'PENDING', RETRY_COUNT: 3 },
    });
    await expect(
      adapter.writeback('resume-one', { status: 200, body: '{"status":"CLEAN"}' }, false),
    ).rejects.toBeDefined();
    expect((await adapter.read()).stage.REIS_FINAL_STATUS).toBe('PENDING');
  });
  it('version changes after authentication prevent dispatch and writeback', async () => {
    await adapter.claim(await adapter.read(), 'resume-one', 'hash');
    await adapter.prepareDispatch('resume-one', { systemId: key.cif });
    await db.execute(`UPDATE ${names.customer} SET MOD_NO=2`, {});
    let calls = 0;
    await expect(
      adapter.withDispatchFence('resume-one', async () => {
        calls++;
      }),
    ).rejects.toBeDefined();
    await expect(
      adapter.writeback('resume-one', { status: 200, body: '{"status":"CLEAN"}' }, false),
    ).rejects.toBeDefined();
    expect(calls).toBe(0);
  });
  it('invalid or non-2xx wire never produces CLEAN', async () => {
    await adapter.claim(await adapter.read(), 'resume-one', 'hash');
    await adapter.prepareDispatch('resume-one', { systemId: key.cif });
    for (const wire of [
      { status: 500, body: '{"status":"CLEAN"}' },
      { status: 200, body: 'bad' },
    ])
      await expect(adapter.writeback('resume-one', wire, false)).rejects.toBeDefined();
    expect((await adapter.read()).stage.REIS_FINAL_STATUS).toBeNull();
    expect(trialHash(await adapter.read())).toHaveLength(64);
  });
  it('Oracle receipt guard prevents deletion, history overwrite and phase regression', async () => {
    // Trigger :OLD/:NEW are PL/SQL correlation names, not SQL binds. Install fixture DDL
    // directly on this already-verified disposable connection; do not weaken the DML bind guard.
    const fixture = await (await import('oracledb')).default.getConnection(cfg!);
    try {
      await fixture.execute(resumeReceiptProtectionDdl(names.receipt));
    } finally {
      await fixture.close();
    }
    try {
      await adapter.claim(await adapter.read(), 'guarded-attempt', 'hash');
      await expect(db.execute(`DELETE FROM ${names.receipt}`, {})).rejects.toBeDefined();
      await expect(
        db.execute(`UPDATE ${names.receipt} SET ORIGINAL_SNAPSHOT='forged'`, {}),
      ).rejects.toBeDefined();
      await adapter.prepareDispatch('guarded-attempt', { systemId: TARGET.expectedCif });
      await expect(
        db.execute(`UPDATE ${names.receipt} SET PHASE='CLAIMED'`, {}),
      ).rejects.toBeDefined();
      await adapter.writeback(
        'guarded-attempt',
        { status: 200, body: '{"status":"PENDING"}' },
        false,
      );
      await adapter.writeback(
        'guarded-attempt',
        { status: 200, body: '{"status":"PENDING"}' },
        false,
      );
    } finally {
      await db.execute(`DROP TRIGGER ${names.receipt}_GUARD`, {});
    }
  });
  it('preserves and compares CLOBs beyond 64KB without truncation', async () => {
    const old = JSON.stringify({ synthetic: 'a'.repeat(80_000) });
    await db.execute(`UPDATE ${names.stage} SET REQUEST=:requestJson`, { requestJson: old });
    const before = await adapter.read();
    await adapter.claim(before, 'large-clob-attempt', 'hash');
    await adapter.prepareDispatch('large-clob-attempt', {
      systemId: TARGET.expectedCif,
      synthetic: 'b'.repeat(80_000),
    });
    const stored = (await db.query(`SELECT ORIGINAL_SNAPSHOT FROM ${names.receipt}`, {}))[0];
    expect(JSON.parse(String(stored.ORIGINAL_SNAPSHOT)).stage.REQUEST).toBe(old);
  });
  it('completed writeback detects later response tampering even when status remains PENDING', async () => {
    await adapter.claim(await adapter.read(), 'tamper-attempt', 'hash');
    await adapter.prepareDispatch('tamper-attempt', { systemId: TARGET.expectedCif });
    const wire = { status: 200, body: '{"status":"PENDING"}' };
    await adapter.writeback('tamper-attempt', wire, false);
    await db.execute(`UPDATE ${names.stage} SET RESPONSE='changed'`, {});
    await expect(adapter.writeback('tamper-attempt', wire, false)).rejects.toThrow(
      'EVIDENCE_CHANGED',
    );
  });
  describe('coordinator with REAL Oracle + file-backed SQLite + synthetic ports', () => {
    let dir: string,
      file: string,
      local: DataSource,
      sqlite: Database.Database,
      journal: ResumeJournal;
    let coordinator: ResumeCoordinator,
      ports: ResumePorts,
      bundle: ReturnType<typeof buildResumeBundle>,
      approval: ResumeExecutionApproval;
    const payload: ReisOnboardingRequest = {
      systemId: TARGET.expectedCif,
      systemName: 'synthetic',
      formId: 1,
      items: {},
      relations: [],
    };
    let now: number;
    const reopen = () => {
      sqlite.close();
      sqlite = new Database(file);
      journal = new ResumeJournal(sqlite);
      coordinator = new ResumeCoordinator(journal, adapter, ports, () => now);
    };
    beforeEach(async () => {
      now = Date.now();
      dir = mkdtempSync(join(tmpdir(), 'kyc-resume-oracle-'));
      file = join(dir, 'local.sqlite');
      local = new DataSource(buildDataSourceOptions({ type: 'sqlite', sqlitePath: file }, 'test'));
      await local.initialize();
      await local.runMigrations({ transaction: 'all' });
      const cases = new TypeOrmKycCaseRepository(local);
      const c = await cases.create({
        kycRefNo: TARGET.kycRefNo,
        seqNo: 1,
        customerNo: TARGET.expectedCif,
        reisSystemId: TARGET.expectedCif,
        customerType: CustomerType.INDIVIDUAL,
      });
      await cases.recordDeliveryUncertain(c.internalId, {
        code: 'SYNTHETIC_PREVIOUS_ATTEMPT',
        message: 'synthetic',
      });
      sqlite = new Database(file);
      journal = new ResumeJournal(sqlite);
      ports = {
        assertExecutionAllowed: jest.fn(async () => undefined),
        authenticate: jest.fn(async () => 'synthetic-token'),
        refreshPayload: jest.fn(async () => payload),
        dispatch: jest.fn(async () => ({ status: 200, body: '{"status":"PENDING"}' })),
      };
      const history = [1, 2].map((n) => ({
        id: `previous-${n}`,
        evidence: { syntheticAttempt: n },
        evidenceSha256: trialHash({ syntheticAttempt: n }),
      }));
      bundle = buildResumeBundle(
        await adapter.read(),
        journal.localEvidence(),
        payload,
        history,
        {
          reference: 'synthetic-provider-confirmation',
          confirmedBy: 'Synthetic Provider',
          confirmedAt: new Date(now).toISOString(),
          documentSha256: trialHash('synthetic-provider-document'),
          cif: TARGET.expectedCif,
          kycRefNo: TARGET.kycRefNo,
          seqNo: 1,
          attempts: history.map((a) => ({ id: a.id, evidenceSha256: a.evidenceSha256 })),
          noOnboardingCreated: true,
          noOnboardingProcessed: true,
        },
        0,
        false,
        now,
      );
      approval = {
        approvedBy: 'Synthetic Independent Reviewer',
        approvedAt: new Date(now).toISOString(),
        planSha256: bundle.reviewed.planSha256,
        executionApproved: true,
        pollingAndOtherSendersStopped: true,
        backupsVerified: true,
        sourceAndPayloadValidated: true,
        callbackQuarantineApproved: true,
        consumerContractReference: 'synthetic-consumer',
        oracleSqlReviewReference: 'synthetic-sql-review',
        rejectMappingApproved: false,
      };
      coordinator = new ResumeCoordinator(journal, adapter, ports, () => now);
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (sqlite?.open) sqlite.close();
      if (local?.isInitialized) await local.destroy();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });
    const attemptId = () =>
      String(
        (
          sqlite.prepare('SELECT attempt_id FROM kyc_resume_reservation').get() as {
            attempt_id: string;
          }
        ).attempt_id,
      );
    const callback = async (status: 'CUSTOMER' | 'BLOCKED') =>
      new CustomerStatusService(
        { authorize: () => true },
        new TypeOrmKycCaseRepository(local),
        new TypeOrmWebhookEventRepository(local),
        {
          updateStatus: async () => {
            throw Error('must never apply');
          },
        },
      ).handle({ headers: {}, body: { systemId: TARGET.expectedCif, status } });
    it('completes one PENDING send and survives real SQLite reopen without another authentication or dispatch', async () => {
      expect(await coordinator.execute(bundle, approval)).toMatchObject({ finalStatus: 'PENDING' });
      const id = attemptId();
      reopen();
      expect(await coordinator.recoverWriteback(id)).toBe('PENDING');
      await expect(coordinator.execute(bundle, approval)).rejects.toBeDefined();
      expect(ports.dispatch).toHaveBeenCalledTimes(1);
      expect(ports.authenticate).toHaveBeenCalledTimes(1);
      expect(
        (await new TypeOrmKycCaseRepository(local).findByKycRefNo(TARGET.kycRefNo))
          ?.internalRequestStatus,
      ).toBe('REIS_PENDING');
      expect(
        sqlite.prepare("SELECT * FROM kyc_resume_attempt WHERE origin='HISTORICAL'").all(),
      ).toHaveLength(2);
    });
    it('Oracle claim failure after local commit survives restart with no send', async () => {
      jest.spyOn(adapter, 'claim').mockRejectedValueOnce(Error('simulated lost Oracle connection'));
      await expect(coordinator.execute(bundle, approval)).rejects.toThrow('lost Oracle');
      reopen();
      await expect(coordinator.execute(bundle, approval)).rejects.toBeDefined();
      expect(ports.authenticate).not.toHaveBeenCalled();
      expect(ports.dispatch).not.toHaveBeenCalled();
    });
    it('CLEAN is published only from captured wire and the token is never persisted', async () => {
      ports.dispatch = jest.fn(async () => ({
        status: 200,
        body: '{"status":"CLEAN","reisId":"synthetic-reis-id"}',
      }));
      expect(await coordinator.execute(bundle, approval)).toMatchObject({ finalStatus: 'CLEAN' });
      expect(await adapter.read()).toMatchObject({
        modNo: 1,
        readyToScan: 'P',
        stage: { PROCESS_STATUS: 'S', REIS_FINAL_STATUS: 'CLEAN', SEQ_NO: 1 },
      });
      expect(
        await new TypeOrmKycCaseRepository(local).findByKycRefNo(TARGET.kycRefNo),
      ).toMatchObject({ finalStatus: 'CUSTOMER', flexcubeUpdateStatus: 'APPLIED' });
      const stored = sqlite.prepare('SELECT body_json FROM kyc_resume_event').all();
      expect(JSON.stringify(stored)).not.toContain('synthetic-token');
    });
    it('a lost Oracle COMMIT acknowledgement never permits another attempt', async () => {
      const real = adapter.claim.bind(adapter);
      jest.spyOn(adapter, 'claim').mockImplementationOnce(async (...args) => {
        await real(...args);
        throw Error('lost commit acknowledgement');
      });
      await expect(coordinator.execute(bundle, approval)).rejects.toThrow('lost commit');
      expect(await db.query(`SELECT * FROM ${names.receipt}`, {})).toHaveLength(1);
      reopen();
      await expect(coordinator.execute(bundle, approval)).rejects.toBeDefined();
      expect(ports.authenticate).not.toHaveBeenCalled();
      expect(ports.dispatch).not.toHaveBeenCalled();
    });
    it('auth failure is NOT an uncertain onboarding and reservation is never released', async () => {
      ports.authenticate = jest.fn(async () => {
        throw Error('synthetic auth failure');
      });
      await expect(coordinator.execute(bundle, approval)).rejects.toThrow('auth failure');
      expect(journal.event(attemptId(), 'FAILED_BEFORE_ONBOARDING')).toMatchObject({
        phase: 'AUTHENTICATE',
      });
      expect(journal.event(attemptId(), 'DELIVERY_UNCERTAIN')).toBeNull();
      reopen();
      await expect(coordinator.execute(bundle, approval)).rejects.toBeDefined();
      expect(ports.dispatch).not.toHaveBeenCalled();
    });
    it('STOP raised after auth prevents onboarding with durable reservation', async () => {
      ports.authenticate = jest.fn(async () => {
        ports.assertExecutionAllowed = async () => {
          throw Error('STOP');
        };
        return 'synthetic-token';
      });
      await expect(coordinator.execute(bundle, approval)).rejects.toThrow('STOP');
      expect(ports.dispatch).not.toHaveBeenCalled();
      expect(journal.hasReservation()).toBe(true);
    });
    it('a CIF amendment after auth is rejected without changing SEQ_NO or dispatching', async () => {
      ports.authenticate = jest.fn(async () => {
        await db.execute(`UPDATE ${names.customer} SET MOD_NO=2`, {});
        return 'synthetic-token';
      });
      await expect(coordinator.execute(bundle, approval)).rejects.toThrow('VERSION');
      expect(ports.dispatch).not.toHaveBeenCalled();
      expect((await adapter.read()).stage.SEQ_NO).toBe(1);
    });
    it('a changed source payload after authentication is rejected', async () => {
      ports.refreshPayload = jest.fn(async () => ({ ...payload, systemName: 'changed' }));
      await expect(coordinator.execute(bundle, approval)).rejects.toThrow('PAYLOAD_CHANGED');
      expect(ports.dispatch).not.toHaveBeenCalled();
    });
    it('callback during auth invalidates dispatch; delayed, duplicate, conflicting callbacks are all quarantined', async () => {
      ports.authenticate = jest.fn(async () => {
        await callback('CUSTOMER');
        return 'synthetic-token';
      });
      await expect(coordinator.execute(bundle, approval)).rejects.toThrow('CALLBACK');
      for (const s of ['CUSTOMER', 'CUSTOMER', 'BLOCKED'] as const)
        expect((await callback(s)).result).toBe('RECONCILIATION_REQUIRED');
      expect(ports.dispatch).not.toHaveBeenCalled();
      expect(journal.callbackCount()).toBe(4);
      expect((await adapter.read()).stage.REIS_FINAL_STATUS).toBeNull();
      expect(
        (await new TypeOrmKycCaseRepository(local).findByKycRefNo(TARGET.kycRefNo))?.finalStatus,
      ).toBeNull();
    });
    it('lost response is DELIVERY_UNCERTAIN and can never reach a second dispatch after restart', async () => {
      ports.dispatch = jest.fn(async () => {
        throw Error('synthetic reset after send');
      });
      await expect(coordinator.execute(bundle, approval)).rejects.toThrow('reset');
      const id = attemptId();
      expect(journal.event(id, 'DELIVERY_UNCERTAIN')).not.toBeNull();
      reopen();
      await expect(coordinator.recoverWriteback(id)).rejects.toThrow('NO_DURABLE_RESPONSE');
      await expect(coordinator.execute(bundle, approval)).rejects.toBeDefined();
      expect(ports.dispatch).toHaveBeenCalledTimes(1);
    });
    it('real Oracle writeback constraint failure recovers from saved wire without resending', async () => {
      await db.execute(
        `ALTER TABLE ${names.stage} ADD CONSTRAINT KRR_WB_${suffix} CHECK(PROCESS_STATUS <> 'S')`,
        {},
      );
      try {
        await expect(coordinator.execute(bundle, approval)).rejects.toBeDefined();
      } finally {
        await db.execute(`ALTER TABLE ${names.stage} DROP CONSTRAINT KRR_WB_${suffix}`, {});
      }
      const id = attemptId();
      expect(journal.event(id, 'RESPONSE_CAPTURED')).not.toBeNull();
      expect(journal.event(id, 'WRITEBACK_PENDING')).not.toBeNull();
      reopen();
      expect(await coordinator.recoverWriteback(id)).toBe('PENDING');
      expect(ports.dispatch).toHaveBeenCalledTimes(1);
    });
    it('SQLite response-write failure after dispatch never invents CLEAN or retries', async () => {
      sqlite.exec(
        "CREATE TRIGGER fail_wire BEFORE INSERT ON kyc_resume_event WHEN NEW.kind='RESPONSE_CAPTURED' BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END;",
      );
      await expect(coordinator.execute(bundle, approval)).rejects.toMatchObject({
        message: 'synthetic disk failure',
        code: 'SQLITE_CONSTRAINT_TRIGGER',
      });
      expect(journal.event(attemptId(), 'DELIVERY_UNCERTAIN')).not.toBeNull();
      expect((await adapter.read()).stage.REIS_FINAL_STATUS).toBeNull();
      expect(ports.dispatch).toHaveBeenCalledTimes(1);
    });
    it('response committed before interruption is recovered without another dispatch', async () => {
      const real = adapter.withDispatchFence.bind(adapter);
      jest.spyOn(adapter, 'withDispatchFence').mockImplementationOnce(async (id, work) => {
        await real(id, work);
        throw Error('interrupted after response commit');
      });
      await expect(coordinator.execute(bundle, approval)).rejects.toThrow('interrupted');
      const id = attemptId();
      reopen();
      expect(await coordinator.recoverWriteback(id)).toBe('PENDING');
      expect(ports.dispatch).toHaveBeenCalledTimes(1);
    });
    it.each([500, 200])(
      'unusable captured response HTTP %s remains DELIVERY_UNCERTAIN',
      async (status) => {
        ports.dispatch = jest.fn(async () => ({ status, body: 'not-json' }));
        await expect(coordinator.execute(bundle, approval)).rejects.toBeDefined();
        expect(journal.event(attemptId(), 'DELIVERY_UNCERTAIN')).not.toBeNull();
        expect((await adapter.read()).stage.REIS_FINAL_STATUS).toBeNull();
      },
    );
    it('approval expiry during authentication prevents dispatch', async () => {
      ports.authenticate = jest.fn(async () => {
        now += 3_600_001;
        return 'synthetic-token';
      });
      await expect(coordinator.execute(bundle, approval)).rejects.toBeDefined();
      expect(ports.dispatch).not.toHaveBeenCalled();
    });
    it('forged approval or missing provider confirmation never authenticates', async () => {
      await expect(
        coordinator.execute(bundle, { ...approval, executionApproved: false }),
      ).rejects.toBeDefined();
      expect(ports.authenticate).not.toHaveBeenCalled();
      expect(journal.hasReservation()).toBe(false);
    });
  });
});
