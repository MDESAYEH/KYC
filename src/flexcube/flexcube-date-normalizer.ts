import { isReisDate } from '../reis/reis-date';

/**
 * Converts a raw FLEXCUBE date string into the REIS format (YYYY-MM-DD). The FLEXCUBE wire
 * format is TBD, so swap the implementation once the final contract is known.
 */
export interface IFlexcubeDateNormalizer {
  /** Returns YYYY-MM-DD or throws InvalidFlexcubeDateError. */
  normalize(raw: string): string;
}
export const FLEXCUBE_DATE_NORMALIZER = Symbol('IFlexcubeDateNormalizer');

export class InvalidFlexcubeDateError extends Error {
  constructor(readonly raw: string) {
    super(`Cannot normalize FLEXCUBE date "${raw}" to YYYY-MM-DD`);
    this.name = 'InvalidFlexcubeDateError';
  }
}

/** PROVISIONAL default: accepts only dates that already are valid YYYY-MM-DD. */
export class StrictIsoFlexcubeDateNormalizer implements IFlexcubeDateNormalizer {
  normalize(raw: string): string {
    const trimmed = raw.trim();
    if (!isReisDate(trimmed)) throw new InvalidFlexcubeDateError(raw);
    return trimmed;
  }
}
