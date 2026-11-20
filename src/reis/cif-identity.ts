import { TransformationError, TransformationErrorKind } from '../canonical/transformation.errors';

export class CifIdentityError extends TransformationError {
  readonly kind: TransformationErrorKind;
  constructor(readonly code: 'MISSING_CIF' | 'INVALID_CIF') {
    super(
      code === 'MISSING_CIF'
        ? 'FLEXCUBE CIF (CUSTOMER_NO) is required before REIS submission'
        : 'FLEXCUBE CIF (CUSTOMER_NO) must be one nonblank string',
      'CUSTOMER_NO',
    );
    this.kind = code === 'MISSING_CIF' ? 'MISSING_FIELD' : 'INVALID_VALUE';
  }
}

/** The CIF as a trimmed string. No numeric coercion: it would lose leading zeros. */
export function requireCif(value: unknown): string {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    throw new CifIdentityError('MISSING_CIF');
  }
  if (typeof value !== 'string') throw new CifIdentityError('INVALID_CIF');
  return value.trim();
}
