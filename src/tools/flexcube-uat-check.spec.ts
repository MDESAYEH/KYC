import { createTestDataSource } from '../../test/support/test-database';
import { StrictIsoFlexcubeDateNormalizer } from '../flexcube/flexcube-date-normalizer';
import { YesNoResidentParser } from '../flexcube/flexcube-resident-parser';
import { FlexcubeToCanonicalMapper } from '../flexcube/flexcube-to-canonical.mapper';
import { IFlexcubeSqlExecutor, SqlBinds, SqlRow } from '../flexcube/staging/flexcube-staging';
import { ReferenceMappingService } from '../mapping/reference-mapping.service';
import { seedReferenceMappings } from '../mapping/seed/agreed-reference-mappings';
import { SingleSelectionSourceOfIncomeStrategy } from '../mapping/single-source-of-income.strategy';
import { TypeOrmReferenceMappingRepository } from '../persistence/typeorm-reference-mapping.repository';
import { CanonicalToReisTransformer } from '../reis/canonical-to-reis.transformer';
import { ReisConfig } from '../reis/reis.config';
import { EXPECTED_COLUMNS, oraCode, runUatCheck, STAGING_COLUMNS } from './flexcube-uat-check';

const STAGING = 'STTM_KYC_REIS_PAYLOAD_CUSTOM';

/** Read-only fake of the UAT database; records every statement so writes can be detected. */
class FakeUat implements IFlexcubeSqlExecutor {
  statements: string[] = [];
  unreadable = new Set<string>();
  missing: Record<string, string[]> = {};
  privileges = ['SELECT', 'INSERT', 'UPDATE'];
  connectError: Error | null = null;
  pending: SqlRow[] = [];
  details = new Map<string, SqlRow>();

  async execute(sql: string): Promise<{ rowsAffected: number }> {
    this.statements.push(sql);
    throw new Error('the UAT check must never write');
  }

  async query(sql: string, b: SqlBinds): Promise<SqlRow[]> {
    this.statements.push(sql);
    if (sql.includes('FROM DUAL')) {
      if (this.connectError) throw this.connectError;
      return [{ U: 'KYC_INTEG', S: 'FCUBS' }];
    }
    if (sql.includes('ALL_TAB_COLUMNS')) {
      const all: Record<string, string[]> = { ...EXPECTED_COLUMNS, [STAGING]: STAGING_COLUMNS };
      return Object.entries(all).flatMap(([t, cols]) =>
        cols
          .filter((c) => !(this.missing[t] ?? []).includes(c))
          .map((c) => ({ TABLE_NAME: t, COLUMN_NAME: c })),
      );
    }
    if (sql.includes('USER_TABLES')) return [{ N: 0 }];
    if (sql.startsWith('SELECT COUNT(*) AS N FROM ')) {
      const t = sql.replace('SELECT COUNT(*) AS N FROM ', '');
      if (this.unreadable.has(t)) throw new Error('ORA-00942: table or view does not exist');
      return [{ N: 7 }];
    }
    if (sql.includes('ALL_TAB_PRIVS')) return this.privileges.map((p) => ({ PRIVILEGE: p }));
    if (sql.includes('GROUP BY PROCESS_STATUS')) return [{ S: 'S', N: 3 }];
    if (sql.includes('FROM STTM_KYC_MASTER m')) return this.pending;
    if (sql.includes('PRODUCT_CUSTOM')) return [{ PRODUCT_CODE: 'SALR' }];
    const d = this.details.get(String(b.kycRefNo));
    return d ? [d] : [];
  }
}

const SINCE = '2026-11-16';

const GOOD_INDIVIDUAL: SqlRow = {
  FIRST_NAME: 'Synthetic',
  LAST_NAME: 'Person',
  BIRTH_DATE: new Date(1985, 2, 15),
  PASSPORT_NO: 'P1',
  PEP: 'N',
  RELATION_PEP: 'N',
  NATIONALITY: 'LY',
  LOCAL_ADDR_COUNTRY: 'LY',
  OCCUPATION: 'PRSE',
  ACC_PURPOSE: 'JOBS',
  RESIDENT: 'Y',
  FUNDS_SOURCE: 'BUSN',
  TOTAL_INCOME: 3000,
  ACCOUNT_MANAGER_LOGIN: 'Test001',
  ACCOUNT_MANAGER_EMAIL: 'samer.elazabi@aiib.ly',
  DISTRIBUTION_CHANNEL: '00',
};

describe('UAT1 read-only check', () => {
  let pipeline: Parameters<typeof runUatCheck>[2];
  let db: FakeUat;

  beforeAll(async () => {
    const repo = new TypeOrmReferenceMappingRepository(await createTestDataSource());
    await seedReferenceMappings(repo);
    const refs = new ReferenceMappingService(repo);
    pipeline = {
      mapper: new FlexcubeToCanonicalMapper(
        new StrictIsoFlexcubeDateNormalizer(),
        new YesNoResidentParser(),
      ),
      transformer: new CanonicalToReisTransformer(
        refs,
        new SingleSelectionSourceOfIncomeStrategy(refs),
        { systemName: 'Flexcube' } as ReisConfig,
      ),
    };
  });
  beforeEach(() => (db = new FakeUat()));

  it('reports a healthy database and never writes', async () => {
    const r = await runUatCheck(db, STAGING, pipeline, 5, SINCE);
    expect(r).toMatchObject({ connected: true, user: 'KYC_INTEG', currentSchema: 'FCUBS' });
    expect(r.tables).toHaveLength(12);
    expect(r.tables.every((t) => t.readable && t.missingColumns.length === 0)).toBe(true);
    expect(r.staging).toMatchObject({ canInsert: true, canUpdate: true, hasDelete: false });
    expect(db.statements.every((s) => /^\s*SELECT/i.test(s))).toBe(true);
  });

  it('checks the pending-query columns and reports a missing cut-off without querying', async () => {
    expect(EXPECTED_COLUMNS.STTM_KYC_MASTER).toEqual(
      expect.arrayContaining(['RECORD_STAT', 'MAKER_DT_STAMP']),
    );
    const r = await runUatCheck(db, STAGING, pipeline, 5, undefined);
    expect(r.pending).toMatchObject({
      total: 0,
      error: 'FLEXCUBE_SYNC_START_DATE_MISSING_OR_INVALID',
    });
    expect(db.statements.some((s) => s.includes('FROM STTM_KYC_MASTER m'))).toBe(false);
  });

  it('expects the key-person tables and their columns', () => {
    expect(EXPECTED_COLUMNS.STTM_KYC_CORP_KEYPERSONS).toEqual(
      expect.arrayContaining(['KYC_ID', 'NAME', 'KYC_KEYPERSON_TYPE', 'RELATIONSHIP', 'TIN']),
    );
    expect(EXPECTED_COLUMNS.STTM_KYC_CORP_KEYPERSONS_CUSTOM).toEqual(
      expect.arrayContaining(['FIRST_NAME', 'LAST_NAME', 'PASSPORT_NUMBER', 'NATIONAL_ID']),
    );
  });

  it('reports a connection failure with the Oracle code only', async () => {
    db.connectError = new Error('ORA-01017: invalid username/password; logon denied');
    const r = await runUatCheck(db, STAGING, pipeline, 5, SINCE);
    expect(r).toEqual({
      connected: false,
      connectionError: 'ORA-01017',
      tables: [],
      similarObjects: [],
      dryRun: [],
    });
  });

  it('reports unreadable tables, missing columns and missing / extra privileges', async () => {
    db.unreadable.add('STTM_KYC_MASTER');
    db.missing = { STTM_KYC_RETAIL_CUSTOM: ['FUNDS_SOURCE'] };
    db.privileges = ['SELECT', 'DELETE'];
    const r = await runUatCheck(db, STAGING, pipeline, 5, SINCE);
    expect(r.tables.find((t) => t.table === 'STTM_KYC_MASTER')).toMatchObject({
      readable: false,
      error: 'ORA-00942',
    });
    const custom = r.tables.find((t) => t.table === 'STTM_KYC_RETAIL_CUSTOM');
    expect(custom?.missingColumns).toEqual(['FUNDS_SOURCE']);
    expect(custom?.availableColumns).not.toContain('FUNDS_SOURCE');
    expect(custom?.availableColumns).toContain('FIRST_NAME');
    expect(r.staging).toMatchObject({ canInsert: false, canUpdate: false, hasDelete: true });
  });

  it('dry-runs pending KYCs without values in the report', async () => {
    db.pending = [
      { KYC_REF_NO: 'K-OK', KYC_CUST_TYPE: 'R', MOD_NO: 1 },
      { KYC_REF_NO: 'K-BAD', KYC_CUST_TYPE: 'R', MOD_NO: 2 },
      { KYC_REF_NO: 'K-NONE', KYC_CUST_TYPE: 'C', MOD_NO: 1 },
    ];
    db.details.set('K-OK', GOOD_INDIVIDUAL);
    db.details.set('K-BAD', { ...GOOD_INDIVIDUAL, OCCUPATION: 'EMPL' });
    const r = await runUatCheck(db, STAGING, pipeline, 5, SINCE);
    expect(r.pending).toEqual({ total: 3, individual: 2, corporate: 1 });
    expect(r.dryRun).toEqual([
      { kycRefNo: 'K-OK', seqNo: 1, type: 'INDIVIDUAL', result: 'OK' },
      {
        kycRefNo: 'K-BAD',
        seqNo: 2,
        type: 'INDIVIDUAL',
        result: 'REJECTED',
        detail: 'UnmappedReferenceValueError: PROFESSION (value not in the agreed list)',
      },
      {
        kycRefNo: 'K-NONE',
        seqNo: 1,
        type: 'CORPORATE',
        result: 'REJECTED',
        detail: 'KycDetailsNotFoundError',
      },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/Synthetic|EMPL|samer/);
  });

  it('extracts only the Oracle error code', () => {
    expect(oraCode(new Error('ORA-12541: TNS:no listener'))).toBe('ORA-12541');
    expect(oraCode(new Error('NJS-503: connection to host x failed'))).toBe('NJS-503');
    expect(oraCode(new TypeError('boom'))).toBe('TypeError');
  });
});
