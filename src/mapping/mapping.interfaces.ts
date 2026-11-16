import {
  ReferenceMappingEntry,
  ReferenceMappingInput,
  ReferenceMappingType,
} from './reference-mapping';

/**
 * FLEXCUBE value -> REIS value.
 * Rule: exact, case-sensitive match on an ACTIVE mapping of the given type. No trimming,
 * no case folding, no pass-through. Throws UnmappedReferenceValueError if none exists.
 */
export interface IReferenceMappingService {
  resolve(type: ReferenceMappingType, flexcubeValue: string): Promise<string>;
}
export const REFERENCE_MAPPING_SERVICE = Symbol('IReferenceMappingService');

/** Storage for mappings; implemented inside the persistence module. */
export interface IReferenceMappingRepository {
  /** Active mapping for (type, value), or null. */
  findActive(
    type: ReferenceMappingType,
    flexcubeValue: string,
  ): Promise<ReferenceMappingEntry | null>;
  /** Mapping for (type, value) regardless of the active flag, or null. */
  find(type: ReferenceMappingType, flexcubeValue: string): Promise<ReferenceMappingEntry | null>;
  /** Inserts, or updates the existing (type, value) row. Throws InvalidReferenceMappingError. */
  upsert(input: ReferenceMappingInput): Promise<ReferenceMappingEntry>;
  /** Throws UnmappedReferenceValueError when the (type, value) row does not exist. */
  setActive(
    type: ReferenceMappingType,
    flexcubeValue: string,
    active: boolean,
  ): Promise<ReferenceMappingEntry>;
  list(type?: ReferenceMappingType): Promise<ReferenceMappingEntry[]>;
}
export const REFERENCE_MAPPING_REPOSITORY = Symbol('IReferenceMappingRepository');

/**
 * Collapses multiple selected income-source checkboxes into the single REIS value.
 * The business rule is TBD (open item 10): NO implementation exists on purpose.
 */
export interface ISourceOfIncomeStrategy {
  toReisValue(selectedSources: string[]): Promise<string>;
}
export const SOURCE_OF_INCOME_STRATEGY = Symbol('ISourceOfIncomeStrategy');

/** Corporate related persons plug in here once FLEXCUBE provides the mapping (open item 6). */
export interface IRelationProvider {
  getRelatedPersons(kycRefNo: string): Promise<import('../canonical').CanonicalRelatedPerson[]>;
}
export const RELATION_PROVIDER = Symbol('IRelationProvider');
