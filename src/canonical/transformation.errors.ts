export type TransformationErrorKind = 'MISSING_FIELD' | 'INVALID_VALUE' | 'RULE_NOT_CONFIGURED';

/**
 * Typed, permanent (non-retryable) failures raised BEFORE any REIS call. Messages name fields
 * and rules, never the offending customer data. (Unmapped reference values raise the separate
 * UnmappedReferenceValueError from the mapping module.)
 */
export abstract class TransformationError extends Error {
  abstract readonly kind: TransformationErrorKind;
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A required input is absent or blank. */
export class MissingRequiredFieldError extends TransformationError {
  readonly kind = 'MISSING_FIELD' as const;
  constructor(field: string) {
    super(`Required field "${field}" is missing or blank`, field);
  }
}

/** An input is present but unusable (bad date, bad number, bad Y/N, unsupported value...). */
export class InvalidFieldValueError extends TransformationError {
  readonly kind = 'INVALID_VALUE' as const;
  constructor(
    field: string,
    readonly reason: string,
  ) {
    super(`Invalid value for "${field}": ${reason}`, field);
  }
}

/**
 * The input requires a business rule the Bank has not decided yet (e.g. combining several
 * Source-of-Income checkboxes). Never resolved by guessing.
 */
export class SourceOfIncomeRuleNotConfiguredError extends TransformationError {
  readonly kind = 'RULE_NOT_CONFIGURED' as const;
  constructor(readonly selectedCount: number) {
    super(
      `Source of Income rule is not configured: ${selectedCount} income sources were selected and the Bank has not defined how to combine them`,
      'source_income_individual',
    );
  }
}
