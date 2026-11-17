import 'reflect-metadata';
import { loadEnvFile } from '../config/load-env-file';
import { writeFileSync } from 'node:fs';
import { DataSource } from 'typeorm';
import { loadConfiguration } from '../config/configuration';
import { StrictIsoFlexcubeDateNormalizer } from '../flexcube/flexcube-date-normalizer';
import { YesNoResidentParser } from '../flexcube/flexcube-resident-parser';
import { FlexcubeToCanonicalMapper } from '../flexcube/flexcube-to-canonical.mapper';
import { createFlexcubeSqlExecutor } from '../flexcube/staging/flexcube-status-updater.factory';
import { OracleSqlExecutor } from '../flexcube/staging/oracle-sql-executor';
import { ReferenceMappingService } from '../mapping/reference-mapping.service';
import { seedReferenceMappings } from '../mapping/seed/agreed-reference-mappings';
import { SingleSelectionSourceOfIncomeStrategy } from '../mapping/single-source-of-income.strategy';
import { buildDataSourceOptions } from '../persistence/database.config';
import { TypeOrmReferenceMappingRepository } from '../persistence/typeorm-reference-mapping.repository';
import { CanonicalToReisTransformer } from '../reis/canonical-to-reis.transformer';
import { ReisConfig } from '../reis/reis.config';
import { runUatCheck, UatCheckReport } from './flexcube-uat-check';

/**
 * CLI: `npm run check:uat1` - READ-ONLY check of the FLEXCUBE UAT database (no INSERT / UPDATE,
 * no REIS call). Needs FLEXCUBE_DB_USER / FLEXCUBE_DB_PASSWORD / FLEXCUBE_DB_CONNECT_STRING
 * (and optionally FLEXCUBE_DB_SCHEMA) in .env. Writes uat1-check-report.json (no customer data).
 */
async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfiguration();
  const db = createFlexcubeSqlExecutor(config.flexcube);
  if (!db) {
    throw new Error(
      'Set FLEXCUBE_DB_USER, FLEXCUBE_DB_PASSWORD and FLEXCUBE_DB_CONNECT_STRING in .env first',
    );
  }
  console.log(
    `Connecting to ${config.flexcube.dbConnectString} as ${config.flexcube.dbUser}` +
      (config.flexcube.dbSchema ? ` (schema ${config.flexcube.dbSchema})` : ''),
  );

  // Agreed reference lists in a throw-away in-memory database, for the dry run only.
  const local = new DataSource(
    buildDataSourceOptions({ type: 'sqlite', sqlitePath: ':memory:' }, 'development'),
  );
  await local.initialize();
  await local.runMigrations({ transaction: 'all' });
  const repo = new TypeOrmReferenceMappingRepository(local);
  await seedReferenceMappings(repo);
  const refs = new ReferenceMappingService(repo);

  let report: UatCheckReport;
  try {
    report = await runUatCheck(
      db,
      config.flexcube.stagingTable,
      {
        mapper: new FlexcubeToCanonicalMapper(
          new StrictIsoFlexcubeDateNormalizer(),
          new YesNoResidentParser(),
        ),
        transformer: new CanonicalToReisTransformer(
          refs,
          new SingleSelectionSourceOfIncomeStrategy(refs),
          { systemName: config.reis.systemName } as ReisConfig,
        ),
      },
      undefined,
      config.flexcube.syncStartDate,
      config.flexcube.keypersonTypeColumn,
    );
  } finally {
    if (db instanceof OracleSqlExecutor) await db.onModuleDestroy();
    await local.destroy();
  }

  writeFileSync('uat1-check-report.json', JSON.stringify(report, null, 2));
  print(report);
}

function print(r: UatCheckReport): void {
  const ok = (b: boolean) => (b ? 'OK  ' : 'FAIL');
  console.log(
    `\n[${ok(r.connected)}] Connection${r.connectionError ? ` - ${r.connectionError}` : ''}`,
  );
  if (!r.connected) return;
  console.log(`       user ${r.user}, current schema ${r.currentSchema}`);
  console.log('\nTables:');
  for (const t of r.tables) {
    console.log(
      `[${ok(t.readable && t.missingColumns.length === 0)}] ${t.table}` +
        (t.readable ? ` - ${t.rows} rows` : ` - ${t.error}`) +
        (t.missingColumns.length ? ` - missing columns: ${t.missingColumns.join(', ')}` : ''),
    );
    if (t.missingColumns.length && t.availableColumns.length) {
      console.log(`       available: ${t.availableColumns.join(', ')}`);
    }
  }
  console.log(
    `\nSimilar objects visible (KYC_MASTER / REIS / KEYPERSONS): ${r.similarObjects.join(' | ') || '(none)'}`,
  );
  if (r.staging) {
    const s = r.staging;
    console.log('\nStaging table privileges:');
    console.log(
      `[${ok(s.canInsert)}] INSERT   [${ok(s.canUpdate)}] UPDATE   [${ok(!s.hasDelete)}] no DELETE`,
    );
    console.log(
      `       granted: ${s.privileges.join(', ') || '(none visible)'}${s.ownedByUser ? ' (table owned by this user)' : ''}`,
    );
    console.log(`       rows by PROCESS_STATUS: ${JSON.stringify(s.processStatuses)}`);
    console.log(
      `       ours (UUID MSGID): ${JSON.stringify(s.processStatusesByOwner.ours)}  others: ${JSON.stringify(s.processStatusesByOwner.others)}`,
    );
    console.log('\nCHECK constraints of the staging table:');
    if (s.checkConstraints.length === 0) console.log('  (none visible)');
    for (const c of s.checkConstraints) console.log(`  ${c.name}: ${c.condition}`);
    console.log('Triggers of the staging table:');
    if (s.triggers.length === 0) console.log('  (none visible)');
    for (const t of s.triggers) console.log(`  ${t.name} (${t.type}, ${t.event}, ${t.status})`);
  }
  if (r.pending) {
    console.log(
      `\nSaved KYCs waiting for REIS: ${r.pending.total} (individual ${r.pending.individual}, corporate ${r.pending.corporate})` +
        (r.pending.error ? ` - ${r.pending.error}` : ''),
    );
  }
  if (r.recovery) {
    const x = r.recovery;
    console.log('\nOur staging rows against the current KYC versions (counts only):');
    for (const k of x.rows)
      console.log(`  ${k.rowKind.padEnd(13)} ${k.kycState.padEnd(20)} ${k.count}`);
    console.log(
      `  recoverable by the service (N, current MOD_NO): ${x.autoRecoverable}; E never sent: ${x.neverSentInE}; need a manual look: ${x.needsReview}`,
    );
    for (const m of x.neverSentMarkers)
      console.log(`  never-sent E marker ${m.marker}: ${m.count}`);
  }
  if (r.keypersonType) {
    const k = r.keypersonType;
    console.log(
      `\nKey-person type column ${k.configuredColumn}: ${k.present ? 'present' : 'NOT FOUND (corporate KYCs are not processed)'}` +
        (k.similarColumns.length
          ? ` - columns with TYPE in the name: ${k.similarColumns.join(', ')}`
          : ''),
    );
  }
  if (r.branches?.length) {
    console.log(
      `\nCut-off in use: ${r.cutoff ?? '(missing or invalid)'}. Latest MAKER_DT_STAMP per branch:`,
    );
    for (const b of r.branches) {
      console.log(`  ${b.branch}: ${b.latestMakerDate ?? '-'} (${b.kycs} KYCs)`);
    }
  }
  if (r.dryRun.length) {
    console.log('\nDry run (validation + mapping only, REIS not called, nothing written):');
    for (const d of r.dryRun) {
      console.log(
        `  ${d.result.padEnd(8)} ${d.type.padEnd(10)} ${d.kycRefNo} seq ${d.seqNo}${d.detail ? ` - ${d.detail}` : ''}`,
      );
    }
  }
  console.log('\nReport saved to uat1-check-report.json');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
