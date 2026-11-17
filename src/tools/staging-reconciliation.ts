import {
  StagingKey,
  StagingSubmissionRepository,
} from '../flexcube/staging/staging-submission.repository';

/**
 * Reconciliation of staging rows that the ORA-01745 incident (UAT1, 17/11/2026) closed as E although
 * nothing was ever sent (the claim UPDATE failed before any REIS call).
 *
 * A row is restored from E to N ONLY when ALL of this is proven:
 *   in the staging table (checked by the SELECT and again by the UPDATE itself):
 *     - ours (UUID MSGID), PROCESS_STATUS = E, RETRY_COUNT = 1, no REQUEST, no REQ_DATE,
 *       no REIS_FINAL_STATUS, RESPONSE exactly {"error":"<Oracle code>"} for an allowed code;
 *     - its KYC is still open at the same MOD_NO since the cut-off;
 *   in the integration layer's own database:
 *     - NO case exists for the KYC: the workflow never ran, so REIS was never called by us.
 * Anything else is left alone and only counted. Dry run is the default and changes nothing; applying
 * needs an explicit confirmation word AND a backup file written first. Reports hold counts only.
 */
export const RECONCILE_CONFIRMATION = 'RESTORE_NEVER_SENT_ROWS';

export interface ReconciliationDeps {
  repo: StagingSubmissionRepository;
  /** Has the integration layer ever created a case for this KYC (= started a REIS submission)? */
  hasLocalCase(kycRefNo: string): Promise<boolean>;
  /** Writes the rows about to be changed to a backup BEFORE any UPDATE; must throw on failure. */
  writeBackup?(rows: StagingKey[]): Promise<void>;
}

export interface ReconciliationOptions {
  /** Normalized cut-off (YYYY-MM-DDTHH:MM:SS). */
  since: string;
  /** Oracle codes whose E rows may be restored (default only ORA-01745). */
  errorCodes: string[];
  maxRows: number;
  apply: boolean;
  confirmation?: string;
}

export interface ReconciliationReport {
  mode: 'dry-run' | 'applied';
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
  if (opts.apply) {
    if (opts.confirmation !== RECONCILE_CONFIRMATION) {
      throw new ReconciliationRefusedError('the confirmation word is missing or wrong');
    }
    if (!deps.writeBackup) throw new ReconciliationRefusedError('a backup file is required');
  }

  const candidates = await deps.repo.findNeverSentTechnicalErrors(
    opts.since,
    opts.errorCodes,
    opts.maxRows,
  );
  // The proof comes from the integration layer's own database. If it cannot be read the whole run
  // stops: no proof, no restore.
  const eligible: StagingKey[] = [];
  for (const key of candidates) {
    if (!(await deps.hasLocalCase(key.kycRefNo))) eligible.push(key);
  }
  const report: ReconciliationReport = {
    mode: opts.apply ? 'applied' : 'dry-run',
    candidates: candidates.length,
    eligible: eligible.length,
    excludedLocalCase: candidates.length - eligible.length,
    restored: 0,
    notRestored: 0,
  };
  if (!opts.apply || eligible.length === 0) return report;

  await deps.writeBackup!(eligible); // nothing is changed before the backup exists
  for (const key of eligible) {
    // The row's own RESPONSE tells which allowed code closed it: try the allowed codes in turn;
    // the UPDATE itself only matches when RESPONSE is exactly that marker.
    let restored = false;
    for (const code of opts.errorCodes) {
      if (await deps.repo.restoreNeverSent(key, code)) {
        restored = true;
        break;
      }
    }
    if (restored) report.restored++;
    else report.notRestored++;
  }
  return report;
}
