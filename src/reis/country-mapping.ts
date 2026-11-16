import { ReferenceMappingType } from '../mapping/reference-mapping';

/**
 * REIS V1.2 confirms that nationality_customer, citizenship_customer, incorp_country,
 * nationality and operation_country are COUNTRY CODES (CONFIRMED).
 *
 * It is NOT confirmed that FLEXCUBE uses one identical source list for all of them. Until the
 * Bank says otherwise, every country-valued field is translated with the NATIONALITY reference
 * mapping (PROVISIONAL). That choice lives only here: to split it later, give a field its own
 * mapping type below (and add that type to ReferenceMappingType); the transformer needs no change
 * and no mapping data is duplicated.
 */
export const COUNTRY_MAPPING_TYPE = ReferenceMappingType.NATIONALITY;

/** The country-valued positions in the REIS payload, each resolvable through its own mapping type. */
export type CountryField =
  | 'NATIONALITY' // individual nationality (+ nationality_customer), relation nationality
  | 'CITIZENSHIP' // individual citizenship (+ citizenship_customer), relation citizenship
  | 'INCORPORATION_COUNTRY' // incorp_country (+ corporate nationality)
  | 'OPERATION_COUNTRY'; // operation_country entries

export type CountryMappingTypes = Readonly<Record<CountryField, ReferenceMappingType>>;

/** PROVISIONAL default: one source list (NATIONALITY) for every country field. */
export const DEFAULT_COUNTRY_MAPPING_TYPES: CountryMappingTypes = Object.freeze({
  NATIONALITY: COUNTRY_MAPPING_TYPE,
  CITIZENSHIP: COUNTRY_MAPPING_TYPE,
  INCORPORATION_COUNTRY: COUNTRY_MAPPING_TYPE,
  OPERATION_COUNTRY: COUNTRY_MAPPING_TYPE,
});

/** Optional DI token to override the per-field mapping types (not bound by default). */
export const COUNTRY_MAPPING_TYPES = Symbol('CountryMappingTypes');
