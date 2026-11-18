import {
  assertSafeKycRefNo,
  NeverSentRow,
  StagingSubmissionRepository,
} from '../flexcube/staging/staging-submission.repository';

/**
 * Reconciliation of staging rows that the ORA-01745 incident (UAT1, 17/11/2026) closed as E although
 * nothing was ever sent (the claim UPDATE failed before any REIS call).
 *
 * A row is restored from E to N ONLY when ALL of this is proven:
 *   in the staging table (checked by the SELECT and AGAIN by the UPDATE itself):
 *     - ours (UUID MSGID, the same MSGID as selected), PROCESS_STATUS = E, RETRY_COUNT = 1,
 *       no REQUEST, no REQ_DATE, no REIS_FINAL_STATUS, RESPONSE exactly {"error":"<code>"};
 *     - its KYC is still open at the same MOD_NO (= SEQ_NO) since the cut-off;
 *   in the integration layer's own database:
 *     - NO case exists for the KYC: the workflow never ran, so REIS was never called by us.
 * Anything else is left alone and only counted.
 *
 * Safety: dry run is the default and changes nothing. Applying needs (1) an explicit scope, one KYC
 * (`--kyc`) or every eligible row (`--all`), (2) the confirmation word, and (3) a backup written
 * BEFORE any UPDATE, holding every original value a rollback needs. A rollback restores those values,
 * only on rows still exactly as the restore left them. Reports hold counts only.
 */
export const RECONCILE_CONFIRMATION = 'RESTORE_NEVER_SENT_ROWS';
export const ROLLBACK_CONFIRMATION = 'ROLLBACK_RESTORED_ROWS';

export interface ReconciliationDeps {
  repo: StagingSubmissionRepository;
  /** Has the integration layer ever created a case for this KYC (= started a REIS submission)? */
  hasLocalCase(kycRefNo: string): Promise<boolean>;
  /** Writes the rows about to be changed (all original values) BEFORE any UPDATE; must throw on failure. */
  writeBackup?(rows: NeverSentRow[]): Promise<void>;
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
}

export interface ReconciliationReport {
  mode: 'dry-run' | 'applied';
  scope: 'one-kyc' | 'all';
  /** E rows matching every staging condition. */
  candidates: number;
  /** Candidates with NO local case: proven never sent. */
  eligible: number;
  /** Candidates that have a local case: REIS may have been called, left untouched. */
  excludedLocalCase: number;
  restored: number;
  /** Eligible rows that changed in the meantime and were therefore not restored. */
  notRestored: number;
}

export class ReconciliationRefusedError extends Error {
  constructor(reason: string) {
    super(`Reconciliation refused: ${reason}`);
    this.name = 'ReconciliationRefusedError';
  }
}

export async function reconcileNeverSent(
  deps: ReconciliationDeps,
  opts: ReconciliationOptions,
): Promise<ReconciliationReport> {
  if (opts.errorCodes.length === 0) throw new ReconciliationRefusedError('no error code given');
  if (opts.onlyKycRefNo !== undefined) {
    try {
      assertSafeKycRefNo(opts.onlyKycRefNo);
    } catch {
      throw new ReconciliationRefusedError('the KYC reference is not valid');
    }
    if (opts.all) throw new ReconciliationRefusedError('--kyc and --all cannot be combined');
  }
  if (opts.apply) {
    if (opts.onlyKycRefNo === undefined && !opts.all) {
      throw new ReconciliationRefusedError('apply needs an explicit scope: --kyc <ref> or --all');
    }
    if (opts.confirmation !== RECONCILE_CONFIRMATION) {
      throw new ReconciliationRefusedError('the confirmation word is missing or wrong');
    }
    if (!deps.writeBackup) throw new ReconciliationRefusedError('a backup file is required');
  }

  const candidates = await deps.repo.findNeverSentTechnicalErrors(
    opts.since,
    opts.errorCodes,
    opts.maxRows,
    opts.onlyKycRefNo,
  );
  // The proof comes from the integration layer's own database. If it cannot be read the whole run
  // stops: no proof, no restore.
  const eligible: NeverSentRow[] = [];
  for (const row of candidates) {
    if (!(await deps.hasLocalCase(row.kycRefNo))) eligible.push(row);
  }
  const report: ReconciliationReport = {
    mode: opts.apply ? 'applied' : 'dry-run',
    scope: opts.onlyKycRefNo !== undefined ? 'one-kyc' : 'all',
    candidates: candidates.length,
    eligible: eligible.length,
    excludedLocalCase: candidates.length - eligible.length,
    restored: 0,
    notRestored: 0,
  };
  if (!opts.apply || eligible.length === 0) return report;

  await deps.writeBackup!(eligible); // nothing is changed before the backup exists
  for (const row of eligible) {
    // The row's own RESPONSE says which allowed code closed it; the UPDATE re-checks everything.
    const code = opts.errorCodes.find((c) => row.response === JSON.stringify({ error: c }));
    if (code !== undefined && (await deps.repo.restoreNeverSent(row, code, opts.since))) {
      report.restored++;
    } else {
      report.notRestored++;
    }
  }
  return report;
}

export interface RollbackOptions {
  apply: boolean;
  confirmation?: string;
  /** Restrict the rollback to one KYC of the backup. */
  onlyKycRefNo?: string;
}

export interface RollbackReport {
  mode: 'dry-run' | 'applied';
  rowsInBackup: number;
  selected: number;
  rolledBack: number;
  /** Rows no longer exactly as the restore left them (e.g. already picked up): left alone. */
  notRolledBack: number;
}

/** Puts restored rows back to their backed-up E values. Dry run by default. */
export async function rollbackRestore(
  repo: StagingSubmissionRepository,
  backup: NeverSentRow[],
  opts: RollbackOptions,
): Promise<RollbackReport> {
  if (opts.apply && opts.confirmation !== ROLLBACK_CONFIRMATION) {
    throw new ReconciliationRefusedError('the rollback confirmation word is missing or wrong');
  }
  const selected = backup.filter(
    (r) => opts.onlyKycRefNo === undefined || r.kycRefNo === opts.onlyKycRefNo,
  );
  const report: RollbackReport = {
    mode: opts.apply ? 'applied' : 'dry-run',
    rowsInBackup: backup.length,
    selected: selected.length,
    rolledBack: 0,
    notRolledBack: 0,
  };
  if (!opts.apply) return report;
  for (const row of selected) {
    if (await repo.rollbackRestore(row)) report.rolledBack++;
    else report.notRolledBack++;
  }
  return report;
}

/** Strict parse of a backup file (JSON lines written by the reconciliation tool). */
export function parseBackup(text: string): NeverSentRow[] {
  const rows: NeverSentRow[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const r = JSON.parse(line) as Partial<NeverSentRow> & { kind?: string };
    if (r.kind === 'header') continue;
    const ok =
      typeof r.kycRefNo === 'string' &&
      Number.isInteger(r.seqNo) &&
      typeof r.msgId === 'string' &&
      r.processStatus === 'E' &&
      typeof r.response === 'string' &&
      Number.isInteger(r.retryCount) &&
      (r.resDate === null || typeof r.resDate === 'string');
    if (!ok) throw new ReconciliationRefusedError('the backup file is not valid');
    assertSafeKycRefNo(r.kycRefNo as string);
    rows.push({
      kycRefNo: r.kycRefNo as string,
      seqNo: r.seqNo as number,
      msgId: r.msgId as string,
      processStatus: 'E',
      response: r.response as string,
      retryCount: r.retryCount as number,
      resDate: r.resDate ?? null,
      reqDate: null,
      request: null,
      reisFinalStatus: null,
    });
  }
  return rows;
}

/** Backup file content: a header line, then one JSON line per row with every original value. */
export function formatBackup(
  rows: NeverSentRow[],
  meta: { since: string; codes: string[] },
): string {
  const header = JSON.stringify({
    kind: 'header',
    tool: 'reconcile:staging',
    createdAt: new Date().toISOString(),
    since: meta.since,
    codes: meta.codes,
    rows: rows.length,
  });
  return [header, ...rows.map((r) => JSON.stringify(r))].join('\n') + '\n';
}
