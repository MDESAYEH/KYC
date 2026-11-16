import { Inject, Injectable } from '@nestjs/common';
import {
  CanonicalCorporateCustomer,
  CanonicalCorporateRelation,
  CanonicalIndividualCustomer,
  CanonicalIndividualRelation,
  CanonicalRelatedPerson,
  CanonicalKycCustomer,
  CustomerType,
} from '../canonical';
import {
  InvalidFieldValueError,
  MissingRequiredFieldError,
} from '../canonical/transformation.errors';
import { parseStrictNumber } from '../common/strict-number';
import { CORPORATE_RELATION_IDS } from '../reis/dto';
import { FlexcubeCustomerRequest, FlexcubeRelatedPartyDto } from './dto/flexcube-customer.request';
import {
  FLEXCUBE_DATE_NORMALIZER,
  IFlexcubeDateNormalizer,
  InvalidFlexcubeDateError,
} from './flexcube-date-normalizer';
import { FLEXCUBE_RESIDENT_PARSER, IFlexcubeResidentParser } from './flexcube-resident-parser';
import { IFlexcubeToCanonicalMapper } from './flexcube.interfaces';
import {
  companyKycRefNoDashKycId,
  KEYPERSON_TYPES,
  RELATIONSHIP_CODE_TO_REIS_ID,
} from './related-party';

/**
 * FLEXCUBE inbound DTO -> CanonicalKycCustomer. Pure and synchronous: no REIS code translation
 * (that is the transformer's job), no I/O, no persistence.
 *
 * Does here: required-field checks, Y/N -> boolean, date normalization (through the injected,
 * swappable IFlexcubeDateNormalizer), strict numeric parsing, resident interpretation (injected
 * IFlexcubeResidentParser), income-checkbox collection. Does NOT: trim/alter reference values,
 * guess formats, or default anything. Typed TransformationErrors are raised for bad input.
 */
@Injectable()
export class FlexcubeToCanonicalMapper implements IFlexcubeToCanonicalMapper {
  constructor(
    @Inject(FLEXCUBE_DATE_NORMALIZER) private readonly dates: IFlexcubeDateNormalizer,
    @Inject(FLEXCUBE_RESIDENT_PARSER) private readonly resident: IFlexcubeResidentParser,
  ) {}

  map(request: FlexcubeCustomerRequest): CanonicalKycCustomer {
    const base = {
      kycRefNo: this.required(request.KYC_REF_NO, 'KYC_REF_NO'),
      customerNo: this.optional(request.CUSTOMER_NO) ?? null,
      accountManagerLogin: this.required(request.ACCOUNT_MANAGER_LOGIN, 'ACCOUNT_MANAGER_LOGIN'),
      accountManagerEmail: this.required(request.ACCOUNT_MANAGER_EMAIL, 'ACCOUNT_MANAGER_EMAIL'),
      pep: this.yesNo(request.PEP, 'PEP'),
      productCodes: this.list(request.PRODUCT_CODES, 'PRODUCT_CODES'),
      distributionChannel: this.required(request.DISTRIBUTION_CHANNEL, 'DISTRIBUTION_CHANNEL'),
    };
    switch (request.CUSTOMER_TYPE) {
      case 'INDIVIDUAL':
        return this.individual(base, request);
      case 'CORPORATE':
        return this.corporate(base, request);
      default:
        throw new InvalidFieldValueError('CUSTOMER_TYPE', 'expected INDIVIDUAL or CORPORATE');
    }
  }

  private individual(
    base: BaseFields,
    request: FlexcubeCustomerRequest,
  ): CanonicalIndividualCustomer {
    const i = request.individual;
    if (!i) throw new MissingRequiredFieldError('individual');
    const out: CanonicalIndividualCustomer = {
      ...base,
      customerType: CustomerType.INDIVIDUAL,
      firstName: this.required(i.FIRST_NAME, 'FIRST_NAME'),
      lastName: this.required(i.LAST_NAME, 'LAST_NAME'),
      birthDate: this.date(this.required(i.BIRTH_DATE, 'BIRTH_DATE'), 'BIRTH_DATE'),
      relationPep: this.yesNo(i.RELATION_PEP, 'RELATION_PEP'),
      nationality: this.required(i.NATIONALITY, 'NATIONALITY'),
      citizenship: this.required(i.CITIZENSHIP, 'CITIZENSHIP'),
      profession: this.required(i.PROFESSION, 'PROFESSION'),
      accountPurpose: this.required(i.ACC_PURPOSE, 'ACC_PURPOSE'),
      isResident: this.resident.parse(this.required(i.RESIDENT, 'RESIDENT')),
      selectedIncomeSources: [this.required(i.FUND_SOURCE, 'FUND_SOURCE')],
      monthlyIncome: this.number(i.MONTHLY_INCOME, 'MONTHLY_INCOME'),
    };
    this.assign(out, 'birthPlace', this.optional(i.BIRTH_PLACE));
    this.assign(out, 'documentTypeRaw', this.optional(i.TIN));
    this.assign(out, 'nid', this.optional(i.NID));
    const expiry = this.optional(i.EXPIRY_DATE);
    if (expiry !== undefined) out.expiryDate = this.date(expiry, 'EXPIRY_DATE');
    return out;
  }

  private corporate(
    base: BaseFields,
    request: FlexcubeCustomerRequest,
  ): CanonicalCorporateCustomer {
    const c = request.corporate;
    if (!c) throw new MissingRequiredFieldError('corporate');
    if (!Array.isArray(c.OPERATION_COUNTRY) || c.OPERATION_COUNTRY.length === 0) {
      throw new MissingRequiredFieldError('OPERATION_COUNTRY');
    }
    const out: CanonicalCorporateCustomer = {
      ...base,
      customerType: CustomerType.CORPORATE,
      // CONFIRMED: STTM_KYC_CORPORATE_CUSTOM.CRP_BUSINESS_NAME is REIS business_name.
      businessName: this.required(c.CRP_BUSINESS_NAME, 'CRP_BUSINESS_NAME'),
      incorporationCountry: this.required(c.PARENT_CMPNY_COUNTRY, 'PARENT_CMPNY_COUNTRY'),
      operationCountries: c.OPERATION_COUNTRY.map((v, n) =>
        this.required(v, `OPERATION_COUNTRY[${n}]`),
      ),
      legalEntity: this.required(c.LEGAL_ENTITY, 'LEGAL_ENTITY'),
      activity: this.required(c.ACTIVITY, 'ACTIVITY'),
      accountPurpose: this.required(c.ACC_PURPOSE, 'ACC_PURPOSE'),
      sourceOfIncome: this.required(c.SOURCE_OF_INCOME, 'SOURCE_OF_INCOME'),
      financialInfo: this.number(c.FIN_INFO, 'FIN_INFO'),
    };
    this.assign(out, 'tradeNo', this.optional(c.TRADE_NO));
    const related = this.relatedPersons(base.kycRefNo, c.RELATED_PARTIES);
    if (related.length > 0) out.relatedPersons = related;
    return out;
  }

  // ---- related parties (STTM_KYC_CORP_KEYPERSONS) ------------------------------------------

  /**
   * Validates every key person and builds the canonical related persons. Any problem rejects the
   * whole request (nothing is dropped or defaulted); errors name the field, never the value.
   */
  private relatedPersons(
    companyKycRefNo: string,
    parties: FlexcubeRelatedPartyDto[] | undefined,
  ): CanonicalRelatedPerson[] {
    if (parties === undefined || parties === null) return [];
    if (!Array.isArray(parties))
      throw new InvalidFieldValueError('RELATED_PARTIES', 'expected a list');
    const seen = new Set<string>();
    return parties.map((p, n) => {
      const at = (field: string) => `RELATED_PARTIES[${n}].${field}`;
      const kycId = this.required(p.KYC_ID, at('KYC_ID')).trim();
      const systemId = companyKycRefNoDashKycId(companyKycRefNo, kycId);
      if (systemId === companyKycRefNo) {
        throw new InvalidFieldValueError(
          at('KYC_ID'),
          'related party systemId equals the customer',
        );
      }
      if (seen.has(systemId)) {
        throw new InvalidFieldValueError(at('KYC_ID'), 'duplicate within the same company');
      }
      seen.add(systemId);
      const common = {
        parentKycRefNo: companyKycRefNo,
        systemId,
        relationshipId: this.relationshipId(p, n),
      };
      if (p.KYC_KEYPERSON_TYPE === 'C') {
        const out: CanonicalCorporateRelation = {
          ...common,
          relatedPartyType: CustomerType.CORPORATE,
          businessName: this.required(p.NAME, at('NAME')),
          nationality: this.required(p.ADDRESS_COUNTRY, at('ADDRESS_COUNTRY')),
        };
        this.assign(out, 'tradeNo', this.optional(p.TIN));
        return out;
      }
      if (p.HAS_CUSTOM_ROW === false) {
        throw new MissingRequiredFieldError(at('STTM_KYC_CORP_KEYPERSONS_CUSTOM'));
      }
      const out: CanonicalIndividualRelation = {
        ...common,
        relatedPartyType: CustomerType.INDIVIDUAL,
        firstName: this.required(p.FIRST_NAME, at('FIRST_NAME')),
        lastName: this.required(p.LAST_NAME, at('LAST_NAME')),
        birthDate: this.date(
          this.required(p.DATE_OF_BIRTH, at('DATE_OF_BIRTH')),
          at('DATE_OF_BIRTH'),
        ),
        nationality: this.required(p.NATIONALITY, at('NATIONALITY')),
        citizenship: this.required(p.ADDRESS_COUNTRY, at('ADDRESS_COUNTRY')),
        nid: this.required(p.PASSPORT_NUMBER, at('PASSPORT_NUMBER')),
        issueDate: this.date(
          this.required(p.PASSPORT_ISSUE_DATE, at('PASSPORT_ISSUE_DATE')),
          at('PASSPORT_ISSUE_DATE'),
        ),
        validUntil: this.date(
          this.required(p.PASSPORT_EXPIRY_DATE, at('PASSPORT_EXPIRY_DATE')),
          at('PASSPORT_EXPIRY_DATE'),
        ),
      };
      this.assign(out, 'birthPlace', this.optional(p.PLACE_OF_BIRTH));
      this.assign(out, 'issuePlace', this.optional(p.PLACE_OF_ISSUE));
      this.assign(out, 'nationalId', this.optional(p.NATIONAL_ID));
      return out;
    });
  }

  /** RELATIONSHIP code -> REIS id; unknown codes and codes not allowed for a company are rejected. */
  private relationshipId(p: FlexcubeRelatedPartyDto, n: number): number {
    const field = `RELATED_PARTIES[${n}].RELATIONSHIP`;
    if (!KEYPERSON_TYPES.includes(p.KYC_KEYPERSON_TYPE)) {
      throw new InvalidFieldValueError(
        `RELATED_PARTIES[${n}].KYC_KEYPERSON_TYPE`,
        'expected I or C',
      );
    }
    const code = this.required(p.RELATIONSHIP, field).trim();
    const id = Object.prototype.hasOwnProperty.call(RELATIONSHIP_CODE_TO_REIS_ID, code)
      ? RELATIONSHIP_CODE_TO_REIS_ID[code]
      : undefined;
    if (id === undefined) throw new InvalidFieldValueError(field, 'unknown relationship code');
    if (p.KYC_KEYPERSON_TYPE === 'C' && !CORPORATE_RELATION_IDS.has(id)) {
      throw new InvalidFieldValueError(
        field,
        'relationship not allowed for a company related party',
      );
    }
    return id;
  }

  // ---- helpers ---------------------------------------------------------------------------

  /** Required text: must be a non-blank string. The value is passed through UNCHANGED. */
  private required(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim() === '')
      throw new MissingRequiredFieldError(field);
    return value;
  }

  /** Optional text: absent, null or blank means "not provided"; otherwise passed through unchanged. */
  private optional(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      throw new InvalidFieldValueError('optional field', 'expected text');
    }
    return value.trim() === '' ? undefined : value;
  }

  private assign<
    K extends 'birthPlace' | 'documentTypeRaw' | 'nid' | 'tradeNo' | 'issuePlace' | 'nationalId',
  >(target: Partial<Record<K, string>>, key: K, value: string | undefined): void {
    if (value !== undefined) target[key] = value;
  }

  private yesNo(value: unknown, field: string): boolean {
    if (value === 'Y') return true;
    if (value === 'N') return false;
    throw new InvalidFieldValueError(field, 'expected Y or N');
  }

  private date(raw: string, field: string): string {
    try {
      return this.dates.normalize(raw);
    } catch (err) {
      if (err instanceof InvalidFlexcubeDateError) {
        throw new InvalidFieldValueError(field, 'date could not be normalized to YYYY-MM-DD');
      }
      throw err;
    }
  }

  private number(value: unknown, field: string): number {
    const n = parseStrictNumber(value);
    if (n === undefined) throw new InvalidFieldValueError(field, 'not a valid finite number');
    return n;
  }

  /** Names of the income checkboxes set to 'Y', in the order received. Anything but Y/N is rejected. */
  private list(values: unknown, field: string): string[] {
    if (!Array.isArray(values) || values.length === 0) throw new MissingRequiredFieldError(field);
    return values.map((v, n) => this.required(v, `${field}[${n}]`));
  }
}

type BaseFields = {
  kycRefNo: string;
  customerNo: string | null;
  accountManagerLogin: string;
  accountManagerEmail: string;
  pep: boolean;
  productCodes: string[];
  distributionChannel: string;
};
