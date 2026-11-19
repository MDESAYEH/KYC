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
 *       RESPONSE exactly the technical marker of an allowed Oracle code, and the KYC still open at the same
 *       MOD_NO since the cut-off.
 *     - the integration layer has NO case and NO webhook callback for the KYC.
 *   operational (what only people can confirm): REIS was checked and no other sender was active.
 *
 * SAFETY: dry run is the default. Applying needs confirmation, valid attestation, and a full verified backup
 * written before any UPDATE. A rollback restores saved values only while rows remain in the exact post-restore state.
}

export interface ReconciliationOptions {
  /** Normalized cut-off (YYYY-MM-DDTHH:MM:SS). */
  since: string;
  /** Oracle codes whose E rows may be restored (default only ORA-01745). */
  errorCodes: string[];
  maxRows: number;
  /** Restrict everything (SELECT and UPDATE) to this one KYC. */
  onlyKycRefNo?: string;
  /** Explicit opt-in to restore every eligible row (required with apply when no onlyKycRefNo). */
  all?: boolean;
  apply: boolean;
  confirmation?: string;
  attestation?: Attestation;
}

export interface ReconciliationReport {
  mode: 'dry-run' | 'applied';
  evidence: {
    programmatic: {
      stagingConditions: number;
      noLocalCaseNoCallback: number;
      excludedLocalCase: number;
      excludedWebhookEvent: number;
    };
    localDatabase: { caseCount: number; oldestCaseAt: string | null; empty: boolean };
    operational: { attestationProvided: boolean; attestationValid: boolean; problems: string[] };
  };
  eligibleListSha256: string;
  restored: number;
  notRestored: number;
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
    if (opts.onlyKycRefNo === undefined && !opts.all) {
      throw new ReconciliationRefusedError('apply needs an explicit scope: --kyc <ref> or --all');
    }
    if (opts.confirmation !== RECONCILE_CONFIRMATION) {
      throw new ReconciliationRefusedError('the confirmation word is missing or wrong');
    }
    if (!deps.writeBackup) throw new ReconciliationRefusedError('a backup file is required');
  }
  const { report, eligible } = await planReconciliation(deps, opts);
  if (!opts.apply) return report;

  const { report, eligible } = await planReconciliation(deps, opts);
  if (!opts.apply) return report;

  if (!report.evidence.operational.attestationValid) {
    throw new ReconciliationRefusedError(
      `the attestation is not acceptable (${report.evidence.operational.problems.join('; ')})`,
    );
  }
  report.mode = 'applied';
  if (eligible.length === 0) return report;

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
  await deps.writeBackup!(bundle);

  for (const row of rows) {
    let code: string | undefined;
    try {
      code = (JSON.parse(row.response ?? '') as { error?: string }).error;
    } catch {
      code = undefined;
    }
    const restored = code !== undefined && opts.errorCodes.includes(code)
      ? await deps.repo.restoreNeverSent(
          { kycRefNo: row.kycRefNo, seqNo: row.seqNo },
          code,
          opts.since,
          row.msgId ?? '',
          row.resDate,
        )
      : false;
    if (restored) report.restored++;
    else report.notRestored++;
  }
  return report;
  }
  return report;
}

// ---- rollback --------------------------------------------------------------------------------

export interface RollbackReport {
  mode: 'dry-run' | 'applied';
  rows: number;
  rollbackable: number;
  rolledBack: number;
  notRolledBack: number;
}

export function verifyBundle(bundle: BackupBundle): void {
  const m = bundle.manifest;
  if (m?.version !== 1 || !Array.isArray(bundle.rows)) {
    throw new ReconciliationRefusedError('the backup file is not a reconciliation backup');
  }
  if (m.rowCount !== bundle.rows.length)
    throw new ReconciliationRefusedError('the backup row count differs');
  if (m.rowsSha256 !== rowsSha256(bundle.rows))
    throw new ReconciliationRefusedError('the backup rows do not match their hash (edited or damaged)');
  if (m.attestationSha256 !== sha256(JSON.stringify(m.attestation)))
    throw new ReconciliationRefusedError('the backup attestation does not match its hash');
}

export async function rollbackReconciliation(
  deps: Pick<ReconciliationDeps, 'repo'>,
  bundle: BackupBundle,
  opts: { apply: boolean; confirmation?: string },
): Promise<RollbackReport> {
  verifyBundle(bundle);
  if (opts.apply && opts.confirmation !== ROLLBACK_CONFIRMATION)
    throw new ReconciliationRefusedError('the rollback confirmation word is missing or wrong');

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
    else report.notRolledBack++;
  }
  return report;
}
