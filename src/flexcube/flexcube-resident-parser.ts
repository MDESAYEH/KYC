import { InvalidFieldValueError } from '../canonical/transformation.errors';

/**
 * Interprets the raw FLEXCUBE Resident value as resident (true) / non-resident (false). The
 * exact FLEXCUBE source values are NOT confirmed, so this is a swappable adapter. (The REIS side
 * is confirmed: resident "1" for resident, "2" for non-resident.)
 */
export interface IFlexcubeResidentParser {
  /** Throws InvalidFieldValueError for a value it does not recognise. */
  parse(raw: string): boolean;
}
export const FLEXCUBE_RESIDENT_PARSER = Symbol('IFlexcubeResidentParser');

/** PROVISIONAL default: exactly "Y" = resident, "N" = non-resident; anything else is rejected. */
export class YesNoResidentParser implements IFlexcubeResidentParser {
  parse(raw: string): boolean {
    if (raw === 'Y') return true;
    if (raw === 'N') return false;
    throw new InvalidFieldValueError('RESIDENT', 'unrecognised resident value (expected Y or N)');
  }
}
