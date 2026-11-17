import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  CanonicalCorporateCustomer,
  CanonicalCorporateRelation,
  CanonicalIndividualCustomer,
  CanonicalIndividualRelation,
  CanonicalKycCustomer,
  CanonicalRelatedPerson,
  CustomerType,
} from '../canonical';
import {
  InvalidFieldValueError,
  MissingRequiredFieldError,
} from '../canonical/transformation.errors';
import {
  IReferenceMappingService,
  ISourceOfIncomeStrategy,
  REFERENCE_MAPPING_SERVICE,
  SOURCE_OF_INCOME_STRATEGY,
} from '../mapping/mapping.interfaces';
import { ReferenceMappingType } from '../mapping/reference-mapping';
import {
  CORPORATE_RELATION_IDS,
  INDIVIDUAL_RELATION_IDS,
  ReisCorporateItems,
  ReisCorporateOnboardingRequest,
  ReisCorporateRelationEntry,
  ReisIndividualItems,
  ReisIndividualOnboardingRequest,
  ReisIndividualRelationEntry,
  ReisRelationEntry,
  ReisRelationshipId,
} from './dto';
import {
  COUNTRY_MAPPING_TYPES,
  CountryField,
  CountryMappingTypes,
  DEFAULT_COUNTRY_MAPPING_TYPES,
} from './country-mapping';
import { findInvalidReisDates } from './reis-date';
import { REIS_CONFIG, ReisConfig } from './reis.config';
import { ICanonicalToReisTransformer } from './reis.interfaces';

/**
 * Canonical -> REIS onboarding envelope (systemName/systemId/formId/relations on top level,
 * entity_type and all business fields inside `items`).
 *
 * - Translates FLEXCUBE values to REIS values only through IReferenceMappingService; an unmapped
 *   value throws UnmappedReferenceValueError (nothing is passed through or guessed).
 * - Derives the REIS-only duplicates (nationality_customer/nationality, citizenship_customer/
 *   citizenship, corporate nationality = incorporation country) from one mapped value.
 * - Throws typed errors BEFORE any REIS call; never returns a partially valid payload.
 * - No I/O besides reference-mapping lookups: no REIS calls, no persistence writes.
 */
/** Only agreed ID document type (Appendix "ID Document Type"); default when no type is mapped. */
export const DEFAULT_DOCUMENT_TYPE = 'PASS';

/** A-Z, a-z, space, dot, hyphen, apostrophe (applied after trimming). */
const LATIN_NAME = /^[A-Za-z .'-]+$/;

@Injectable()
// Historical field-mapping baseline, also used by CifOnboardingPreview. The application submission
// entry point is held; this transformer must not be wired back to sending under the new CIF rule.
export class CanonicalToReisTransformer implements ICanonicalToReisTransformer {
  constructor(
    @Inject(REFERENCE_MAPPING_SERVICE) private readonly refs: IReferenceMappingService,
    @Inject(SOURCE_OF_INCOME_STRATEGY) private readonly income: ISourceOfIncomeStrategy,
    @Inject(REIS_CONFIG) private readonly config: ReisConfig,
    @Optional()
    @Inject(COUNTRY_MAPPING_TYPES)
    private readonly countryTypes: CountryMappingTypes = DEFAULT_COUNTRY_MAPPING_TYPES,
  ) {}

  /** Country-valued fields: mapping type chosen per field (PROVISIONAL: all NATIONALITY). */
  private country(field: CountryField, value: string): Promise<string> {
    return this.refs.resolve(this.countryTypes[field], value);
  }

  async transform(
    customer: CanonicalKycCustomer,
    relations: CanonicalRelatedPerson[] = customer.customerType === CustomerType.CORPORATE
      ? (customer.relatedPersons ?? [])
      : [],
  ): Promise<ReisIndividualOnboardingRequest | ReisCorporateOnboardingRequest> {
    const systemId = this.text(customer.kycRefNo, 'KYC_REF_NO');
    const relationEntries = await this.buildRelations(customer, relations);
    if (customer.customerType === CustomerType.INDIVIDUAL) {
      return {
        systemName: this.config.systemName,
        systemId,
        formId: 1,
        items: await this.individualItems(customer),
        relations: relationEntries,
      };
    }
    if (customer.customerType === CustomerType.CORPORATE) {
      return {
        systemName: this.config.systemName,
        systemId,
        formId: 2,
        items: await this.corporateItems(customer),
        relations: relationEntries,
      };
    }
    throw new InvalidFieldValueError('customerType', 'unsupported customer type');
  }

  // ---- Individual ------------------------------------------------------------------------

  private async individualItems(c: CanonicalIndividualCustomer): Promise<ReisIndividualItems> {
    const nationality = await this.country('NATIONALITY', c.nationality);
    const citizenship = await this.country('CITIZENSHIP', c.citizenship);

    const items: ReisIndividualItems = {
      entity_type: 'PP',
      first_name: this.latinName(c.firstName, 'FIRST_NAME'),
      last_name: this.latinName(c.lastName, 'LAST_NAME'),
      cus_birth_date: c.birthDate,
      account_manager_login: this.text(c.accountManagerLogin, 'ACCOUNT_MANAGER_LOGIN'),
      account_manager_email: this.text(c.accountManagerEmail, 'ACCOUNT_MANAGER_EMAIL'),
      pep: c.pep,
      relation_pep: c.relationPep,
      nationality_customer: nationality,
      nationality,
      citizenship_customer: citizenship,
      citizenship,
      profession: await this.refs.resolve(ReferenceMappingType.PROFESSION, c.profession),
      account_purpose_individual: await this.refs.resolve(
        ReferenceMappingType.ACCOUNT_PURPOSE_INDIVIDUAL,
        c.accountPurpose,
      ),
      resident: c.isResident ? '1' : '2',
      distribution_channel: await this.refs.resolve(
        ReferenceMappingType.DISTRIBUTION_CHANNEL,
        c.distributionChannel,
      ),
      product: await this.products(c.productCodes),
      source_income_individual: await this.income.toReisValue(c.selectedIncomeSources),
      m_income: this.finite(c.monthlyIncome, 'MONTHLY_INCOME'),
    };
    if (c.birthPlace !== undefined) items.birth_place = c.birthPlace;
    const tin = await this.documentType(c.documentTypeRaw, c.nid);
    if (tin !== undefined) items.tin = tin;
    if (c.nid !== undefined) items.nid = c.nid;
    if (c.expiryDate !== undefined) items.expiry_date = c.expiryDate;
    this.assertDates(items);
    return items;
  }

  // ---- Corporate -------------------------------------------------------------------------

  private async corporateItems(c: CanonicalCorporateCustomer): Promise<ReisCorporateItems> {
    if (!Array.isArray(c.operationCountries) || c.operationCountries.length === 0) {
      throw new MissingRequiredFieldError('OPERATION_COUNTRY');
    }
    const incorporationCountry = await this.country(
      'INCORPORATION_COUNTRY',
      c.incorporationCountry,
    );
    const operationCountries: string[] = [];
    for (const country of c.operationCountries) {
      operationCountries.push(await this.country('OPERATION_COUNTRY', country));
    }

    const items: ReisCorporateItems = {
      entity_type: 'PM',
      business_name: this.latinName(c.businessName, 'CRP_BUSINESS_NAME'),
      account_manager_login: this.text(c.accountManagerLogin, 'ACCOUNT_MANAGER_LOGIN'),
      account_manager_email: this.text(c.accountManagerEmail, 'ACCOUNT_MANAGER_EMAIL'),
      pep: c.pep,
      incorp_country: incorporationCountry,
      // V1.2: corporate nationality is the same value as the country of incorporation.
      nationality: incorporationCountry,
      operation_country: operationCountries,
      legal_entity: await this.refs.resolve(ReferenceMappingType.LEGAL_ENTITY, c.legalEntity),
      activity: await this.refs.resolve(ReferenceMappingType.ACTIVITY, c.activity),
      account_purpose_organization: await this.refs.resolve(
        ReferenceMappingType.ACCOUNT_PURPOSE_CORPORATE,
        c.accountPurpose,
      ),
      // PROVISIONAL: single value translated through the SOURCE_OF_INCOME list.
      source_income_organization: await this.refs.resolve(
        ReferenceMappingType.SOURCE_OF_INCOME,
        c.sourceOfIncome,
      ),
      distribution_channel: await this.refs.resolve(
        ReferenceMappingType.DISTRIBUTION_CHANNEL,
        c.distributionChannel,
      ),
      product: await this.products(c.productCodes),
      fin_info: this.finite(c.financialInfo, 'FIN_INFO'),
    };
    if (c.tradeNo !== undefined) items.trade_no = c.tradeNo;
    return items;
  }

  // ---- Relations (organization customers only, full data in `items`; V1.4 / DFS V1.8) ------
  private async buildRelations(
    customer: CanonicalKycCustomer,
    relations: CanonicalRelatedPerson[],
  ): Promise<ReisRelationEntry[]> {
    if (relations.length > 0 && customer.customerType !== CustomerType.CORPORATE) {
      throw new InvalidFieldValueError(
        'relations',
        'relationships apply to organization customers only',
      );
    }
    const entries: ReisRelationEntry[] = [];
    const seen = new Set<string>();
    for (const relation of relations) {
      if (relation.parentKycRefNo !== customer.kycRefNo) {
        throw new InvalidFieldValueError(
          'relations.parentKycRefNo',
          'does not match the customer KYC_REF_NO',
        );
      }
      const systemId = this.text(relation.systemId, 'relation.systemId');
      if (systemId === customer.kycRefNo) {
        throw new InvalidFieldValueError(
          'relation.systemId',
          'must be the related party identifier, not the customer identifier',
        );
      }
      if (seen.has(systemId)) {
        throw new InvalidFieldValueError(
          'relation.systemId',
          'two relations of the same customer share a systemId',
        );
      }
      seen.add(systemId);
      entries.push(
        relation.relatedPartyType === CustomerType.INDIVIDUAL
          ? await this.individualRelation(systemId, relation)
          : await this.corporateRelation(systemId, relation),
      );
    }
    return entries;
  }

  private async individualRelation(
    systemId: string,
    r: CanonicalIndividualRelation,
  ): Promise<ReisIndividualRelationEntry> {
    const relationshipId = this.relationshipId(r.relationshipId, INDIVIDUAL_RELATION_IDS);
    // Mandatory fields are checked before any mapping lookup or REIS call (field names only).
    const nid = this.text(r.nid, 'relation.nid');
    const issueDate = this.text(r.issueDate, 'relation.issue_date');
    const validUntil = this.text(r.validUntil, 'relation.valid_until');
    const items: ReisIndividualRelationEntry['items'] = {
      entity_type: 'PP',
      first_name: this.latinName(r.firstName, 'relation.first_name'),
      last_name: this.latinName(r.lastName, 'relation.last_name'),
      cus_birth_date: r.birthDate,
      nationality: await this.country('NATIONALITY', r.nationality),
      citizenship: await this.country('CITIZENSHIP', r.citizenship),
      // V1.5: nid, issue_date and valid_until are mandatory for formId 3.
      nid,
      issue_date: issueDate,
      valid_until: validUntil,
    };
    if (r.birthPlace !== undefined) items.birth_place = r.birthPlace;
    const tin = await this.documentType(r.documentTypeRaw, nid);
    if (tin !== undefined) items.tin = tin;
    if (r.nationalId !== undefined) items.national_id = r.nationalId;
    if (r.issuePlace !== undefined) items.issue_place = r.issuePlace;
    this.assertDates(items);
    return {
      formId: 3,
      items,
      relationshipId,
      systemName: this.config.systemName,
      systemId,
    };
  }

  private async corporateRelation(
    systemId: string,
    r: CanonicalCorporateRelation,
  ): Promise<ReisCorporateRelationEntry> {
    const relationshipId = this.relationshipId(r.relationshipId, CORPORATE_RELATION_IDS);
    const items: ReisCorporateRelationEntry['items'] = {
      entity_type: 'PM',
      business_name: this.latinName(r.businessName, 'relation.business_name'),
      nationality: await this.country('NATIONALITY', r.nationality),
    };
    if (r.tradeNo !== undefined) items.trade_no = r.tradeNo;
    return {
      formId: 4,
      items,
      relationshipId,
      systemName: this.config.systemName,
      systemId,
    };
  }

  /** V1.4: formId 3 accepts ids 1-8, formId 4 accepts 2, 5, 7, 8 only. */
  private relationshipId(
    value: unknown,
    allowed: ReadonlySet<ReisRelationshipId>,
  ): ReisRelationshipId {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      !allowed.has(value as ReisRelationshipId)
    ) {
      throw new InvalidFieldValueError(
        'relationshipId',
        'not a relationship id REIS documents for this relation form',
      );
    }
    return value as ReisRelationshipId;
  }

  /** REIS product is an array (V1.4); every FLEXCUBE code is translated, none is passed through. */
  private async products(codes: unknown): Promise<string[]> {
    if (!Array.isArray(codes) || codes.length === 0) {
      throw new MissingRequiredFieldError('PRODUCT_CODE');
    }
    const out: string[] = [];
    for (const [n, code] of codes.entries()) {
      out.push(
        await this.refs.resolve(
          ReferenceMappingType.PRODUCT,
          this.text(code, `PRODUCT_CODE[${n}]`),
        ),
      );
    }
    return [...new Set(out)];
  }

  /**
   * tin = ID document TYPE. A raw FLEXCUBE type is translated through DOCUMENT_TYPE; when none is
   * given but a document number is, the only agreed type (PASS) is used (mapping V2_5).
   */
  private async documentType(raw: string | undefined, nid: string | undefined) {
    if (raw !== undefined) return this.refs.resolve(ReferenceMappingType.DOCUMENT_TYPE, raw);
    return nid !== undefined ? DEFAULT_DOCUMENT_TYPE : undefined;
  }

  // ---- validation helpers ----------------------------------------------------------------

  private text(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim() === '')
      throw new MissingRequiredFieldError(field);
    return value;
  }

  /**
   * Names are screened by REIS against lists that are mostly Latin script, and only in the same
   * script: after trimming only A-Z, a-z, space, dot, hyphen and apostrophe are accepted.
   * The error names the field, never the value.
   */
  private latinName(value: unknown, field: string): string {
    const name = this.text(value, field);
    if (!LATIN_NAME.test(name.trim())) {
      throw new InvalidFieldValueError(
        field,
        'must use Latin letters only (A-Z, space, dot, hyphen, apostrophe)',
      );
    }
    return name;
  }

  private finite(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidFieldValueError(field, 'not a valid finite number');
    }
    return value;
  }

  /** Outbound REIS dates must be YYYY-MM-DD. */
  private assertDates(items: object): void {
    const bad = findInvalidReisDates(items);
    if (bad.length > 0) {
      throw new InvalidFieldValueError(bad.join(', '), 'REIS dates must be valid YYYY-MM-DD');
    }
  }
}
