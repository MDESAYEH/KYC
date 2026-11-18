import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { FlexcubeModule } from '../flexcube/flexcube.module';
import {
  FlexcubeKycSource,
  MAX_CANARY_KYCS,
  normalizeSyncStartDate,
} from '../flexcube/source/flexcube-kyc-source';
import {
  assertSafeColumnName,
  FLEXCUBE_SQL_EXECUTOR,
  IFlexcubeSqlExecutor,
} from '../flexcube/staging/flexcube-staging';
import { StagingSubmissionRepository } from '../flexcube/staging/staging-submission.repository';
import { IKycWorkflow, KYC_WORKFLOW } from '../kyc/kyc.interfaces';
import { KycModule } from '../kyc/kyc.module';
import { FlexcubeSyncScheduler } from './flexcube-sync.scheduler';
import { FlexcubeSyncService } from './flexcube-sync.service';

export class FlexcubeSyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlexcubeSyncConfigError';
  }
}

/** Builds the sync service, or null when polling is disabled. */
export function createFlexcubeSync(
  executor: IFlexcubeSqlExecutor | null,
  workflow: IKycWorkflow,
  flexcube: AppConfig['flexcube'],
): FlexcubeSyncService | null {
  if (!flexcube.pollEnabled) return null;
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
  if (flexcube.syncOnlyKycRefNos.length > MAX_CANARY_KYCS) {
    throw new FlexcubeSyncConfigError(
      `FLEXCUBE_SYNC_ONLY_KYC_REF_NOS accepts at most ${MAX_CANARY_KYCS} KYC references`,
    );
  }
  for (const ref of flexcube.syncOnlyKycRefNos) {
    if (!/^[A-Z0-9]{1,35}$/.test(ref)) {
      throw new FlexcubeSyncConfigError(
        'FLEXCUBE_SYNC_ONLY_KYC_REF_NOS must list KYC references (upper-case letters and digits)',
      );
    }
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
      flexcube.syncOnlyKycRefNos,
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

/**
 * Polls FLEXCUBE for saved KYCs (agreed architecture: FLEXCUBE never calls the integration
 * layer). Disabled unless FLEXCUBE_POLL_ENABLED=true.
 */
@Module({
  imports: [FlexcubeModule, KycModule],
  providers: [
    {
      provide: FlexcubeSyncScheduler,
      inject: [FLEXCUBE_SQL_EXECUTOR, KYC_WORKFLOW, ConfigService],
      useFactory: (
        executor: IFlexcubeSqlExecutor | null,
        workflow: IKycWorkflow,
        config: ConfigService,
      ) => {
        const flexcube = config.getOrThrow<AppConfig['flexcube']>('flexcube');
        return new FlexcubeSyncScheduler(
          createFlexcubeSync(executor, workflow, flexcube),
          flexcube.pollIntervalMs,
        );
      },
    },
  ],
})
export class FlexcubeSyncModule {}
