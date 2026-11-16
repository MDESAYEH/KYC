import { DataSourceOptions } from 'typeorm';
import { AppConfig } from '../config/configuration';
import { KycCaseEntity } from './entities/kyc-case.entity';
import { ReferenceMappingEntity } from './entities/reference-mapping.entity';
import { WebhookEventEntity } from './entities/webhook-event.entity';
import { InitialSchema1790000000000 } from './migrations/1790000000000-InitialSchema';
import { AddReisResponseText1790000000001 } from './migrations/1790000000001-AddReisResponseText';
import { FlexcubeUpdateStateAndWebhookAudit1790000000002 } from './migrations/1790000000002-FlexcubeUpdateStateAndWebhookAudit';
import { FlexcubeUpdateAttemptTracking1790000000003 } from './migrations/1790000000003-FlexcubeUpdateAttemptTracking';
import { SubmissionSeqNo1790000000004 } from './migrations/1790000000004-SubmissionSeqNo';
import { UnsupportedDatabaseError } from './persistence.errors';

export const ENTITIES = [KycCaseEntity, ReferenceMappingEntity, WebhookEventEntity];
export const MIGRATIONS = [
  InitialSchema1790000000000,
  AddReisResponseText1790000000001,
  FlexcubeUpdateStateAndWebhookAudit1790000000002,
  FlexcubeUpdateAttemptTracking1790000000003,
  SubmissionSeqNo1790000000004,
];

/**
 * Builds TypeORM options from configuration. The production database is TBD, so only SQLite
 * (local dev/test) is supported; any other type, or SQLite in production, fails loudly instead
 * of guessing. Schema synchronization is never enabled: use migrations.
 */
export function buildDataSourceOptions(
  database: AppConfig['database'],
  nodeEnv: string,
): DataSourceOptions {
  if (database.type !== 'sqlite') {
    throw new UnsupportedDatabaseError(
      `DB_TYPE "${database.type}" is not supported yet: the production database is TBD.`,
    );
  }
  if (nodeEnv === 'production') {
    throw new UnsupportedDatabaseError(
      'SQLite is for local development/testing only and cannot be used with NODE_ENV=production.',
    );
  }
  if (!database.sqlitePath) {
    throw new UnsupportedDatabaseError('DB_SQLITE_PATH is required for DB_TYPE=sqlite.');
  }
  return {
    type: 'better-sqlite3',
    database: database.sqlitePath,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    synchronize: false,
    migrationsRun: false,
  };
}
