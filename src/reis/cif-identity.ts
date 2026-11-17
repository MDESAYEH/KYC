import { TransformationError, TransformationErrorKind } from '../canonical/transformation.errors';

export class CifIdentityError extends TransformationError {
  readonly kind: TransformationErrorKind;
  constructor(readonly code: 'MISSING_CIF' | 'INVALID_CIF' | 'CIF_CUTOVER_NOT_APPROVED') {
    super(
      code === 'CIF_CUTOVER_NOT_APPROVED'
        ? 'CIF source, lifecycle and REIS identity cutover require confirmation before submission'
        : code === 'MISSING_CIF'
          ? 'FLEXCUBE CIF (CUSTOMER_NO) is required before REIS submission'
          : 'FLEXCUBE CIF (CUSTOMER_NO) must be one nonblank string',
      'CUSTOMER_NO',
    );
    this.kind =
      code === 'MISSING_CIF'
        ? 'MISSING_FIELD'
        : code === 'CIF_CUTOVER_NOT_APPROVED'
          ? 'RULE_NOT_CONFIGURED'
          : 'INVALID_VALUE';
  }
}

/** No numeric coercion: it would lose leading zeros. No unapproved CIF format is invented. */
export function requireCif(value: unknown): string {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    throw new CifIdentityError('MISSING_CIF');
  }
  if (typeof value !== 'string') throw new CifIdentityError('INVALID_CIF');
  return value.trim();
}
