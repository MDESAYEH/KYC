import { IReferenceMappingRepository } from '../../src/mapping/mapping.interfaces';
import {
  assertValidMappingInput,
  ReferenceMappingEntry,
  ReferenceMappingInput,
  ReferenceMappingType,
  UnmappedReferenceValueError,
} from '../../src/mapping/reference-mapping';
import { ReferenceMappingService } from '../../src/mapping/reference-mapping.service';

/** In-memory IReferenceMappingRepository for transformation tests (no database needed). */
export class InMemoryReferenceMappings implements IReferenceMappingRepository {
  private rows: ReferenceMappingEntry[] = [];
  private nextId = 1;

  async findActive(type: ReferenceMappingType, value: string) {
    return (
      this.rows.find((r) => r.mappingType === type && r.flexcubeValue === value && r.active) ?? null
    );
  }
  async find(type: ReferenceMappingType, value: string) {
    return this.rows.find((r) => r.mappingType === type && r.flexcubeValue === value) ?? null;
  }
  async upsert(input: ReferenceMappingInput) {
    assertValidMappingInput(input);
    const existing = await this.find(input.mappingType, input.flexcubeValue);
    const now = new Date();
    if (existing) {
      Object.assign(existing, {
        reisValue: input.reisValue,
        description: input.description ?? null,
        active: input.active ?? true,
        updatedAt: now,
      });
      return existing;
    }
    const row: ReferenceMappingEntry = {
      id: this.nextId++,
      mappingType: input.mappingType,
      flexcubeValue: input.flexcubeValue,
      reisValue: input.reisValue,
      description: input.description ?? null,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return row;
  }
  async setActive(type: ReferenceMappingType, value: string, active: boolean) {
    const row = await this.find(type, value);
    if (!row) throw new UnmappedReferenceValueError(type, value);
    row.active = active;
    return row;
  }
  async list(type?: ReferenceMappingType) {
    return this.rows.filter((r) => !type || r.mappingType === type);
  }
}

/**
 * Synthetic reference data for tests ONLY. These are NOT Bank-approved mappings; the values are
 * deliberately fake (T-/R- prefixes) and include nothing for corporate purposes 203/204.
 */
export async function seededMappings(): Promise<{
  repo: InMemoryReferenceMappings;
  service: ReferenceMappingService;
}> {
  const repo = new InMemoryReferenceMappings();
  const T = ReferenceMappingType;
  const rows: [ReferenceMappingType, string, string][] = [
    [T.NATIONALITY, 'T-NAT', 'R-NAT'],
    [T.NATIONALITY, 'T-CIT', 'R-CIT'],
    [T.NATIONALITY, 'T-INC', 'R-INC'],
    [T.NATIONALITY, 'T-OP1', 'R-OP1'],
    [T.NATIONALITY, 'T-OP2', 'R-OP2'],
    [T.NATIONALITY, 'T-REL-NAT', 'R-REL-NAT'],
    [T.NATIONALITY, 'T-REL-CIT', 'R-REL-CIT'],
    [T.PROFESSION, 'T-PROF', 'R-PROF'],
    [T.ACCOUNT_PURPOSE_INDIVIDUAL, 'T-APIND', 'R-APIND'],
    [T.ACCOUNT_PURPOSE_CORPORATE, 'T-APCORP', 'R-APCORP'],
    [T.PRODUCT, 'T-PROD', 'R-PROD'],
    [T.LEGAL_ENTITY, 'T-LEGAL', 'R-LEGAL'],
    [T.ACTIVITY, 'T-ACT', 'R-ACT'],
    [T.DISTRIBUTION_CHANNEL, 'T-CHAN', 'R-CHAN'],
    [T.SOURCE_OF_INCOME, 'T-SALARY', 'R-SALARY'],
    [T.SOURCE_OF_INCOME, 'T-RENTAL', 'R-RENTAL'],
    [T.SOURCE_OF_INCOME, 'T-CORP-INC', 'R-CORP-INC'],
    [T.DOCUMENT_TYPE, 'T-DOC', 'R-DOC'],
  ];
  for (const [mappingType, flexcubeValue, reisValue] of rows) {
    await repo.upsert({ mappingType, flexcubeValue, reisValue });
  }
  return { repo, service: new ReferenceMappingService(repo) };
}
