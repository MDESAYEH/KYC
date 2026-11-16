import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** Cheap "is the database reachable" probe for readiness checks. Never throws, exposes no details. */
export interface IDatabaseHealthCheck {
  ping(): Promise<boolean>;
}
export const DATABASE_HEALTH_CHECK = Symbol('IDatabaseHealthCheck');

@Injectable()
export class TypeOrmDatabaseHealthCheck implements IDatabaseHealthCheck {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async ping(): Promise<boolean> {
    try {
      if (!this.dataSource.isInitialized) return false;
      await this.dataSource.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
