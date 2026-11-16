/** Mapping types. Values are Bank-approved config, never hardcoded from the Excel workbook. */
export enum ReferenceMappingType {
  NATIONALITY = 'NATIONALITY',
  PROFESSION = 'PROFESSION',
  ACCOUNT_PURPOSE_INDIVIDUAL = 'ACCOUNT_PURPOSE_INDIVIDUAL',
  ACCOUNT_PURPOSE_CORPORATE = 'ACCOUNT_PURPOSE_CORPORATE',
  PRODUCT = 'PRODUCT',
  LEGAL_ENTITY = 'LEGAL_ENTITY',
  ACTIVITY = 'ACTIVITY',
  DISTRIBUTION_CHANNEL = 'DISTRIBUTION_CHANNEL',
  SOURCE_OF_INCOME = 'SOURCE_OF_INCOME',
  DOCUMENT_TYPE = 'DOCUMENT_TYPE',
}

/**
 * One configurable FLEXCUBE value -> REIS value mapping. Unique per (mappingType, flexcubeValue);
 * deactivating a mapping (active = false) makes it invisible to lookups without deleting it.
 */
export interface ReferenceMappingEntry {
  id: number;
  mappingType: ReferenceMappingType;
  flexcubeValue: string;
  reisValue: string;
  description: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReferenceMappingInput {
  mappingType: ReferenceMappingType;
  flexcubeValue: string;
  reisValue: string;
  description?: string | null;
  /** Defaults to true. */
  active?: boolean;
}

/** Thrown when a FLEXCUBE value has no active approved mapping. Permanent (not retryable). */
export class UnmappedReferenceValueError extends Error {
  constructor(
    readonly mappingType: ReferenceMappingType,
    readonly flexcubeValue: string,
  ) {
    super(`No active ${mappingType} mapping for FLEXCUBE value "${flexcubeValue}"`);
    this.name = 'UnmappedReferenceValueError';
  }
}

export class InvalidReferenceMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReferenceMappingError';
  }
}

/**
 * Stored mapping values must be unambiguous: non-empty and without leading/trailing whitespace.
 * Lookups are exact and case-sensitive; nothing is trimmed or case-folded, so legitimate codes
 * are never altered.
 */
export function assertValidMappingInput(input: ReferenceMappingInput): void {
  if (!Object.values(ReferenceMappingType).includes(input.mappingType)) {
    throw new InvalidReferenceMappingError(`Unknown mapping type "${String(input.mappingType)}"`);
  }
  for (const field of ['flexcubeValue', 'reisValue'] as const) {
    const v = input[field];
    if (typeof v !== 'string' || v.length === 0 || v !== v.trim()) {
      throw new InvalidReferenceMappingError(
        `${field} must be a non-empty string without leading/trailing whitespace`,
      );
    }
  }
}
