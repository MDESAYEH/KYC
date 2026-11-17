import 'reflect-metadata';
import { HttpService } from '@nestjs/axios';
import axios from 'axios';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { singleTrialCallbackIsHeld } from '../kyc/single-kyc-trial.scope';
import { evaluateTrialGates } from '../kyc/single-kyc-trial.gates';
import { join } from 'node:path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { loadEnvFile } from '../config/load-env-file';
import { loadConfiguration } from '../config/configuration';
import { FlexcubeKycSource } from '../flexcube/source/flexcube-kyc-source';
import { createFlexcubeSqlExecutor } from '../flexcube/staging/flexcube-status-updater.factory';
import { OracleSqlExecutor } from '../flexcube/staging/oracle-sql-executor';
import { assertValidBinds } from '../flexcube/staging/sql-binds';
import { FlexcubeToCanonicalMapper } from '../flexcube/flexcube-to-canonical.mapper';
import { StrictIsoFlexcubeDateNormalizer } from '../flexcube/flexcube-date-normalizer';
import { YesNoResidentParser } from '../flexcube/flexcube-resident-parser';
import { ReferenceMappingService } from '../mapping/reference-mapping.service';
import { SingleSelectionSourceOfIncomeStrategy } from '../mapping/single-source-of-income.strategy';
import { buildDataSourceOptions } from '../persistence/database.config';
import { TypeOrmReferenceMappingRepository } from '../persistence/typeorm-reference-mapping.repository';
import { TypeOrmKycCaseRepository } from '../persistence/typeorm-kyc-case.repository';
import { CanonicalToReisTransformer } from '../reis/canonical-to-reis.transformer';
import { CifOnboardingPreview } from '../reis/cif-onboarding-preview';
import { validateReisConfig } from '../reis/reis.config';
import { ReisAuthClient } from '../reis/reis-auth.client';
import { ReisOnboardingClient } from '../reis/reis-onboarding.client';
import { SingleTrialTransport } from './single-kyc-trial.transport';
import { SingleKycTrialRepository } from './single-kyc-trial.repository';
import {
  SINGLE_KYC_TRIAL as TARGET,
  SingleTrialApproval,
  SingleTrialRefusedError,
  assertTrialApproval,
  trialHash,
} from './single-kyc-trial.contract';
import { SingleTrialPlan, planSingleKycTrial, sendSingleKycTrial } from './single-kyc-trial';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
/** New protected file; no overwrite; response/body files never go to stdout. */
function save(path: string, value: unknown): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function validateTrialSourceSql(sql: string): string {
  // whole-line '--' comments are documentation only and are not part of the hashed statement
  const clean = sql
    .replace(/^[ \t]*--.*$/gm, '')
    .trim()
    .replace(/;$/, '');
  if (
    !/^SELECT\b/i.test(clean) ||
    /;|\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|INTO|EXECUTE)\b/i.test(clean)
  )
    throw new SingleTrialRefusedError('REVIEWED_READ_ONLY_CIF_SELECT_REQUIRED');
  assertValidBinds(clean, { kycRefNo: TARGET.kycRefNo, seqNo: TARGET.seqNo });
  return clean;
}

async function main() {
  const mode = arg('--mode') ?? 'preflight';
  if (process.argv.includes('--help')) {
    console.log(
      'Single fixed KYC/SEQ trial. --mode preflight|send|verify --cif-sql <approved SELECT> --report <new protected file>. Send also needs --reviewed-plan <file> --approval <file> --confirm SEND_ONE_VERIFIED_KYC --evidence-dir <new directory>. No batch, retry or requeue.',
    );
    return;
  }
  if (!['preflight', 'send', 'verify'].includes(mode))
    throw new SingleTrialRefusedError('MODE_INVALID');
  const report = arg('--report');
  if (!report) throw new SingleTrialRefusedError('NEW_PROTECTED_REPORT_REQUIRED');
  const sourcePath = arg('--cif-sql');
  if (mode !== 'verify' && !sourcePath)
    throw new SingleTrialRefusedError('FINEXTA_CIF_SQL_NOT_SUPPLIED');
  const sql = sourcePath ? validateTrialSourceSql(readFileSync(sourcePath, 'utf8')) : '';
  const sourceSqlSha256 = trialHash(sql);
  // Preparation is intentionally NOT executable live until a verified callback route replaces
  // quarantine. A real initial response might be PENDING; no operator can force CLEAN.
  if (mode === 'send' && singleTrialCallbackIsHeld(TARGET.expectedCif))
    throw new SingleTrialRefusedError('EXACT_REVISION_CALLBACK_ROUTE_NOT_IMPLEMENTED');
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
  let reviewed: SingleTrialPlan | undefined;
  let approval: SingleTrialApproval | undefined;
  let evidenceDir: string | undefined;
  if (mode === 'send') {
    const reviewedPath = arg('--reviewed-plan'),
      approvalPath = arg('--approval');
    evidenceDir = arg('--evidence-dir');
    if (!reviewedPath || !approvalPath || !evidenceDir)
      throw new SingleTrialRefusedError('PLAN_APPROVAL_AND_EVIDENCE_REQUIRED');
    reviewed = JSON.parse(readFileSync(reviewedPath, 'utf8')) as SingleTrialPlan;
    approval = JSON.parse(readFileSync(approvalPath, 'utf8')) as SingleTrialApproval;
    assertTrialApproval(
      approval,
      reviewed.planSha256,
      sourceSqlSha256,
      staging.claimSqlSha256,
      arg('--confirm'),
    );
    mkdirSync(evidenceDir, { mode: 0o700 }); // must be new; Windows requires a restricted inherited ACL
  }
  let local: DataSource | undefined;
  const reportFd = openSync(report, 'wx', 0o600);
  const saveReport = (value: unknown) => {
    writeFileSync(reportFd, JSON.stringify(value, null, 2));
    fsyncSync(reportFd);
  };
  try {
    if (mode === 'verify') {
      await staging.master();
      const row = await staging.read();
      saveReport({ target: TARGET, row });
      console.log(
        JSON.stringify({
          mode,
          exists: row !== null,
          status: row?.reisFinalStatus,
          processStatus: row?.processStatus,
          requestPresent: row?.request != null,
          responsePresent: row?.response != null,
        }),
      );
      return;
    }
    const options = buildDataSourceOptions(config.database, config.nodeEnv) as DataSourceOptions;
    local = new DataSource({
      ...options,
      readonly: mode !== 'send',
      fileMustExist: true,
    } as DataSourceOptions);
    await local.initialize(); // never runs migrations or seeds mappings
    const refs = new ReferenceMappingService(new TypeOrmReferenceMappingRepository(local));
    if (!config.flexcube.syncStartDate)
      throw new SingleTrialRefusedError('SYNC_START_DATE_REQUIRED');
    const source = new FlexcubeKycSource(
      db,
      config.flexcube.stagingTable,
      config.flexcube.syncStartDate,
      config.flexcube.keypersonTypeColumn,
    );
    const mapper = new FlexcubeToCanonicalMapper(
      new StrictIsoFlexcubeDateNormalizer(),
      new YesNoResidentParser(),
    );
    const preview = new CifOnboardingPreview(
      new CanonicalToReisTransformer(refs, new SingleSelectionSourceOfIncomeStrategy(refs), {
        systemName: config.reis.systemName,
      } as never),
    );
    const deps = {
      staging,
      sourceSqlSha256,
      mapper,
      preview,
      readCif: () => db.query(sql, { kycRefNo: TARGET.kycRefNo, seqNo: TARGET.seqNo }),
      load: async () => {
        const master = await staging.master();
        return source.load({
          kycRefNo: TARGET.kycRefNo,
          seqNo: TARGET.seqNo,
          customerType: master.KYC_CUST_TYPE === 'R' ? 'INDIVIDUAL' : 'CORPORATE',
        });
      },
      hasLocalIdentity: async () => {
        const rows = (await local!.query(
          'SELECT COUNT(*) AS n FROM kyc_case WHERE kyc_ref_no = ? OR reis_system_id IN (?, ?) OR customer_no = ?',
          [TARGET.kycRefNo, TARGET.kycRefNo, TARGET.expectedCif, TARGET.expectedCif],
        )) as { n: number }[];
        return Number(rows[0]?.n) !== 0;
      },
    };
    if (mode === 'preflight') {
      const plan = await planSingleKycTrial(deps);
      saveReport(plan);
      console.log(
        JSON.stringify({
          mode,
          readyForOperationalReview: true,
          sendingAuthorized: false,
          // What still stands between this preflight and a send (no approval exists at preflight time).
          unmetGates: evaluateTrialGates({
            vocabulary: config.flexcube.finalStatusVocabulary,
            pollEnabled: config.flexcube.pollEnabled,
          }).unmet,
          planSha256: plan.planSha256,
          sourceSqlSha256,
          claimSqlSha256: staging.claimSqlSha256,
        }),
      );
      return;
    }
    const evidence = async (phase: string, value: unknown) =>
      save(join(evidenceDir!, `${phase}.json`), value);
    // Same existing authentication, HTTP transport and response parser; capture onboarding ONLY, never tokens.
    const reisConfig = validateReisConfig(config.reis, config.nodeEnv);
    const transport = new SingleTrialTransport(
      new HttpService(axios.create()),
      reisConfig,
      (wire) => evidence('wire', wire),
    );
    const stopFile = arg('--stop-file');
    if (!stopFile) throw new SingleTrialRefusedError('OPERATOR_STOP_FILE_REQUIRED');
    const result = await sendSingleKycTrial(
      {
        ...deps,
        assertExecutionAllowed: async () => {
          if (existsSync(stopFile)) throw new SingleTrialRefusedError('TRIAL_STOP_REQUESTED');
        },
        cases: new TypeOrmKycCaseRepository(local),
        reis: new ReisOnboardingClient(new ReisAuthClient(transport, reisConfig), transport),
        wireResponse: () => transport.wire,
        evidence,
      },
      reviewed!,
      approval,
      arg('--confirm'),
    );
    saveReport(result);
    console.log(JSON.stringify(result));
  } finally {
    closeSync(reportFd);
    if (local?.isInitialized) await local.destroy();
    if (db instanceof OracleSqlExecutor) await db.onModuleDestroy();
  }
}
if (require.main === module)
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        mode: 'refused',
        code:
          error instanceof SingleTrialRefusedError
            ? error.code
            : 'TRIAL_FAILED_INSPECT_PROTECTED_EVIDENCE_NO_RESEND',
      }),
    );
    process.exitCode = 1;
  });
