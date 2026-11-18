import { loadConfiguration } from '../config/configuration';
import { loadEnvFile } from '../config/load-env-file';
import { oraCode } from '../flexcube/oracle-error';
import { createFlexcubeSqlExecutor } from '../flexcube/staging/flexcube-status-updater.factory';
import { OracleSqlExecutor } from '../flexcube/staging/oracle-sql-executor';
import { CatalogEntry, collectSqlCatalog } from './sql-catalog';

/**
 * CLI: `npm run check:oracle-sql`  (READ-ONLY, PARSE ONLY)
 *
 * Hands every statement the integration layer can send (see sql-catalog.ts) to Oracle's PARSER with
 * connection.getStatementInfo(): nothing is executed, no row is read or changed, nothing is
 * committed, no table is created. DDL / PL/SQL / DELETE are refused before Oracle is called.
 * For each statement it reports whether Oracle accepts it and whether the bind names Oracle sees
 * are exactly the ones the code sends. This is the evidence that the ORA-01745 fix is right on the
 * real UAT1 objects (synonyms, columns, privileges) WITHOUT an UPDATE / ROLLBACK on the bank database.
 * Output: statement names, Oracle codes and counts only (the SQL text holds no customer data).
 */
export interface SqlCheckLine {
  name: string;
  ok: boolean;
  error?: string;
  missingBinds?: string[];
  extraBinds?: string[];
}

export async function checkOracleSql(
  db: Pick<OracleSqlExecutor, 'describe'>,
  catalog: CatalogEntry[],
): Promise<SqlCheckLine[]> {
  const lines: SqlCheckLine[] = [];
  for (const entry of catalog) {
    try {
      const info = await db.describe(entry.sql);
      const missing = entry.bindNames.filter((n) => !info.bindNames.includes(n));
      const extra = info.bindNames.filter((n) => !entry.bindNames.includes(n));
      const ok = missing.length === 0 && extra.length === 0;
      lines.push({
        name: entry.name,
        ok,
        ...(ok ? {} : { missingBinds: missing, extraBinds: extra }),
      });
    } catch (error) {
      lines.push({ name: entry.name, ok: false, error: oraCode(error) });
    }
  }
  return lines;
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfiguration();
  const db = createFlexcubeSqlExecutor(config.flexcube);
  if (!(db instanceof OracleSqlExecutor)) throw new Error('FLEXCUBE_DB_* is not configured');
  try {
    const catalog = await collectSqlCatalog({
      stagingTable: config.flexcube.stagingTable,
      inProgressStatus: config.flexcube.stagingStatusInProgress,
      keypersonTypeColumn: config.flexcube.keypersonTypeColumn,
    });
    const lines = await checkOracleSql(db, catalog);
    for (const l of lines) {
      const detail = l.error
        ? ` - ${l.error}`
        : l.ok
          ? ''
          : ` - binds missing ${JSON.stringify(l.missingBinds)} extra ${JSON.stringify(l.extraBinds)}`;
      console.log(`[${l.ok ? 'OK  ' : 'FAIL'}] ${l.name}${detail}`);
    }
    const failed = lines.filter((l) => !l.ok).length;
    console.log(
      `\n${lines.length - failed}/${lines.length} statements parsed by Oracle. Nothing was executed.`,
    );
    if (failed > 0) process.exitCode = 1;
  } finally {
    await db.onModuleDestroy();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(oraCode(err));
    process.exit(1);
  });
}
