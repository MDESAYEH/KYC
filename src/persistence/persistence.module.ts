import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfig } from '../config/configuration';
import { REFERENCE_MAPPING_REPOSITORY } from '../mapping/mapping.interfaces';
import { buildDataSourceOptions } from './database.config';
import { DATABASE_HEALTH_CHECK, TypeOrmDatabaseHealthCheck } from './database-health';
import { KYC_CASE_REPOSITORY } from './persistence.interfaces';
import { TypeOrmKycCaseRepository } from './typeorm-kyc-case.repository';
import { TypeOrmWebhookEventRepository } from './typeorm-webhook-event.repository';
import { WEBHOOK_EVENT_REPOSITORY } from './webhook-event';
import { TypeOrmReferenceMappingRepository } from './typeorm-reference-mapping.repository';

/**
 * Owns the database connection. Only the repository interfaces (by token) are exported; the
 * TypeORM DataSource/repositories stay private to this module. Production DB is TBD.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildDataSourceOptions(
          config.getOrThrow<AppConfig['database']>('database'),
          config.getOrThrow<string>('nodeEnv'),
        ),
    }),
  ],
  providers: [
    TypeOrmKycCaseRepository,
    TypeOrmReferenceMappingRepository,
    TypeOrmWebhookEventRepository,
    TypeOrmDatabaseHealthCheck,
    { provide: DATABASE_HEALTH_CHECK, useExisting: TypeOrmDatabaseHealthCheck },
    { provide: WEBHOOK_EVENT_REPOSITORY, useExisting: TypeOrmWebhookEventRepository },
    { provide: KYC_CASE_REPOSITORY, useExisting: TypeOrmKycCaseRepository },
    { provide: REFERENCE_MAPPING_REPOSITORY, useExisting: TypeOrmReferenceMappingRepository },
  ],
  exports: [
    KYC_CASE_REPOSITORY,
    REFERENCE_MAPPING_REPOSITORY,
    WEBHOOK_EVENT_REPOSITORY,
    DATABASE_HEALTH_CHECK,
  ],
})
export class PersistenceModule {}
