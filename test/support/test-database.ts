import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/persistence/database.config';

/**
 * Creates an isolated in-memory SQLite database (one per call) and applies the real
 * migrations - no schema synchronization - so tests exercise the production-style schema.
 */
export async function createTestDataSource(): Promise<DataSource> {
  const ds = new DataSource(
    buildDataSourceOptions({ type: 'sqlite', sqlitePath: ':memory:' }, 'test'),
  );
  await ds.initialize();
  await ds.runMigrations({ transaction: 'all' });
  return ds;
}
