import Database from 'better-sqlite3';
import { DataSource } from 'typeorm';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDataSourceOptions } from '../src/persistence/database.config';
import { TypeOrmKycCaseRepository } from '../src/persistence/typeorm-kyc-case.repository';
import { CustomerType } from '../src/canonical';
import {
  inspectResumePreflight,
  parseResumePreflightArgs,
  ResumePreflightEvidence,
} from '../src/tools/resume-preflight';
import { SINGLE_KYC_TRIAL as TARGET, trialHash } from '../src/tools/single-kyc-trial.contract';

describe('file-only read-only resume preflight', () => {
  let dir: string, file: string, db: Database.Database, e: ResumePreflightEvidence;
  const now = Date.parse('2026-11-19T12:00:00Z');
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'resume-preflight-'));
    file = join(dir, 'local.sqlite');
    const ds = new DataSource(buildDataSourceOptions({ type: 'sqlite', sqlitePath: file }, 'test'));
    await ds.initialize();
    await ds.runMigrations({ transaction: 'all' });
    const cases = new TypeOrmKycCaseRepository(ds);
    const c = await cases.create({
      kycRefNo: TARGET.kycRefNo,
      customerNo: TARGET.expectedCif,
      reisSystemId: TARGET.expectedCif,
      seqNo: 1,
      customerType: CustomerType.INDIVIDUAL,
    });
    await cases.recordDeliveryUncertain(c.internalId, { code: 'SYNTHETIC', message: 'synthetic' });
    await ds.destroy();
    db = new Database(file, { readonly: true, fileMustExist: true });
    const history = [1, 2].map((n) => ({
      id: `previous-${n}`,
      evidence: { synthetic: n },
      evidenceSha256: trialHash({ synthetic: n }),
    }));
    e = {
      capturedAt: new Date(now).toISOString(),
      oracleSnapshotReference: 'synthetic-local-export',
      oracleReceipt: null,
      oracle: {
        modNo: 1,
        readyToScan: 'E',
        open: true,
        higherRevisionExists: false,
        stage: {
          KYC_REF_NO: TARGET.kycRefNo,
          SEQ_NO: 1,
          MSGID: 'synthetic-msg-id',
          PROCESS_STATUS: 'E',
          REQUEST: 'synthetic-original-request',
          RESPONSE: 'synthetic-original-response',
          REIS_FINAL_STATUS: null,
          RETRY_COUNT: 2,
          REQ_DATE: null,
          RES_DATE: null,
        },
      },
      payload: {
        systemId: TARGET.expectedCif,
        systemName: 'synthetic',
        formId: 1,
        items: {},
        relations: [],
      },
      history,
      confirmation: {
        reference: 'synthetic-provider-document',
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
    };
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('pins every evidence hash but cannot authorize execution, and leaves database bytes unchanged', () => {
    const before = readFileSync(file);
    const report = inspectResumePreflight(e, db, now);
    expect(report.bundle).not.toBeNull();
    expect(report.sendingAuthorized).toBe(false);
    expect(report.applyCommandAvailable).toBe(false);
    expect(report.gates.filter((g) => !g.passed).map((g) => g.name)).toEqual([
      'INDEPENDENT_EXECUTION_APPROVAL',
      'LIVE_LOCKED_REVALIDATION_AND_STOP_CHECK',
      'FINEXTA_SOURCE_SQL_AND_CONSUMER_REVIEW',
    ]);
    expect(readFileSync(file)).toEqual(before);
    expect(() => db.exec('CREATE TABLE should_never_exist(x)')).toThrow();
  });
  it('shows stale export and missing provider confirmation as blockers, without writing', () => {
    e.capturedAt = new Date(now - 900_001).toISOString();
    e.confirmation.noOnboardingProcessed = false;
    const report = inspectResumePreflight(e, db, now);
    expect(report.bundle).toBeNull();
    expect(report.gates.find((g) => g.name === 'FRESH_ORACLE_EXPORT')?.passed).toBe(false);
    expect(report.gates.find((g) => g.name === 'REIS_CONFIRMATION_AND_PINNED_PLAN')?.passed).toBe(
      false,
    );
  });
  it('existing callback audit is displayed and blocks preparation', () => {
    const writer = new Database(file);
    writer
      .prepare(
        'INSERT INTO webhook_event(event_id,received_at,system_id,incoming_status,processing_result) VALUES (?,?,?,?,?)',
      )
      .run(
        'synthetic-callback',
        new Date(now).toISOString(),
        TARGET.expectedCif,
        'CUSTOMER',
        'RECONCILIATION_REQUIRED',
      );
    writer.close();
    const report = inspectResumePreflight(e, db, now);
    expect(report.bundle).toBeNull();
    expect(report.gates.find((g) => g.name === 'NO_CALLBACK_RECONCILIATION_PENDING')?.passed).toBe(
      false,
    );
  });
  it('an existing Oracle receipt blocks the offline plan even if SQLite has no reservation', () => {
    e.oracleReceipt = { ATTEMPT_ID: 'previous-reservation', PHASE: 'CLAIMED' };
    const report = inspectResumePreflight(e, db, now);
    expect(report.bundle).toBeNull();
    expect(report.gates.find((g) => g.name === 'ORACLE_PERMANENT_RECEIPT_ABSENT')?.passed).toBe(
      false,
    );
  });
  it.each(
    [['--apply'], ['--confirm', 'SEND'], ['--sqlite', 'a', '--sqlite', 'b'], []].map((args) => ({
      args,
    })),
  )('rejects unsupported/execution arguments %j', ({ args }) => {
    expect(() => parseResumePreflightArgs(args)).toThrow();
  });
  it('accepts only explicit local files and never an approval or connection string', () => {
    expect(parseResumePreflightArgs(['--evidence', 'e.json', '--sqlite', 'copy.sqlite'])).toEqual({
      evidence: 'e.json',
      sqlite: 'copy.sqlite',
      report: undefined,
    });
    expect(parseResumePreflightArgs(['--help'])).toBeNull();
  });
});
