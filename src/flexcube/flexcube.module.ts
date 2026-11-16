import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import {
  FLEXCUBE_DATE_NORMALIZER,
  StrictIsoFlexcubeDateNormalizer,
} from './flexcube-date-normalizer';
import { FLEXCUBE_RESIDENT_PARSER, YesNoResidentParser } from './flexcube-resident-parser';
import { FlexcubeToCanonicalMapper } from './flexcube-to-canonical.mapper';
import { FLEXCUBE_STATUS_UPDATER, FLEXCUBE_TO_CANONICAL_MAPPER } from './flexcube.interfaces';
import { FLEXCUBE_SQL_EXECUTOR, IFlexcubeSqlExecutor } from './staging/flexcube-staging';
import {
  createFlexcubeSqlExecutor,
  createFlexcubeStatusUpdater,
} from './staging/flexcube-status-updater.factory';

/**
 * FLEXCUBE-side adapters. The date normalizer and resident parser are PROVISIONAL bindings
 * (the real FLEXCUBE formats/values are not confirmed); replace them here without touching the
 * mapper or the workflow. The status updater writes the
 * FLEXCUBE staging table when FLEXCUBE_DB_* is configured (mock otherwise, dev/test only).
 */
@Module({
  providers: [
    { provide: FLEXCUBE_DATE_NORMALIZER, useClass: StrictIsoFlexcubeDateNormalizer },
    { provide: FLEXCUBE_RESIDENT_PARSER, useClass: YesNoResidentParser },
    { provide: FLEXCUBE_TO_CANONICAL_MAPPER, useClass: FlexcubeToCanonicalMapper },
    {
      provide: FLEXCUBE_SQL_EXECUTOR,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createFlexcubeSqlExecutor(config.getOrThrow<AppConfig['flexcube']>('flexcube')),
    },
    {
      // Writes REIS_FINAL_STATUS in STTM_KYC_REIS_PAYLOAD_CUSTOM (mock when no DB, dev/test only).
      provide: FLEXCUBE_STATUS_UPDATER,
      inject: [FLEXCUBE_SQL_EXECUTOR, ConfigService],
      useFactory: (executor: IFlexcubeSqlExecutor | null, config: ConfigService) =>
        createFlexcubeStatusUpdater(
          executor,
          config.getOrThrow<AppConfig['flexcube']>('flexcube'),
          config.getOrThrow<string>('nodeEnv'),
        ),
    },
  ],
  exports: [FLEXCUBE_TO_CANONICAL_MAPPER, FLEXCUBE_STATUS_UPDATER, FLEXCUBE_SQL_EXECUTOR],
})
export class FlexcubeModule {}
