import 'reflect-metadata';
import { loadEnvFile } from '../config/load-env-file';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DataSource } from 'typeorm';
import { loadConfiguration } from '../config/configuration';
import { buildDataSourceOptions } from './database.config';

/**
 * CLI: `node dist/persistence/run-migrations.js [revert]`.
 * Reads DB settings from the environment; never synchronizes the schema.
 */
async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfiguration();
  const options = buildDataSourceOptions(config.database, config.nodeEnv);
  const file = config.database.sqlitePath;
  if (file && file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const dataSource = new DataSource(options);
  await dataSource.initialize();
  try {
    if (process.argv[2] === 'revert') {
      await dataSource.undoLastMigration({ transaction: 'all' });
      console.log('Reverted last migration.');
    } else {
      const ran = await dataSource.runMigrations({ transaction: 'all' });
      console.log(
        ran.length ? `Applied: ${ran.map((m) => m.name).join(', ')}` : 'No pending migrations.',
      );
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
