import { loadConfiguration } from '../config/configuration';
import { loadEnvFile } from '../config/load-env-file';
import { backupSqlite } from './sqlite-backup';

/**
 * CLI: `npm run backup:sqlite -- <destination-file>`
 * Consistent online backup of the local SQLite database (DB_SQLITE_PATH) with SQLite's backup API,
 * safe while the service is running. Never overwrites; prints size, SHA-256 and the integrity result.
 */
async function main(): Promise<void> {
  loadEnvFile();
  const destination = process.argv[2];
  if (!destination) throw new Error('Usage: npm run backup:sqlite -- <destination-file>');
  const config = loadConfiguration();
  if (config.database.type !== 'sqlite' || !config.database.sqlitePath) {
    throw new Error('DB_TYPE is not sqlite or DB_SQLITE_PATH is not set');
  }
  const result = await backupSqlite(config.database.sqlitePath, destination);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'backup failed');
  process.exit(1);
});
