import 'reflect-metadata';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { loadConfiguration } from '../config/configuration';
import { loadEnvFile } from '../config/load-env-file';
import { createFlexcubeSqlExecutor } from '../flexcube/staging/flexcube-status-updater.factory';
import { OracleSqlExecutor } from '../flexcube/staging/oracle-sql-executor';
import { buildDataSourceOptions } from '../persistence/database.config';
import { SINGLE_KYC_TRIAL as TARGET, SingleTrialRefusedError } from './single-kyc-trial.contract';
import { SingleKycTrialRepository } from './single-kyc-trial.repository';
import { LocalCaseRow, applyReset, planReset } from './single-kyc-trial-reset';

/**
 * CLI: node dist/tools/reset-single-kyc-trial.js --evidence-dir <dir of the failed attempt>
 *   Without --confirm: DRY RUN, prints the plan and what refuses it, writes nothing.
 *   With --confirm RESET_UNDELIVERED_TRIAL --reis-confirmation "<who/when confirmed nothing arrived>"
 *        --backup-file <new protected file>: resets ONE undelivered attempt (see single-kyc-trial-reset.ts).
 * Polling must be off. Output: statuses and codes only, no customer data.
 */
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};

async function main() {
  const evidenceDir = arg('--evidence-dir');
  if (!evidenceDir || !existsSync(join(evidenceDir, 'before.json')))
    throw new SingleTrialRefusedError('EVIDENCE_DIR_OF_THE_ATTEMPT_REQUIRED');
  const failurePath = join(evidenceDir, 'failure.json');
  const wirePath = join(evidenceDir, 'wire.json');
  const evidence = {
    wireSaved: existsSync(wirePath),
    failure: existsSync(failurePath) ? JSON.parse(readFileSync(failurePath, 'utf8')) : null,
    wire: existsSync(wirePath) ? JSON.parse(readFileSync(wirePath, 'utf8')) : undefined,
  };
  const apply = arg('--confirm') !== undefined;
  const backupFile = arg('--backup-file');
  if (apply && !backupFile) throw new SingleTrialRefusedError('NEW_PROTECTED_BACKUP_FILE_REQUIRED');

  loadEnvFile();
  const config = loadConfiguration();
  if (config.flexcube.pollEnabled) throw new SingleTrialRefusedError('POLLING_MUST_BE_DISABLED');
  const db = createFlexcubeSqlExecutor(config.flexcube);
  if (!db) throw new SingleTrialRefusedError('FLEXCUBE_CONNECTION_NOT_CONFIGURED');
  const staging = new SingleKycTrialRepository(
    db,
    config.flexcube.stagingTable,
    config.flexcube.stagingStatusInProgress,
  );
  const options = buildDataSourceOptions(config.database, config.nodeEnv) as DataSourceOptions;
  const local = new DataSource({
    ...options,
    readonly: !apply,
    fileMustExist: true,
  } as DataSourceOptions);
  await local.initialize(); // never runs migrations
  const findCases = async () =>
    (await local.query(
      `SELECT internal_id, kyc_ref_no, reis_system_id, seq_no, internal_request_status,
              reis_onboarding_status, final_status, last_error_code
         FROM kyc_case WHERE kyc_ref_no = ? OR reis_system_id IN (?, ?) OR customer_no = ?`,
      [TARGET.kycRefNo, TARGET.kycRefNo, TARGET.expectedCif, TARGET.expectedCif],
    )) as LocalCaseRow[];
  try {
    const deps = {
      staging,
      evidence,
      localCases: findCases,
      deleteLocalCase: async (id: string) => {
        await local.query(
          `DELETE FROM kyc_case WHERE internal_id = ? AND internal_request_status = 'DELIVERY_UNCERTAIN'
             AND reis_onboarding_status IS NULL AND final_status IS NULL`,
          [id],
        );
        return (await findCases()).every((c) => c.internal_id !== id);
      },
      backup: async (value: unknown) => {
        const fd = openSync(backupFile as string, 'wx', 0o600);
        try {
          writeFileSync(fd, JSON.stringify(value, null, 2));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      },
    };
    if (!apply) {
      const plan = await planReset(deps);
      console.log(
        JSON.stringify({
          mode: 'dry-run',
          kind: plan.kind,
          rejectedField: plan.rejectedField,
          rowStatus: plan.row?.processStatus ?? null,
          rowResponseMatchesEvidence: plan.row?.response === plan.expectedResponse,
          trigger: plan.trigger,
          localCases: plan.cases.map((c) => c.internal_request_status),
          wireSaved: evidence.wireSaved,
          refusals: plan.refusals,
          resetPossible: plan.refusals.length === 0,
        }),
      );
      return;
    }
    const result = await applyReset(deps, {
      confirmation: arg('--confirm'),
      reisConfirmation: arg('--reis-confirmation'),
    });
    console.log(JSON.stringify({ mode: 'reset', ...result }));
  } finally {
    if (local.isInitialized) await local.destroy();
    if (db instanceof OracleSqlExecutor) await db.onModuleDestroy();
  }
}

if (require.main === module)
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        mode: 'refused',
        code:
          error instanceof SingleTrialRefusedError ? error.code : 'RESET_FAILED_NOTHING_RETRIED',
      }),
    );
    process.exit(1);
  });
