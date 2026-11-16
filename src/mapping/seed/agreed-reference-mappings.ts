import { ReferenceMappingInput, ReferenceMappingType } from '../reference-mapping';
import { IReferenceMappingRepository } from '../mapping.interfaces';
import data from './appendix-v1.4.data.json';

/**
 * Agreed reference lists (AIIB_KYC_Appendix.xlsx, Reis V1.4). FLEXCUBE stores the agreed Reis
 * codes, so every entry maps a code to itself; a value outside the lists stays unmapped and is
 * rejected before any REIS call (e.g. deactivated FLEXCUBE countries such as DBZ or EU).
 * Generated from the appendix: regenerate this JSON when the appendix changes.
 */
export function agreedReferenceMappings(): ReferenceMappingInput[] {
  const out: ReferenceMappingInput[] = [];
  for (const [type, entries] of Object.entries(data.mappings)) {
    if (!Object.values(ReferenceMappingType).includes(type as ReferenceMappingType)) {
      throw new Error(`Unknown mapping type in seed data: ${type}`);
    }
    for (const e of entries) {
      out.push({
        mappingType: type as ReferenceMappingType,
        flexcubeValue: e.flexcubeValue,
        reisValue: e.reisValue,
        description: e.description ?? null,
        active: true,
      });
    }
  }
  return out;
}

export interface SeedSummary {
  total: number;
  inserted: number;
  updated: number;
  /** Existing rows switched off by an administrator and left off. */
  keptInactive: number;
  byType: Record<string, number>;
}

export interface SeedOptions {
  /** Explicit operator choice to switch every agreed code back on. Default false. */
  reactivate?: boolean;
}

/**
 * Idempotent: inserts missing codes and refreshes the value / description of existing ones.
 * A code an administrator switched off STAYS off unless `reactivate` is requested explicitly
 * (`npm run mappings:seed -- --reactivate`). Uniqueness is (mapping type, FLEXCUBE value).
 */
export async function seedReferenceMappings(
  repository: Pick<IReferenceMappingRepository, 'upsert' | 'find'>,
  mappings: ReferenceMappingInput[] = agreedReferenceMappings(),
  options: SeedOptions = {},
): Promise<SeedSummary> {
  const summary: SeedSummary = { total: 0, inserted: 0, updated: 0, keptInactive: 0, byType: {} };
  for (const m of mappings) {
    const existing = await repository.find(m.mappingType, m.flexcubeValue);
    const keepOff = existing !== null && !existing.active && !options.reactivate;
    await repository.upsert({ ...m, active: keepOff ? false : (m.active ?? true) });
    if (!existing) summary.inserted++;
    else summary.updated++;
    if (keepOff) summary.keptInactive++;
    summary.byType[m.mappingType] = (summary.byType[m.mappingType] ?? 0) + 1;
    summary.total++;
  }
  return summary;
}
