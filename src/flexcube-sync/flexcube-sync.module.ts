import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { FlexcubeModule } from '../flexcube/flexcube.module';
import { FlexcubeKycSource, normalizeSyncStartDate } from '../flexcube/source/flexcube-kyc-source';
import {
  assertSafeColumnName,
  FLEXCUBE_SQL_EXECUTOR,
  IFlexcubeSqlExecutor,
} from '../flexcube/staging/flexcube-staging';
import { StagingSubmissionRepository } from '../flexcube/staging/staging-submission.repository';
import { IKycWorkflow } from '../kyc/kyc.interfaces';
import { CifKycWorkflow } from '../kyc/cif-kyc.workflow';
import { CustomerTriggerSource } from '../flexcube/source/customer-trigger.source';
import {
  FLEXCUBE_STATUS_UPDATER,
  FLEXCUBE_TO_CANONICAL_MAPPER,
  IFlexcubeStatusUpdater,
  IFlexcubeToCanonicalMapper,
} from '../flexcube/flexcube.interfaces';
import { IKycCaseRepository, KYC_CASE_REPOSITORY } from '../persistence/persistence.interfaces';
import { PersistenceModule } from '../persistence/persistence.module';
import {
  CANONICAL_TO_REIS_TRANSFORMER,
  ICanonicalToReisTransformer,
  IReisOnboardingClient,
  REIS_ONBOARDING_CLIENT,
} from '../reis/reis.interfaces';
import { ReisModule } from '../reis/reis.module';
import { TriggerSyncService } from './trigger-sync.service';
import { CifSubmissionHoldWorkflow } from '../kyc/cif-submission-hold.workflow';
import { FlexcubeSyncScheduler } from './flexcube-sync.scheduler';
import { FlexcubeSyncService } from './flexcube-sync.service';

export class FlexcubeSyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlexcubeSyncConfigError';
  }
}

/** LEGACY (not wired since 19/11/2026): the KYC_MASTER pass with the historical identity. Tests only. */
export function createFlexcubeSync(
  executor: IFlexcubeSqlExecutor | null,
  workflow: IKycWorkflow,
  flexcube: AppConfig['flexcube'],
): FlexcubeSyncService | null {
  if (!flexcube.pollEnabled) return null;
  if (workflow instanceof CifSubmissionHoldWorkflow) {
    throw new FlexcubeSyncConfigError(
      'Polling must remain disabled until CIF source and identity cutover are approved',
    );
  }
  if (!executor) {
    throw new FlexcubeSyncConfigError(
      'FLEXCUBE_POLL_ENABLED=true requires the FLEXCUBE database (FLEXCUBE_DB_*)',
    );
  }
  // Mandatory cut-off: never default to "no cut-off" (would send every historical KYC).
  if (normalizeSyncStartDate(flexcube.syncStartDate) === undefined) {
    throw new FlexcubeSyncConfigError(
      'FLEXCUBE_POLL_ENABLED=true requires FLEXCUBE_SYNC_START_DATE as an ISO date or timestamp ' +
        '(e.g. 2026-11-16 or 2026-11-16T08:00:00); it is missing or invalid',
    );
  }
  if (!/^[A-Z]$/.test(flexcube.stagingStatusInProgress)) {
    throw new FlexcubeSyncConfigError(
      'FLEXCUBE_STAGING_STATUS_IN_PROGRESS must be one uppercase letter (default W)',
    );
  }
  try {
    assertSafeColumnName(flexcube.keypersonTypeColumn);
  } catch {
    throw new FlexcubeSyncConfigError(
      'FLEXCUBE_KEYPERSON_TYPE_COLUMN is not a valid Oracle column name (default KYC_KEYPERSON_TYPE)',
    );
  }
  const acknowledged = flexcube.syncUncertainAck.map((entry) => {
    const m = /^([A-Z0-9]{1,35}):(\d{1,9})$/.exec(entry);
    if (!m) {
      throw new FlexcubeSyncConfigError(
        'FLEXCUBE_SYNC_UNCERTAIN_ACK must list KYC_REF_NO:SEQ_NO entries (comma separated)',
      );
    }
    return { kycRefNo: m[1], seqNo: Number(m[2]) };
  });
  return new FlexcubeSyncService(
    new FlexcubeKycSource(
      executor,
      flexcube.stagingTable,
      flexcube.syncStartDate as string,
      flexcube.keypersonTypeColumn,
    ),
    new StagingSubmissionRepository(
      executor,
      flexcube.stagingTable,
      flexcube.stagingStatusInProgress,
    ),
    workflow,
    flexcube.pollBatchSize,
    { acknowledgedUncertain: acknowledged },
  );
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
 * Builds the trigger-table poller (STTM_CUSTOMER_CUSTOM, agreed with Finexta 19/11/2026), or null when polling is
 * disabled. It sends with the CIF identity (CifKycWorkflow), the same path as the single-KYC trial that came back
 * CLEAN. Refused at startup unless: FLEXCUBE database configured, cut-off set, final-status vocabulary
 * clean-pending-blocked (Finexta's account check), and an explicit CIF allow-list or FLEXCUBE_SYNC_ALL_CIFS=true.
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
  if (normalizeSyncStartDate(flexcube.syncStartDate) === undefined) {
    throw new FlexcubeSyncConfigError(
      'FLEXCUBE_POLL_ENABLED=true requires FLEXCUBE_SYNC_START_DATE as an ISO date or timestamp',
    );
  }
  if (flexcube.finalStatusVocabulary !== 'clean-pending-blocked') {
    throw new FlexcubeSyncConfigError(
      'FLEXCUBE_POLL_ENABLED=true requires FLEXCUBE_FINAL_STATUS_VOCABULARY=clean-pending-blocked',
    );
  }
  if (!/^[A-Z]$/.test(flexcube.stagingStatusInProgress)) {
    throw new FlexcubeSyncConfigError(
      'FLEXCUBE_STAGING_STATUS_IN_PROGRESS must be one uppercase letter (default W)',
    );
  }
  try {
    assertSafeColumnName(flexcube.keypersonTypeColumn);
  } catch {
    throw new FlexcubeSyncConfigError(
      'FLEXCUBE_KEYPERSON_TYPE_COLUMN is not a valid Oracle column name',
    );
  }
  const allowlist = flexcube.syncCifAllowlist;
  if (allowlist.some((cif) => !CIF_PATTERN.test(cif))) {
    throw new FlexcubeSyncConfigError(
      'FLEXCUBE_SYNC_CIF_ALLOWLIST must list CIFs (comma separated)',
    );
  }
  if (allowlist.length === 0 && !flexcube.syncAllCifs) {
    throw new FlexcubeSyncConfigError(
      'FLEXCUBE_POLL_ENABLED=true requires FLEXCUBE_SYNC_CIF_ALLOWLIST (first runs) or FLEXCUBE_SYNC_ALL_CIFS=true',
    );
  }
  const acknowledged = parseAcks(flexcube.syncUncertainAck);
  const details = new FlexcubeKycSource(
    executor,
    flexcube.stagingTable,
    flexcube.syncStartDate as string,
    flexcube.keypersonTypeColumn,
  );
  return new TriggerSyncService(
    new CustomerTriggerSource(
      executor,
      flexcube.stagingTable,
      flexcube.syncStartDate as string,
      true,
    ),
    details,
    new StagingSubmissionRepository(
      executor,
      flexcube.stagingTable,
      flexcube.stagingStatusInProgress,
    ),
    new CifKycWorkflow(deps.mapper, deps.transformer, deps.cases, deps.reis, deps.updater),
    flexcube.pollBatchSize,
    { cifAllowlist: new Set(allowlist), acknowledgedUncertain: acknowledged },
  );
}

function parseAcks(entries: string[]) {
  return entries.map((entry) => {
    const m = /^([A-Z0-9]{1,35}):(\d{1,9})$/.exec(entry);
    if (!m) {
      throw new FlexcubeSyncConfigError(
        'FLEXCUBE_SYNC_UNCERTAIN_ACK must list KYC_REF_NO:SEQ_NO entries (comma separated)',
      );
    }
    return { kycRefNo: m[1], seqNo: Number(m[2]) };
  });
}

/**
 * Polls FLEXCUBE's trigger table (agreed architecture: FLEXCUBE never calls the integration layer).
 * Disabled unless FLEXCUBE_POLL_ENABLED=true. The legacy KYC_MASTER pass (createFlexcubeSync) is no longer wired.
 */
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
