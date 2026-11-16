import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { DATABASE_HEALTH_CHECK, IDatabaseHealthCheck } from '../persistence/database-health';
import { buildDataSourceOptions } from '../persistence/database.config';
import { validateReisConfig } from '../reis/reis.config';

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  /** Only coarse states: never URLs, values, credentials, tokens or error details. */
  checks: {
    database: 'up' | 'down';
    configuration: 'ok' | 'invalid';
  };
}

const DB_PING_TIMEOUT_MS = 2000;

/**
 * Liveness and readiness. Readiness checks only what is meaningful at runtime: the database is
 * reachable and the required configuration is present/valid. It deliberately does NOT call REIS
 * (no authenticate traffic, no flapping on an external dependency); a REIS connectivity probe, if
 * ever added, must be separate and non-default.
 */
@Injectable()
export class HealthService {
  constructor(
    @Inject(DATABASE_HEALTH_CHECK) private readonly database: IDatabaseHealthCheck,
    private readonly config: ConfigService,
  ) {}

  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  async ready(): Promise<ReadinessReport> {
    const [databaseUp, configurationOk] = [await this.databaseUp(), this.configurationOk()];
    return {
      status: databaseUp && configurationOk ? 'ok' : 'unavailable',
      checks: {
        database: databaseUp ? 'up' : 'down',
        configuration: configurationOk ? 'ok' : 'invalid',
      },
    };
  }

  private async databaseUp(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), DB_PING_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.database.ping(), timeout]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private configurationOk(): boolean {
    try {
      const nodeEnv = this.config.getOrThrow<string>('nodeEnv');
      validateReisConfig(this.config.getOrThrow<AppConfig['reis']>('reis'), nodeEnv);
      buildDataSourceOptions(this.config.getOrThrow<AppConfig['database']>('database'), nodeEnv);
      return true;
    } catch {
      return false; // details are deliberately not exposed
    }
  }
}
