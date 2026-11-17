import { createHash } from 'node:crypto';
import {
  StagingBackupRow,
  StagingKey,
  StagingSubmissionRepository,
} from '../flexcube/staging/staging-submission.repository';

/**
 * Reconciliation of staging rows that the ORA-01745 incident (UAT1, 17/11/2026) closed as E although
 * the claim never succeeded. Designed to be audited and reversed.
 *
 * EVIDENCE, in two layers that are reported separately:
 *   programmatic (what the code can prove)
 *     - staging: ours (UUID MSGID), E, RETRY_COUNT 1, no REQUEST / REQ_DATE / REIS_FINAL_STATUS,
 *       RESPONSE exactly the technical marker of an allowed Oracle code, KYC still open at the same
 *       MOD_NO since the cut-off. In this application the claim comes before the read and the REIS
 *       call, so a claim that never succeeded means no REIS call from this code path;
 *     - the integration layer's local database has NO case and NO webhook callback for the KYC.
 *     This proves nothing about a replaced SQLite file, a second instance, a manual send or a
 *     sender outside this application (e.g. a FLEXCUBE scheduler), so it is NOT enough alone.
 *   operational (what only people can confirm): an ATTESTATION file, bound by hash to the exact list
 *     of rows, in which a named approver states that REIS was checked for those systemIds, that no
 *     other sender was active, and that the local database is the continuous one. Applying needs it.
 *
 * SAFETY: dry run is the default and writes nothing. Applying needs the confirmation word, a valid
 * attestation, and a FULL backup of the original rows (every column the rollback needs, with a
 * manifest and SHA-256) that is written and verified BEFORE any UPDATE. Each UPDATE repeats the whole
 * eligibility predicate, so a row that changed after it was selected is not touched. A rollback
 * restores the saved values, only for rows still in the exact post-restore state. Reports hold
 * counts and hashes only, never identifiers.
 */
export const RECONCILE_CONFIRMATION = 'RESTORE_NEVER_SENT_ROWS';
export const ROLLBACK_CONFIRMATION = 'ROLLBACK_RECONCILIATION';
/** An attestation older than this (or dated in the future) is refused. */
export const ATTESTATION_MAX_AGE_MS = 72 * 3_600_000;

export interface LocalEvidence {
  /** Has the integration layer ever created a case for this KYC (= started a REIS submission)? */
  hasCase(kycRefNo: string): Promise<boolean>;
  /** Did REIS ever call back for it (so REIS knew the request)? */
  hasWebhookEvent(kycRefNo: string): Promise<boolean>;
  /** Is the local database used at all (an empty one proves nothing)? */
  summary(): Promise<{ caseCount: number; oldestCaseAt: string | null }>;
}

/** Written by a person after checking REIS; bound to the exact list by its hash. */
export interface Attestation {
  approvedBy: string;
  /** ISO timestamp */
  approvedAt: string;
  /** sha256 of the eligible list printed by the dry run (see candidateListSha256) */
  candidateListSha256: string;
  /** REIS was checked for the systemIds of the list and shows no onboarding request for them */
  reisChecked: boolean;
  /** How: e.g. "REIS portal search by systemId on 17/11/2026 by <name>" */
  reisCheckMethod: string;
  /** No other sender (e.g. a FLEXCUBE scheduler, a manual call) was active for these KYCs */
  noOtherSender: boolean;
  /** The local SQLite file is the continuous production one (never replaced or restored) */
  localDatabaseIsContinuous: boolean;
  /** Required when the local database has no case at all */
  localDatabaseEmptyAcknowledged?: boolean;
  notes?: string;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  since: string;
  errorCodes: string[];
  rowCount: number;
  /** sha256 of JSON.stringify(rows) */
  rowsSha256: string;
  candidateListSha256: string;
  attestation: Attestation;
  attestationSha256: string;
  localDatabase: { caseCount: number; oldestCaseAt: string | null };
}

export interface BackupBundle {
  manifest: BackupManifest;
  rows: StagingBackupRow[];
}

export interface ReconciliationDeps {
  repo: StagingSubmissionRepository;
  local: LocalEvidence;
  now?: () => number;
  /** Writes AND verifies the backup; must throw on any problem. Called BEFORE any UPDATE. */
  writeBackup?(bundle: BackupBundle): Promise<void>;
}

export interface ReconciliationOptions {
  /** Normalized cut-off (YYYY-MM-DDTHH:MM:SS). */
  since: string;
  /** Oracle codes whose E rows may be restored (default only ORA-01745). */
  errorCodes: string[];
  maxRows: number;
  apply: boolean;
  confirmation?: string;
  attestation?: Attestation;
}

export interface ReconciliationReport {
  mode: 'dry-run' | 'applied';
  evidence: {
    programmatic: {
      /** rows satisfying every staging condition */
      stagingConditions: number;
      /** ... that also have neither a local case nor a webhook callback */
      noLocalCaseNoCallback: number;
      excludedLocalCase: number;
      excludedWebhookEvent: number;
    };
    localDatabase: { caseCount: number; oldestCaseAt: string | null; empty: boolean };
    operational: { attestationProvided: boolean; attestationValid: boolean; problems: string[] };
  };
  eligible: number;
  /** Hash of the eligible list: the attestation must carry this value. */
  eligibleListSha256: string;
  restored: number;
  /** Eligible rows that changed since they were selected and were therefore left alone. */
  notRestored: number;
  backupRowsSha256?: string;
}

export class ReconciliationRefusedError extends Error {
  constructor(reason: string) {
    super(`Reconciliation refused: ${reason}`);
    this.name = 'ReconciliationRefusedError';
  }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Hash of a list of keys, independent of their order. The dry run prints it; the attestation repeats it. */
export function candidateListSha256(keys: StagingKey[]): string {
  return sha256(
    keys
      .map((k) => `${k.kycRefNo}|${k.seqNo}`)
      .sort()
      .join('\n'),
  );
}

export const rowsSha256 = (rows: StagingBackupRow[]): string => sha256(JSON.stringify(rows));

/** Generic problems (never values). Empty when the attestation is acceptable. */
export function attestationProblems(
  att: Attestation | undefined,
  expectedListSha256: string,
  nowMs: number,
  localDatabaseEmpty: boolean,
): string[] {
  if (!att) return ['no attestation file'];
  const problems: string[] = [];
  if (typeof att.approvedBy !== 'string' || att.approvedBy.trim().length < 3) {
    problems.push('approvedBy is missing');
  }
  const at = Date.parse(att.approvedAt);
  if (Number.isNaN(at)) problems.push('approvedAt is not a valid timestamp');
  else if (at > nowMs + 5 * 60_000) problems.push('approvedAt is in the future');
  else if (nowMs - at > ATTESTATION_MAX_AGE_MS)
    problems.push('the attestation is older than 72 hours');
  if (att.candidateListSha256 !== expectedListSha256) {
    problems.push('the attestation was written for a different list of rows');
  }
  if (att.reisChecked !== true) problems.push('REIS was not checked');
  if (typeof att.reisCheckMethod !== 'string' || att.reisCheckMethod.trim().length < 10) {
    problems.push('reisCheckMethod is missing');
  }
  if (att.noOtherSender !== true) problems.push('no-other-sender is not confirmed');
  if (att.localDatabaseIsContinuous !== true)
    problems.push('the local database is not confirmed continuous');
  if (localDatabaseEmpty && att.localDatabaseEmptyAcknowledged !== true) {
    problems.push('the local database has no case at all and this is not acknowledged');
  }
  return problems;
}

export interface ReconciliationPlan {
  report: ReconciliationReport;
  /** In memory only (for the export file and the backup); never printed. */
  eligible: StagingKey[];
}

/** Read-only: everything the dry run shows. */
export async function planReconciliation(
  deps: ReconciliationDeps,
  opts: ReconciliationOptions,
): Promise<ReconciliationPlan> {
  if (opts.errorCodes.length === 0) throw new ReconciliationRefusedError('no error code given');
  const now = (deps.now ?? Date.now)();
  const candidates = await deps.repo.findNeverSentTechnicalErrors(
    opts.since,
    opts.errorCodes,
    opts.maxRows,
  );
  // The local evidence comes from the integration layer's own database. If it cannot be read the whole
  // run stops: no proof, no restore.
  const local = await deps.local.summary();
  const eligible: StagingKey[] = [];
  let excludedLocalCase = 0;
  let excludedWebhookEvent = 0;
  for (const key of candidates) {
    if (await deps.local.hasCase(key.kycRefNo)) excludedLocalCase++;
    else if (await deps.local.hasWebhookEvent(key.kycRefNo)) excludedWebhookEvent++;
    else eligible.push(key);
  }
  const listHash = candidateListSha256(eligible);
  const empty = local.caseCount === 0;
  const problems = attestationProblems(opts.attestation, listHash, now, empty);
  return {
    eligible,
    report: {
      mode: 'dry-run',
      evidence: {
        programmatic: {
          stagingConditions: candidates.length,
          noLocalCaseNoCallback: eligible.length,
          excludedLocalCase,
          excludedWebhookEvent,
        },
        localDatabase: { ...local, empty },
        operational: {
          attestationProvided: opts.attestation !== undefined,
          attestationValid: problems.length === 0,
          problems,
        },
      },
      eligible: eligible.length,
      eligibleListSha256: listHash,
      restored: 0,
      notRestored: 0,
    },
  };
}

export async function reconcileNeverSent(
  deps: ReconciliationDeps,
  opts: ReconciliationOptions,
): Promise<ReconciliationReport> {
  if (opts.apply) {
    if (opts.confirmation !== RECONCILE_CONFIRMATION) {
      throw new ReconciliationRefusedError('the confirmation word is missing or wrong');
    }
    if (!deps.writeBackup) throw new ReconciliationRefusedError('a backup file is required');
  }
  const { report, eligible } = await planReconciliation(deps, opts);
  if (!opts.apply) return report;

  if (!report.evidence.operational.attestationValid) {
    throw new ReconciliationRefusedError(
      `the attestation is not acceptable (${report.evidence.operational.problems.join('; ')})`,
    );
  }
  report.mode = 'applied';
  if (eligible.length === 0) return report;

  // 1. the FULL original rows, as they are now
  const rows: StagingBackupRow[] = [];
  for (const key of eligible) {
    const row = await deps.repo.readRowForBackup(key);
    if (row === null) throw new ReconciliationRefusedError('a selected row disappeared');
    rows.push(row);
  }
  const attestation = opts.attestation as Attestation;
  const bundle: BackupBundle = {
    manifest: {
      version: 1,
      createdAt: new Date((deps.now ?? Date.now)()).toISOString(),
      since: opts.since,
      errorCodes: opts.errorCodes,
      rowCount: rows.length,
      rowsSha256: rowsSha256(rows),
      candidateListSha256: report.eligibleListSha256,
      attestation,
      attestationSha256: sha256(JSON.stringify(attestation)),
      localDatabase: report.evidence.localDatabase,
    },
    rows,
  };
  // 2. written and verified before anything changes
  await deps.writeBackup!(bundle);
  report.backupRowsSha256 = bundle.manifest.rowsSha256;

  // 3. one conditional UPDATE per row; the code comes from the row's own saved RESPONSE
  for (const row of rows) {
    let code: string | undefined;
    try {
      code = (JSON.parse(row.response ?? '') as { error?: string }).error;
    } catch {
      code = undefined;
    }
    const allowed = code !== undefined && opts.errorCodes.includes(code);
    const restored = allowed
      ? await deps.repo.restoreNeverSent(
          { kycRefNo: row.kycRefNo, seqNo: row.seqNo },
          code as string,
          opts.since,
        )
      : false;
    if (restored) report.restored++;
    else report.notRestored++;
  }
  return report;
}

// ---- rollback --------------------------------------------------------------------------------

export interface RollbackReport {
  mode: 'dry-run' | 'applied';
  rows: number;
  /** still exactly in the post-restore state: can be rolled back */
  rollbackable: number;
  rolledBack: number;
  /** moved on since the restore (claimed, sent, changed): left alone, a person must decide */
  notRolledBack: number;
}

/** The manifest must describe the rows exactly; a damaged or edited backup is refused. */
export function verifyBundle(bundle: BackupBundle): void {
  const m = bundle.manifest;
  if (m?.version !== 1 || !Array.isArray(bundle.rows)) {
    throw new ReconciliationRefusedError('the backup file is not a reconciliation backup');
  }
  if (m.rowCount !== bundle.rows.length)
    throw new ReconciliationRefusedError('the backup row count differs');
  if (m.rowsSha256 !== rowsSha256(bundle.rows)) {
    throw new ReconciliationRefusedError(
      'the backup rows do not match their hash (edited or damaged)',
    );
  }
  if (m.attestationSha256 !== sha256(JSON.stringify(m.attestation))) {
    throw new ReconciliationRefusedError('the backup attestation does not match its hash');
  }
}

export async function rollbackReconciliation(
  deps: Pick<ReconciliationDeps, 'repo'>,
  bundle: BackupBundle,
  opts: { apply: boolean; confirmation?: string },
): Promise<RollbackReport> {
  verifyBundle(bundle);
  if (opts.apply && opts.confirmation !== ROLLBACK_CONFIRMATION) {
    throw new ReconciliationRefusedError('the rollback confirmation word is missing or wrong');
  }
  const report: RollbackReport = {
    mode: opts.apply ? 'applied' : 'dry-run',
    rows: bundle.rows.length,
    rollbackable: 0,
    rolledBack: 0,
    notRolledBack: 0,
  };
  for (const row of bundle.rows) {
    if (!opts.apply) {
      if (await deps.repo.isUntouchedSinceRestore(row)) report.rollbackable++;
      else report.notRolledBack++;
    } else if (await deps.repo.rollbackRestoredRow(row)) report.rolledBack++;
    else report.notRolledBack++;
  }
  return report;
}
