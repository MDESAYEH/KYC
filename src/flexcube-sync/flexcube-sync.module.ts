import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import {
  FLEXCUBE_STATUS_UPDATER,
  FLEXCUBE_TO_CANONICAL_MAPPER,
  IFlexcubeStatusUpdater,
  IFlexcubeToCanonicalMapper,
} from '../flexcube/flexcube.interfaces';
import { FlexcubeModule } from '../flexcube/flexcube.module';
import { CustomerTriggerSource } from '../flexcube/source/customer-trigger.source';
import { FlexcubeKycSource, normalizeSyncStartDate } from '../flexcube/source/flexcube-kyc-source';
import { FLEXCUBE_SQL_EXECUTOR, IFlexcubeSqlExecutor } from '../flexcube/staging/flexcube-staging';
import { StagingSubmissionRepository } from '../flexcube/staging/staging-submission.repository';
import { KycWorkflow } from '../kyc/kyc.workflow';
import { IKycCaseRepository, KYC_CASE_REPOSITORY } from '../persistence/persistence.interfaces';
import { PersistenceModule } from '../persistence/persistence.module';
import {
  CANONICAL_TO_REIS_TRANSFORMER,
  ICanonicalToReisTransformer,
  IReisOnboardingClient,
  REIS_ONBOARDING_CLIENT,
} from '../reis/reis.interfaces';
import { ReisModule } from '../reis/reis.module';
import { FlexcubeSyncScheduler } from './flexcube-sync.scheduler';
import { TriggerSyncService } from './trigger-sync.service';

export class FlexcubeSyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlexcubeSyncConfigError';
  }
}

const CIF_PATTERN = /^[0-9A-Z]{1,36}$/;

export interface TriggerSyncDeps {
  mapper: IFlexcubeToCanonicalMapper;
  transformer: ICanonicalToReisTransformer;
  cases: IKycCaseRepository;
  reis: IReisOnboardingClient;
  updater: IFlexcubeStatusUpdater;
}

/**
 * The trigger-table poller, or null when FLEXCUBE_POLL_ENABLED is not true. Startup fails on a missing FLEXCUBE
 * database, an invalid cut-off date or an invalid CIF allow-list.
 */
export function createTriggerSync(
  executor: IFlexcubeSqlExecutor | null,
  deps: TriggerSyncDeps,
  flexcube: AppConfig['flexcube'],
): TriggerSyncService | null {
  if (!flexcube.pollEnabled) return null;
  if (!executor) {
    throw new FlexcubeSyncConfigError(
      'FLEXCUBE_POLL_ENABLED=true requires the FLEXCUBE database (FLEXCUBE_DB_*)',
    );
  }
  if (
    flexcube.syncStartDate !== undefined &&
    normalizeSyncStartDate(flexcube.syncStartDate) === undefined
  ) {
    throw new FlexcubeSyncConfigError(
      'FLEXCUBE_SYNC_START_DATE must be an ISO date or timestamp (or empty for no cut-off)',
    );
  }
  if (flexcube.syncCifAllowlist.some((cif) => !CIF_PATTERN.test(cif))) {
    throw new FlexcubeSyncConfigError(
      'FLEXCUBE_SYNC_CIF_ALLOWLIST must list CIFs (comma separated)',
    );
  }
  return new TriggerSyncService(
    new CustomerTriggerSource(executor, flexcube.stagingTable, flexcube.syncStartDate),
    new FlexcubeKycSource(executor, flexcube.keypersonTypeColumn),
    new StagingSubmissionRepository(
      executor,
      flexcube.stagingTable,
      flexcube.stagingStatusInProgress,
    ),
    new KycWorkflow(deps.mapper, deps.transformer, deps.cases, deps.reis, deps.updater),
    {
      batchSize: flexcube.pollBatchSize,
      maxAttempts: flexcube.syncMaxAttempts,
      retryDelayMs: flexcube.syncRetryDelayMs,
      cifAllowlist: new Set(flexcube.syncCifAllowlist),
    },
  );
}

/** Polls FLEXCUBE's trigger table (FLEXCUBE never calls the integration layer). */
@Module({
  imports: [FlexcubeModule, ReisModule, PersistenceModule],
  providers: [
    {
      provide: FlexcubeSyncScheduler,
      inject: [
        FLEXCUBE_SQL_EXECUTOR,
        FLEXCUBE_TO_CANONICAL_MAPPER,
        CANONICAL_TO_REIS_TRANSFORMER,
        KYC_CASE_REPOSITORY,
        REIS_ONBOARDING_CLIENT,
        FLEXCUBE_STATUS_UPDATER,
        ConfigService,
      ],
      useFactory: (
        executor: IFlexcubeSqlExecutor | null,
        mapper: IFlexcubeToCanonicalMapper,
        transformer: ICanonicalToReisTransformer,
        cases: IKycCaseRepository,
        reis: IReisOnboardingClient,
        updater: IFlexcubeStatusUpdater,
        config: ConfigService,
      ) => {
        const flexcube = config.getOrThrow<AppConfig['flexcube']>('flexcube');
        return new FlexcubeSyncScheduler(
          createTriggerSync(executor, { mapper, transformer, cases, reis, updater }, flexcube),
          flexcube.pollIntervalMs,
        );
      },
    },
  ],
})
export class FlexcubeSyncModule {}
