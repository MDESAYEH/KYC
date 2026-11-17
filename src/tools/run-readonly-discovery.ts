import 'reflect-metadata';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { loadConfiguration } from '../config/configuration';
import { loadEnvFile } from '../config/load-env-file';
import { createFlexcubeSqlExecutor } from '../flexcube/staging/flexcube-status-updater.factory';
import { OracleSqlExecutor } from '../flexcube/staging/oracle-sql-executor';
import { DiscoveryOptions, runReadOnlyDiscovery } from './readonly-discovery';

/**
 * CLI: `npm run discover:uat1 -- --report <NEW file> [--part cif|status|all] [--owner OWNER] [--table T]
 *       [--max 200] [--fragments CIF,CUSTOMER,KYC] [--candidate OWNER.TABLE]`
 *
 * READ-ONLY. Uses the application's own Oracle executor and the FLEXCUBE_DB_* values the tools already
 * read (never printed). Only SELECTs run; nothing is written to Oracle or to the local database; the
 * service, the systemd unit and .env are not touched. The full result goes to a NEW protected file
 * (mode 600, never overwritten); the console shows only query names, row counts and Oracle codes.
 * No customer data is selected by any query (metadata, code lines and grouped counts only).
 */
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};

async function main(): Promise<void> {
  const report = arg('--report');
  if (!report) throw new Error('--report <new protected file> is required');
  const part = (arg('--part') ?? 'all') as DiscoveryOptions['part'];
  if (!['cif', 'status', 'all'].includes(part))
    throw new Error('--part must be cif, status or all');
  const [candidateOwner, candidateTable] = (arg('--candidate') ?? '').split('.');
  loadEnvFile();
  const config = loadConfiguration();
  const db = createFlexcubeSqlExecutor(config.flexcube);
  if (!db) throw new Error('FLEXCUBE_DB_* is not configured');
  try {
    const result = await runReadOnlyDiscovery(db, {
      part,
      owner: arg('--owner'),
      table: arg('--table'),
      maxRows: arg('--max') ? Number(arg('--max')) : undefined,
      fragments: arg('--fragments')
        ?.split(',')
        .map((f) => f.trim()),
      candidateOwner: candidateOwner || undefined,
      candidateTable: candidateTable || undefined,
    });
    const fd = openSync(report, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(result, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    console.log(
      JSON.stringify({
        report,
        resolvedOwner: result.resolvedOwner,
        queries: result.queries.map((q) => ({ name: q.name, rows: q.rowCount, error: q.error })),
      }),
    );
  } finally {
    if (db instanceof OracleSqlExecutor) await db.onModuleDestroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'discovery failed');
  process.exit(1);
});
