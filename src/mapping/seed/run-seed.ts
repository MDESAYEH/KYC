import 'reflect-metadata';
import { loadEnvFile } from '../../config/load-env-file';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DataSource } from 'typeorm';
import { loadConfiguration } from '../../config/configuration';
import { buildDataSourceOptions } from '../../persistence/database.config';
import { TypeOrmReferenceMappingRepository } from '../../persistence/typeorm-reference-mapping.repository';
import { seedReferenceMappings } from './agreed-reference-mappings';

/**
 * CLI: `node dist/mapping/seed/run-seed.js [--reactivate]` - loads the agreed reference lists
 * (idempotent). Codes switched off by an administrator stay off unless --reactivate is given.
 */
async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfiguration();
  const file = config.database.sqlitePath;
  if (file && file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const dataSource = new DataSource(buildDataSourceOptions(config.database, config.nodeEnv));
  await dataSource.initialize();
  try {
    const summary = await seedReferenceMappings(
      new TypeOrmReferenceMappingRepository(dataSource),
      undefined,
      { reactivate: process.argv.includes('--reactivate') },
    );
    console.log(
      `Reference mappings: ${summary.total} (inserted ${summary.inserted}, updated ${summary.updated}, kept inactive ${summary.keptInactive})`,
      summary.byType,
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
