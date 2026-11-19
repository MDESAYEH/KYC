import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { SINGLE_KYC_TRIAL as TARGET, trialHash } from '../tools/single-kyc-trial.contract';
import { ReisOnboardingResponse } from '../reis/dto';

export const RESUME_SCOPE = `${TARGET.expectedCif}:${TARGET.kycRefNo}:${TARGET.seqNo}`;
export const RESUME_STATEMENTS = [
  `CREATE TABLE kyc_resume_attempt (attempt_id TEXT PRIMARY KEY, scope TEXT NOT NULL, origin TEXT NOT NULL,
   evidence_json TEXT NOT NULL, evidence_sha256 TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE kyc_resume_reservation (scope TEXT PRIMARY KEY,
   attempt_id TEXT NOT NULL UNIQUE REFERENCES kyc_resume_attempt(attempt_id), plan_sha256 TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE kyc_resume_event (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
   attempt_id TEXT NOT NULL REFERENCES kyc_resume_attempt(attempt_id), kind TEXT NOT NULL, event_key TEXT NOT NULL,
   body_json TEXT NOT NULL, previous_sha256 TEXT NOT NULL, event_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
   UNIQUE(attempt_id,event_key))`,
  ...['attempt', 'reservation', 'event'].flatMap((table) =>
    ['UPDATE', 'DELETE'].map(
      (op) =>
        `CREATE TRIGGER kyc_resume_${table}_${op.toLowerCase()} BEFORE ${op} ON kyc_resume_${table}
     BEGIN SELECT RAISE(ABORT, 'resume journal is append-only'); END`,
    ),
  ),
];
export const RESUME_SCHEMA = RESUME_STATEMENTS.join(';\n') + ';';
export interface HistoricalAttempt {
  id: string;
  evidence: unknown;
  evidenceSha256: string;
}

/** SAME SQLite file as webhook_event; no automatic schema creation or migration. */
export class ResumeJournal {
  constructor(private readonly db: Database.Database) {
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = FULL');
  }
  hasReservation(): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM kyc_resume_reservation WHERE scope=?')
      .get(RESUME_SCOPE);
  }
  callbackCount(): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM webhook_event WHERE system_id IN (?,?)')
        .get(TARGET.expectedCif, TARGET.kycRefNo) as { n: number }
    ).n;
  }
  localEvidence(): unknown {
    return {
      cases: this.db
        .prepare(
          'SELECT * FROM kyc_case WHERE kyc_ref_no=? OR reis_system_id IN (?,?) OR customer_no=? ORDER BY internal_id',
        )
        .all(TARGET.kycRefNo, TARGET.expectedCif, TARGET.kycRefNo, TARGET.expectedCif),
      callbacks: this.db
        .prepare('SELECT * FROM webhook_event WHERE system_id IN (?,?) ORDER BY event_id')
        .all(TARGET.expectedCif, TARGET.kycRefNo),
    };
  }
  reserve(
    attemptId: string,
    planHash: string,
    history: HistoricalAttempt[],
    before: unknown,
    validate: () => void,
  ): void {
    this.db
      .transaction(() => {
        validate();
        if (this.callbackCount() !== 0) throw Error('RESUME_CALLBACK_RECONCILIATION_REQUIRED');
        if (
          history.length !== 2 ||
          new Set(history.map((a) => a.id)).size !== 2 ||
          history.some((a) => a.id === attemptId)
        )
          throw Error('RESUME_TWO_ORIGINAL_ATTEMPTS_REQUIRED');
        for (const a of history) {
          if (trialHash(a.evidence) !== a.evidenceSha256)
            throw Error('HISTORICAL_EVIDENCE_HASH_MISMATCH');
          const existing = this.db
            .prepare('SELECT evidence_json FROM kyc_resume_attempt WHERE attempt_id=?')
            .get(a.id) as { evidence_json: string } | undefined;
          if (existing) {
            if (existing.evidence_json !== JSON.stringify(a.evidence))
              throw Error('HISTORICAL_EVIDENCE_CONFLICT');
          } else this.insertAttempt(a.id, 'HISTORICAL', a.evidence);
        }
        this.insertAttempt(attemptId, 'RESUME', before);
        this.db
          .prepare('INSERT INTO kyc_resume_reservation VALUES (?,?,?,?)')
          .run(RESUME_SCOPE, attemptId, planHash, new Date().toISOString());
        this.append(attemptId, 'RESERVED', { planHash }, 'RESERVED');
      })
      .immediate();
  }
  private insertAttempt(id: string, origin: string, evidence: unknown): void {
    this.db
      .prepare('INSERT INTO kyc_resume_attempt VALUES (?,?,?,?,?,?)')
      .run(
        id,
        RESUME_SCOPE,
        origin,
        JSON.stringify(evidence),
        trialHash(evidence),
        new Date().toISOString(),
      );
  }
  append(attemptId: string, kind: string, body: unknown, eventKey: string = randomUUID()): void {
    this.db
      .transaction(() => {
        this.verifyIntegrity(attemptId);
        const prev = this.db
          .prepare(
            'SELECT event_sha256 FROM kyc_resume_event WHERE attempt_id=? ORDER BY ordinal DESC LIMIT 1',
          )
          .get(attemptId) as { event_sha256: string } | undefined;
        const at = new Date().toISOString(),
          previous = prev?.event_sha256 ?? '',
          json = JSON.stringify(body);
        const sha = trialHash({ attemptId, kind, eventKey, json, previous, at });
        this.db
          .prepare(
            'INSERT INTO kyc_resume_event(attempt_id,kind,event_key,body_json,previous_sha256,event_sha256,created_at) VALUES (?,?,?,?,?,?,?)',
          )
          .run(attemptId, kind, eventKey, json, previous, sha, at);
      })
      .immediate();
  }
  dispatchIntent(attemptId: string): void {
    this.db
      .transaction(() => {
        if (this.callbackCount() !== 0) throw Error('RESUME_CALLBACK_RECONCILIATION_REQUIRED');
        this.assertOwned(attemptId);
        this.append(attemptId, 'DISPATCH_INTENT', {}, 'DISPATCH_INTENT');
      })
      .immediate();
  }
  event(attemptId: string, kind: string): unknown | null {
    this.verifyIntegrity(attemptId);
    const row = this.db
      .prepare(
        'SELECT body_json FROM kyc_resume_event WHERE attempt_id=? AND kind=? ORDER BY ordinal DESC LIMIT 1',
      )
      .get(attemptId, kind) as { body_json: string } | undefined;
    return row ? (JSON.parse(row.body_json) as unknown) : null;
  }
  verifyIntegrity(attemptId: string): void {
    const attempt = this.db
      .prepare('SELECT evidence_json,evidence_sha256 FROM kyc_resume_attempt WHERE attempt_id=?')
      .get(attemptId) as { evidence_json: string; evidence_sha256: string } | undefined;
    if (!attempt || trialHash(JSON.parse(attempt.evidence_json)) !== attempt.evidence_sha256)
      throw Error('RESUME_JOURNAL_INTEGRITY_FAILURE');
    const rows = this.db
      .prepare('SELECT * FROM kyc_resume_event WHERE attempt_id=? ORDER BY ordinal')
      .all(attemptId) as Record<string, string>[];
    let previous = '';
    for (const row of rows) {
      const expected = trialHash({
        attemptId,
        kind: row.kind,
        eventKey: row.event_key,
        json: row.body_json,
        previous,
        at: row.created_at,
      });
      if (row.previous_sha256 !== previous || row.event_sha256 !== expected)
        throw Error('RESUME_JOURNAL_INTEGRITY_FAILURE');
      previous = expected;
    }
  }
  assertOwned(attemptId: string): void {
    if (
      !this.db
        .prepare('SELECT 1 FROM kyc_resume_reservation WHERE scope=? AND attempt_id=?')
        .get(RESUME_SCOPE, attemptId)
    )
      throw Error('RESUME_RESERVATION_NOT_OWNED');
  }
  attemptEvidence(attemptId: string): unknown {
    this.assertOwned(attemptId);
    const row = this.db
      .prepare('SELECT evidence_json,evidence_sha256 FROM kyc_resume_attempt WHERE attempt_id=?')
      .get(attemptId) as { evidence_json: string; evidence_sha256: string };
    const value: unknown = JSON.parse(row.evidence_json);
    if (trialHash(value) !== row.evidence_sha256) throw Error('RESUME_JOURNAL_INTEGRITY_FAILURE');
    return value;
  }
  projectResult(attemptId: string, original: unknown, response: ReisOnboardingResponse): void {
    this.db
      .transaction(() => {
        this.assertOwned(attemptId);
        const cases = (original as { cases: Record<string, unknown>[] }).cases;
        const c = cases[0];
        if (
          cases.length !== 1 ||
          c.kyc_ref_no !== TARGET.kycRefNo ||
          c.customer_no !== TARGET.expectedCif ||
          c.reis_system_id !== TARGET.expectedCif ||
          c.seq_no !== TARGET.seqNo
        )
          throw Error('RESUME_LOCAL_CASE_MISSING_OR_AMBIGUOUS');
        const current = this.db
          .prepare('SELECT * FROM kyc_case WHERE internal_id=?')
          .get(String(c.internal_id));
        const projected = this.event(attemptId, 'PROJECTED');
        if (projected) {
          if (trialHash(current) !== trialHash(projected))
            throw Error('RESUME_LOCAL_PROJECTION_CHANGED');
          return;
        }
        if (trialHash(current) !== trialHash(c)) throw Error('RESUME_LOCAL_CASE_CHANGED');
        const final =
          response.status === 'CLEAN'
            ? 'CUSTOMER'
            : response.status === 'REJECT'
              ? 'BLOCKED'
              : null;
        const internal =
          response.status === 'CLEAN'
            ? 'REIS_CLEAN'
            : response.status === 'REJECT'
              ? 'REIS_REJECTED'
              : 'REIS_PENDING';
        const str = (v: unknown) => (v == null ? null : String(v));
        const changed = this.db
          .prepare(
            `UPDATE kyc_case SET internal_request_status=?,reis_onboarding_status=?,
        final_status=?,final_status_at=?,flexcube_update_status=?,reis_id=?,risk_calculation_id=?,
        reis_instruction=?,reis_error_message=?,last_error_code=NULL,last_error_message=NULL,
        retry_count=retry_count+1,updated_at=? WHERE internal_id=? AND seq_no=?`,
          )
          .run(
            internal,
            response.status,
            final,
            final ? new Date().toISOString() : null,
            final ? 'APPLIED' : 'NOT_ATTEMPTED',
            str(response.reisId),
            str(response.riskCalculationId),
            str(response.instruction),
            str(response.errorMessage),
            new Date().toISOString(),
            String(c.internal_id),
            TARGET.seqNo,
          );
        if (changed.changes !== 1) throw Error('RESUME_LOCAL_PROJECTION_CAS_FAILED');
        this.append(
          attemptId,
          'PROJECTED',
          this.db.prepare('SELECT * FROM kyc_case WHERE internal_id=?').get(String(c.internal_id)),
          'PROJECTED',
        );
      })
      .immediate();
  }
}
