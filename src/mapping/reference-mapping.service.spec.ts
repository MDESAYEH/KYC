import { DataSource } from 'typeorm';
import { createTestDataSource } from '../../test/support/test-database';
import { TypeOrmReferenceMappingRepository } from '../persistence/typeorm-reference-mapping.repository';
import { IReferenceMappingRepository } from './mapping.interfaces';
import {
  InvalidReferenceMappingError,
  ReferenceMappingType as T,
  UnmappedReferenceValueError,
} from './reference-mapping';
import { ReferenceMappingService } from './reference-mapping.service';

// All values below are synthetic test data, NOT Bank-approved mappings.
describe('ReferenceMappingService + repository (isolated SQLite)', () => {
  let ds: DataSource;
  let repo: IReferenceMappingRepository;
  let service: ReferenceMappingService;

  beforeEach(async () => {
    ds = await createTestDataSource();
    repo = new TypeOrmReferenceMappingRepository(ds);
    service = new ReferenceMappingService(repo);
  });
  afterEach(async () => {
    await ds.destroy();
  });

  it('starts empty: no business mappings are seeded', async () => {
    expect(await repo.list()).toEqual([]);
  });

  it('resolves an active mapping to the REIS value', async () => {
    await repo.upsert({ mappingType: T.NATIONALITY, flexcubeValue: 'T-A', reisValue: 'R-A' });
    await expect(service.resolve(T.NATIONALITY, 'T-A')).resolves.toBe('R-A');
  });

  it('stores id, description, active and timestamps', async () => {
    const e = await repo.upsert({
      mappingType: T.PRODUCT,
      flexcubeValue: 'P1',
      reisValue: 'RP1',
      description: 'test row',
    });
    expect(e).toMatchObject({
      mappingType: T.PRODUCT,
      flexcubeValue: 'P1',
      reisValue: 'RP1',
      description: 'test row',
      active: true,
    });
    expect(typeof e.id).toBe('number');
    expect(e.createdAt).toBeInstanceOf(Date);
    expect(e.updatedAt).toBeInstanceOf(Date);
  });

  it('does not return inactive mappings', async () => {
    await repo.upsert({
      mappingType: T.PROFESSION,
      flexcubeValue: 'X',
      reisValue: 'RX',
      active: false,
    });
    expect(await repo.findActive(T.PROFESSION, 'X')).toBeNull();
    expect(await repo.find(T.PROFESSION, 'X')).not.toBeNull();
    await expect(service.resolve(T.PROFESSION, 'X')).rejects.toBeInstanceOf(
      UnmappedReferenceValueError,
    );
  });

  it('activating and deactivating changes lookup results', async () => {
    await repo.upsert({ mappingType: T.ACTIVITY, flexcubeValue: 'A', reisValue: 'RA' });
    await repo.setActive(T.ACTIVITY, 'A', false);
    await expect(service.resolve(T.ACTIVITY, 'A')).rejects.toBeInstanceOf(
      UnmappedReferenceValueError,
    );
    await repo.setActive(T.ACTIVITY, 'A', true);
    await expect(service.resolve(T.ACTIVITY, 'A')).resolves.toBe('RA');
  });

  it('throws UnmappedReferenceValueError for an unknown value (no pass-through)', async () => {
    const err = await service.resolve(T.LEGAL_ENTITY, 'unknown').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnmappedReferenceValueError);
    expect(err).toMatchObject({ mappingType: T.LEGAL_ENTITY, flexcubeValue: 'unknown' });
  });

  it('keeps the same FLEXCUBE value independent across mapping types', async () => {
    await repo.upsert({
      mappingType: T.ACCOUNT_PURPOSE_INDIVIDUAL,
      flexcubeValue: '1',
      reisValue: 'IND-1',
    });
    await repo.upsert({
      mappingType: T.ACCOUNT_PURPOSE_CORPORATE,
      flexcubeValue: '1',
      reisValue: 'CORP-1',
    });
    await repo.upsert({ mappingType: T.NATIONALITY, flexcubeValue: '1', reisValue: 'NAT-1' });
    await expect(service.resolve(T.ACCOUNT_PURPOSE_INDIVIDUAL, '1')).resolves.toBe('IND-1');
    await expect(service.resolve(T.ACCOUNT_PURPOSE_CORPORATE, '1')).resolves.toBe('CORP-1');
    await expect(service.resolve(T.NATIONALITY, '1')).resolves.toBe('NAT-1');
    await expect(service.resolve(T.PRODUCT, '1')).rejects.toBeInstanceOf(
      UnmappedReferenceValueError,
    );
    // Deactivating one type does not affect the others.
    await repo.setActive(T.NATIONALITY, '1', false);
    await expect(service.resolve(T.ACCOUNT_PURPOSE_INDIVIDUAL, '1')).resolves.toBe('IND-1');
  });

  it('matches exactly: case-sensitive, no trimming, no folding', async () => {
    await repo.upsert({ mappingType: T.DISTRIBUTION_CHANNEL, flexcubeValue: 'Ab', reisValue: 'R' });
    await expect(service.resolve(T.DISTRIBUTION_CHANNEL, 'Ab')).resolves.toBe('R');
    for (const v of ['ab', 'AB', ' Ab', 'Ab ', '']) {
      await expect(service.resolve(T.DISTRIBUTION_CHANNEL, v)).rejects.toBeInstanceOf(
        UnmappedReferenceValueError,
      );
    }
  });

  it('keeps the numeric-looking code "203" distinct from "0203" and never invents a meaning', async () => {
    await repo.upsert({
      mappingType: T.ACCOUNT_PURPOSE_CORPORATE,
      flexcubeValue: '0203',
      reisValue: 'TEST-ONLY',
    });
    await expect(service.resolve(T.ACCOUNT_PURPOSE_CORPORATE, '203')).rejects.toBeInstanceOf(
      UnmappedReferenceValueError,
    );
    await expect(service.resolve(T.ACCOUNT_PURPOSE_CORPORATE, '204')).rejects.toBeInstanceOf(
      UnmappedReferenceValueError,
    );
  });

  it('supports SOURCE_OF_INCOME as a plain per-value mapping (no aggregation rule)', async () => {
    await repo.upsert({
      mappingType: T.SOURCE_OF_INCOME,
      flexcubeValue: 'SALARY',
      reisValue: 'R-SAL',
    });
    await expect(service.resolve(T.SOURCE_OF_INCOME, 'SALARY')).resolves.toBe('R-SAL');
    // A combined value is NOT synthesized from individual ones.
    await expect(service.resolve(T.SOURCE_OF_INCOME, 'SALARY,RENTAL')).rejects.toBeInstanceOf(
      UnmappedReferenceValueError,
    );
  });

  it('upsert updates the existing row instead of duplicating it', async () => {
    const a = await repo.upsert({
      mappingType: T.DOCUMENT_TYPE,
      flexcubeValue: 'D',
      reisValue: 'R1',
    });
    const b = await repo.upsert({
      mappingType: T.DOCUMENT_TYPE,
      flexcubeValue: 'D',
      reisValue: 'R2',
      description: 'changed',
    });
    expect(b.id).toBe(a.id);
    expect(b.reisValue).toBe('R2');
    expect(await repo.list(T.DOCUMENT_TYPE)).toHaveLength(1);
  });

  it('rejects ambiguous or empty stored values', async () => {
    const bad = [
      { flexcubeValue: '', reisValue: 'R' },
      { flexcubeValue: ' X', reisValue: 'R' },
      { flexcubeValue: 'X', reisValue: '  ' },
      { flexcubeValue: 'X', reisValue: 'R ' },
    ];
    for (const b of bad) {
      await expect(repo.upsert({ mappingType: T.PRODUCT, ...b })).rejects.toBeInstanceOf(
        InvalidReferenceMappingError,
      );
    }
    await expect(
      repo.upsert({ mappingType: 'BOGUS' as T, flexcubeValue: 'X', reisValue: 'R' }),
    ).rejects.toBeInstanceOf(InvalidReferenceMappingError);
  });

  it('setActive on a missing mapping throws UnmappedReferenceValueError', async () => {
    await expect(repo.setActive(T.PRODUCT, 'none', true)).rejects.toBeInstanceOf(
      UnmappedReferenceValueError,
    );
  });
});
