import Database from 'better-sqlite3';
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { buildResumeBundle } from '../resume/resume-coordinator';
import { HistoricalAttempt } from '../resume/resume-journal';
import { OracleResumeState } from '../resume/resume-oracle.adapter';
import { ReisOnboardingRequest } from '../reis/dto';
import { ReisAbsenceConfirmation } from './single-kyc-resume.plan';
import {
  SINGLE_KYC_TRIAL as TARGET,
  SingleTrialRefusedError,
  trialHash,
} from './single-kyc-trial.contract';

export interface ResumePreflightEvidence {
  capturedAt: string;
  oracleSnapshotReference: string;
  oracle: OracleResumeState;
  /** Exported receipt, explicitly null only when the read-only query found none. */
  oracleReceipt: Record<string, unknown> | null;
  payload: ReisOnboardingRequest;
  history: HistoricalAttempt[];
  confirmation: ReisAbsenceConfirmation;
}
/** Only local exported evidence and a read-only SQLite copy. Never loads .env or opens network connections. */
export function inspectResumePreflight(
  e: ResumePreflightEvidence,
  db: Database.Database,
  now = Date.now(),
) {
  const gates: { name: string; passed: boolean; evidence: unknown }[] = [];
  const gate = (name: string, passed: boolean, evidence: unknown) =>
    gates.push({ name, passed, evidence });
  const at = Date.parse(e.capturedAt);
  gate(
    'FRESH_ORACLE_EXPORT',
    Number.isFinite(at) && at <= now && now - at <= 900_000 && !!e.oracleSnapshotReference?.trim(),
    { capturedAt: e.capturedAt, reference: e.oracleSnapshotReference, sha256: trialHash(e.oracle) },
  );
  const s = e.oracle?.stage;
  gate(
    'ORACLE_PERMANENT_RECEIPT_ABSENT',
    e.oracleReceipt === null,
    e.oracleReceipt ?? { absent: e.oracleReceipt === null },
  );
  gate(
    'FIXED_TARGET_AND_REVISION',
    e.oracle?.modNo === 1 && s?.SEQ_NO === 1 && s?.KYC_REF_NO === TARGET.kycRefNo,
    { target: TARGET, modNo: e.oracle?.modNo, seqNo: s?.SEQ_NO, msgId: s?.MSGID },
  );
  gate(
    'E_E_WITH_EVIDENCE_AND_NO_FINAL',
    e.oracle?.readyToScan === 'E' &&
      s?.PROCESS_STATUS === 'E' &&
      typeof s?.REQUEST === 'string' &&
      !!s.REQUEST &&
      typeof s?.RESPONSE === 'string' &&
      !!s.RESPONSE &&
      s.REIS_FINAL_STATUS === null,
    {
      readyToScan: e.oracle?.readyToScan,
      processStatus: s?.PROCESS_STATUS,
      requestPresent: !!s?.REQUEST,
      responsePresent: !!s?.RESPONSE,
      finalStatus: s?.REIS_FINAL_STATUS,
    },
  );
  gate(
    'OPEN_AND_NO_HIGHER_REVISION',
    e.oracle?.open === true && e.oracle?.higherRevisionExists === false,
    { open: e.oracle?.open, higherRevisionExists: e.oracle?.higherRevisionExists },
  );
  gate(
    'BOTH_HISTORICAL_ARTIFACTS_HASHED',
    Array.isArray(e.history) &&
      e.history.length === 2 &&
      new Set(e.history.map((a) => a.id)).size === 2 &&
      e.history.every((a) => trialHash(a.evidence) === a.evidenceSha256),
    e.history?.map((a) => ({ id: a.id, sha256: a.evidenceSha256 })),
  );
  let localEvidence: unknown = null,
    callbackCount = -1,
    reserved = true;
  try {
    const cases = db
      .prepare(
        'SELECT * FROM kyc_case WHERE kyc_ref_no=? OR reis_system_id IN (?,?) OR customer_no=? ORDER BY internal_id',
      )
      .all(TARGET.kycRefNo, TARGET.expectedCif, TARGET.kycRefNo, TARGET.expectedCif);
    const callbacks = db
      .prepare('SELECT * FROM webhook_event WHERE system_id IN (?,?) ORDER BY event_id')
      .all(TARGET.expectedCif, TARGET.kycRefNo);
    localEvidence = { cases, callbacks };
    callbackCount = callbacks.length;
    gate('LOCAL_EVIDENCE_READABLE', true, {
      sha256: trialHash(localEvidence),
      caseCount: cases.length,
      callbackAudit: callbacks,
    });
    reserved = !!db
      .prepare('SELECT 1 FROM kyc_resume_reservation WHERE scope=?')
      .get(`${TARGET.expectedCif}:${TARGET.kycRefNo}:1`);
    gate('JOURNAL_MIGRATED', true, { schema: '1790000000006-ResumeJournal' });
  } catch {
    gate('LOCAL_SCHEMA_AND_JOURNAL_REQUIRED', false, {
      reason: 'Read failed; no schema was created or changed',
    });
  }
  gate('NO_CALLBACK_RECONCILIATION_PENDING', callbackCount === 0, { callbackCount });
  gate('NO_EXISTING_PERMANENT_RESERVATION', !reserved, { reserved });
  let bundle: ReturnType<typeof buildResumeBundle> | null = null;
  try {
    bundle = buildResumeBundle(
      e.oracle,
      localEvidence,
      e.payload,
      e.history,
      e.confirmation,
      callbackCount,
      reserved,
      now,
    );
    gate('REIS_CONFIRMATION_AND_PINNED_PLAN', true, {
      planSha256: bundle.reviewed.planSha256,
      providerReference: e.confirmation.reference,
      providerDocumentSha256: e.confirmation.documentSha256,
    });
  } catch (error) {
    gate('REIS_CONFIRMATION_AND_PINNED_PLAN', false, {
      code:
        error instanceof SingleTrialRefusedError
          ? error.code
          : error instanceof Error && /^RESUME_[A-Z_]+$/.test(error.message)
            ? error.message
            : 'RESUME_EVIDENCE_INVALID',
    });
  }
  gate('INDEPENDENT_EXECUTION_APPROVAL', false, 'Not accepted or created by this preflight');
  gate(
    'LIVE_LOCKED_REVALIDATION_AND_STOP_CHECK',
    false,
    'Required in future independently approved execution; this command is offline',
  );
  gate(
    'FINEXTA_SOURCE_SQL_AND_CONSUMER_REVIEW',
    false,
    'Independent review and current source/payload validation required',
  );
  return {
    version: 1,
    mode: 'READ_ONLY_OFFLINE',
    sendingAuthorized: false,
    applyCommandAvailable: false,
    payloadSha256: trialHash(e.payload),
    gates,
    bundle: gates
      .filter(
        (g) =>
          ![
            'INDEPENDENT_EXECUTION_APPROVAL',
            'LIVE_LOCKED_REVALIDATION_AND_STOP_CHECK',
            'FINEXTA_SOURCE_SQL_AND_CONSUMER_REVIEW',
          ].includes(g.name),
      )
      .every((g) => g.passed)
      ? bundle
      : null,
  };
}

export function parseResumePreflightArgs(args: string[]) {
  if (args.length === 1 && args[0] === '--help') return null;
  const accepted = new Set(['--evidence', '--sqlite', '--report']),
    found: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!accepted.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || found[args[i]])
      throw Error('RESUME_PREFLIGHT_ARGUMENT_INVALID_NO_APPLY');
    found[args[i]] = args[i + 1];
  }
  if (!found['--evidence'] || !found['--sqlite'])
    throw Error('RESUME_PREFLIGHT_EVIDENCE_AND_SQLITE_REQUIRED');
  return { evidence: found['--evidence'], sqlite: found['--sqlite'], report: found['--report'] };
}
function main() {
  const args = parseResumePreflightArgs(process.argv.slice(2));
  if (!args) {
    console.log(
      'Read-only OFFLINE preflight: --evidence <protected-export.json> --sqlite <local-database-copy.sqlite> [--report <new-protected-file.json>]. No .env, Oracle connection, HTTP or apply.',
    );
    return;
  }
  const db = new Database(args.sqlite, { readonly: true, fileMustExist: true });
  try {
    const e = JSON.parse(readFileSync(args.evidence, 'utf8')) as ResumePreflightEvidence;
    const report = inspectResumePreflight(e, db);
    if (args.report) {
      const fd = openSync(args.report, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(report, null, 2));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    // Full evidence/payload belongs only in the protected report, never stdout.
    console.log(
      JSON.stringify(
        {
          mode: report.mode,
          sendingAuthorized: false,
          planSha256: report.bundle?.reviewed.planSha256 ?? null,
          gates: report.gates.map((g) => ({ name: g.name, passed: g.passed })),
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
}
if (require.main === module)
  try {
    main();
  } catch {
    console.error('RESUME_PREFLIGHT_REFUSED_NO_ACTION');
    process.exitCode = 1;
  }
