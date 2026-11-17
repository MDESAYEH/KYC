import { Logger } from '@nestjs/common';
import { AppConfig } from '../../config/configuration';
import { IFlexcubeStatusUpdater } from '../flexcube.interfaces';
import { MockFlexcubeStatusUpdater } from '../mock-flexcube-status-updater';
import { FinalStatusVocabulary, IFlexcubeSqlExecutor } from './flexcube-staging';
import { OracleSqlExecutor } from './oracle-sql-executor';
import { StagingFlexcubeStatusUpdater } from './staging-flexcube-status-updater';

export class FlexcubeDbConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlexcubeDbConfigError';
  }
}

/** Oracle executor when the FLEXCUBE database is configured, otherwise null. */
export function createFlexcubeSqlExecutor(
  flexcube: AppConfig['flexcube'],
): IFlexcubeSqlExecutor | null {
  const { dbUser, dbPassword, dbConnectString } = flexcube;
  const given = [dbUser, dbPassword, dbConnectString].filter((v) => v !== undefined).length;
  if (given === 0) return null;
  if (given !== 3) {
    throw new FlexcubeDbConfigError(
      'FLEXCUBE_DB_USER, FLEXCUBE_DB_PASSWORD and FLEXCUBE_DB_CONNECT_STRING must be set together',
    );
  }
  return new OracleSqlExecutor({
    user: dbUser as string,
    password: dbPassword as string,
    connectString: dbConnectString as string,
    ...(flexcube.dbSchema ? { schema: flexcube.dbSchema } : {}),
  });
}

/**
 * Real staging-table updater when the FLEXCUBE database is configured. Without it the mock is
 * used outside production only; production refuses to start (results would be lost).
 */
export function createFlexcubeStatusUpdater(
  executor: IFlexcubeSqlExecutor | null,
  flexcube: AppConfig['flexcube'],
  nodeEnv: string,
  logger: Pick<Logger, 'warn'> = new Logger('FlexcubeStatusUpdater'),
): IFlexcubeStatusUpdater {
  if (executor) {
    return new StagingFlexcubeStatusUpdater(
      executor,
      flexcube.stagingTable,
      flexcube.finalStatusVocabulary as FinalStatusVocabulary, // validated by decisionValues()
    );
  }
  if (nodeEnv === 'production') {
    throw new FlexcubeDbConfigError(
      'The FLEXCUBE database (FLEXCUBE_DB_*) must be configured in production',
    );
  }
  logger.warn('FLEXCUBE database not configured: final statuses go to the in-memory MOCK updater.');
  return new MockFlexcubeStatusUpdater();
}
