import { DataSource } from 'typeorm';
import { loadConfiguration } from '../config/configuration';
import { buildDataSourceOptions, MIGRATIONS } from './database.config';
import { UnsupportedDatabaseError } from './persistence.errors';

describe('buildDataSourceOptions', () => {
  it('builds SQLite options with synchronize disabled', () => {
    const o = buildDataSourceOptions({ type: 'sqlite', sqlitePath: ':memory:' }, 'development');
    expect(o.type).toBe('better-sqlite3');
    expect(o.synchronize).toBe(false);
    expect(o.migrationsRun).toBe(false);
  });

  it('refuses unknown database types (production DB is TBD)', () => {
    expect(() =>
      buildDataSourceOptions({ type: 'oracle', sqlitePath: undefined }, 'development'),
    ).toThrow(UnsupportedDatabaseError);
  });

  it('refuses SQLite in production', () => {
    expect(() =>
      buildDataSourceOptions({ type: 'sqlite', sqlitePath: 'x.db' }, 'production'),
    ).toThrow(UnsupportedDatabaseError);
  });

  it('requires a path for SQLite', () => {
    expect(() => buildDataSourceOptions({ type: 'sqlite', sqlitePath: undefined }, 'test')).toThrow(
      UnsupportedDatabaseError,
    );
  });
});

describe('database configuration from environment', () => {
  it('uses a local default outside production and none in production', () => {
    expect(loadConfiguration({}).database).toEqual({
      type: 'sqlite',
      sqlitePath: './var/kyc-local.sqlite',
    });
    expect(loadConfiguration({ NODE_ENV: 'production' }).database.sqlitePath).toBeUndefined();
    expect(loadConfiguration({ DB_SQLITE_PATH: '/tmp/x.db' }).database.sqlitePath).toBe(
      '/tmp/x.db',
    );
  });
});

describe('schema migrations', () => {
  const tables = async (ds: DataSource) =>
    (
      (await ds.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'migrations'",
      )) as { name: string }[]
    )
      .map((r) => r.name)
      .sort();

  it('the six legacy migrations create the original schema and revert cleanly', async () => {
    const ds = new DataSource({
      ...buildDataSourceOptions({ type: 'sqlite', sqlitePath: ':memory:' }, 'test'),
      migrations: MIGRATIONS.slice(0, 6),
    });
    await ds.initialize();
    try {
      expect(await tables(ds)).toEqual([]);
      await ds.runMigrations({ transaction: 'all' });
      expect(await tables(ds)).toEqual(['kyc_case', 'reference_mapping', 'webhook_event']);

      const cols = (await ds.query('PRAGMA table_info(kyc_case)')) as { name: string }[];
      expect(cols.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          'internal_id',
          'kyc_ref_no',
          'customer_no',
          'reis_system_id',
          'reis_customer_id',
          'risk_calculation_id',
          'reis_id',
          'customer_type',
          'internal_request_status',
          'reis_onboarding_status',
          'final_status',
          'retry_count',
          'last_error_code',
          'last_error_message',
          'created_at',
          'updated_at',
          // migration 2: REIS response text (sensitive: stored, never logged)
          'reis_instruction',
          'reis_error_message',
          // migration 3: FLEXCUBE update tracked separately from the REIS final status
          'flexcube_update_status',
          'flexcube_update_error_code',
          'flexcube_update_error_message',
          'flexcube_updated_at',
          // migration 4: attempt tracking for FLEXCUBE updates / operator recovery
          'flexcube_update_attempt_count',
          'flexcube_last_attempt_at',
        ]),
      );
      const auditCols = (await ds.query('PRAGMA table_info(webhook_event)')) as { name: string }[];
      expect(auditCols.map((c) => c.name).sort()).toEqual(
        [
          'detail_code',
          'event_id',
          'incoming_customer_id',
          'incoming_status',
          'kyc_case_internal_id',
          'processed_at',
          'processing_result',
          'received_at',
          'service_type',
          'system_id',
          'system_name',
        ].sort(),
      );

      // Entities and migrations agree: the schema builder has nothing to change.
      const pending = await ds.driver.createSchemaBuilder().log();
      expect(pending.upQueries.map((q) => q.query)).toEqual([]);

      // Revert one migration at a time, each cleanly.
      const names = async () =>
        ((await ds.query('PRAGMA table_info(kyc_case)')) as { name: string }[]).map((c) => c.name);
      expect(await names()).toContain('revision_count');
      await ds.undoLastMigration({ transaction: 'all' }); // migration 6
      expect(await names()).not.toContain('revision_count');
      expect(await names()).toContain('seq_no');
      await ds.undoLastMigration({ transaction: 'all' }); // migration 5
      expect(await names()).not.toContain('seq_no');
      expect(await names()).toContain('flexcube_update_attempt_count');
      await ds.undoLastMigration({ transaction: 'all' }); // migration 4
      expect(await tables(ds)).toEqual(['kyc_case', 'reference_mapping', 'webhook_event']);
      expect(await names()).not.toContain('flexcube_update_attempt_count');
      expect(await names()).not.toContain('flexcube_last_attempt_at');
      expect(await names()).toContain('flexcube_update_status');
      await ds.undoLastMigration({ transaction: 'all' }); // migration 3
      expect(await tables(ds)).toEqual(['kyc_case', 'reference_mapping']);
      expect(await names()).not.toContain('flexcube_update_status');
      expect(await names()).toContain('reis_instruction');
      await ds.undoLastMigration({ transaction: 'all' }); // migration 2
      expect(await names()).not.toContain('reis_instruction');
      await ds.undoLastMigration({ transaction: 'all' }); // migration 1
      expect(await tables(ds)).toEqual([]);
    } finally {
      await ds.destroy();
    }
  });

  it('the current schema retains its permanent resume journal when rollback is requested', async () => {
    const ds = new DataSource(
      buildDataSourceOptions({ type: 'sqlite', sqlitePath: ':memory:' }, 'test'),
    );
    await ds.initialize();
    try {
      await ds.runMigrations({ transaction: 'all' });
      expect(await tables(ds)).toEqual([
        'kyc_case',
        'kyc_resume_attempt',
        'kyc_resume_event',
        'kyc_resume_reservation',
        'reference_mapping',
        'webhook_event',
      ]);
      await ds.query(
        "INSERT INTO kyc_resume_attempt VALUES ('synthetic','scope','RESUME','{}','synthetic','synthetic')",
      );
      await ds.query(
        "INSERT INTO kyc_resume_reservation VALUES ('scope','synthetic','synthetic','synthetic')",
      );
      const before = await ds.query('SELECT * FROM migrations');
      await expect(ds.undoLastMigration({ transaction: 'all' })).rejects.toThrow(
        'PRESERVE_RESERVATIONS_AND_EVIDENCE',
      );
      expect(await ds.query('SELECT * FROM migrations')).toEqual(before);
      expect(await ds.query('SELECT * FROM kyc_resume_reservation')).toHaveLength(1);
    } finally {
      await ds.destroy();
    }
  });

  it('enforces unique KYC_REF_NO / systemId and unique (type, FLEXCUBE value) at schema level', async () => {
    const ds = new DataSource(
      buildDataSourceOptions({ type: 'sqlite', sqlitePath: ':memory:' }, 'test'),
    );
    await ds.initialize();
    try {
      await ds.runMigrations({ transaction: 'all' });
      const insertCase = (id: string, ref: string, sys: string) =>
        ds.query(
          "INSERT INTO kyc_case (internal_id,kyc_ref_no,reis_system_id,customer_type,internal_request_status) VALUES (?,?,?,'INDIVIDUAL','RECEIVED')",
          [id, ref, sys],
        );
      await insertCase('1', 'K', 'S');
      await expect(insertCase('2', 'K', 'S2')).rejects.toThrow(/unique/i);
      await expect(insertCase('3', 'K3', 'S')).rejects.toThrow(/unique/i);

      const insertMap = () =>
        ds.query(
          "INSERT INTO reference_mapping (mapping_type,flexcube_value,reis_value) VALUES ('PRODUCT','P','R')",
        );
      await insertMap();
      await expect(insertMap()).rejects.toThrow(/unique/i);
    } finally {
      await ds.destroy();
    }
  });
});
