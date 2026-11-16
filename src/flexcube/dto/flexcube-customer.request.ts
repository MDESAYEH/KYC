import { Type } from 'class-transformer';
import { StrictNumber } from '../../common/strict-number';
import {
  ArrayNotEmpty,
  IsArray,
  IsDefined,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * =====================================================================================
 * PROVISIONAL - the final FLEXCUBE -> Integration API contract is TBD (open item 1).
 * Only names the FLEXCUBE team confirmed are marked CONFIRMED; every other name is a
 * placeholder to be adjusted when the final payload arrives. Y/N flags stay raw strings
 * here and are converted by the FLEXCUBE -> canonical mapper.
 * =====================================================================================
 */
export const YES_NO = ['Y', 'N'] as const;

export class FlexcubeIndividualDto {
  /** CONFIRMED: new FLEXCUBE field. */
  @IsString() @IsNotEmpty() FIRST_NAME: string;
  /** CONFIRMED: new FLEXCUBE field. */
  @IsString() @IsNotEmpty() LAST_NAME: string;
  /**
   * CONFIRMED source: STTM_KYC_RETAIL.BIRTH_DATE, mandatory. The wire format is NOT assumed:
   * it stays a raw string here and is normalized to REIS YYYY-MM-DD by IFlexcubeDateNormalizer.
   */
  @IsString() @IsNotEmpty() BIRTH_DATE: string;
  @IsOptional() @IsString() BIRTH_PLACE?: string;
  /** CONFIRMED: free text, no FLEXCUBE-side validation. Must be mapped, never sent raw. */
  @IsOptional() @IsString() TIN?: string;
  @IsOptional() @IsString() NID?: string;
  /** Raw date, wire format TBD (see BIRTH_DATE). */
  @IsOptional() @IsString() EXPIRY_DATE?: string;
  @IsIn(YES_NO) RELATION_PEP: string;
  /** One value only: REIS nationality_customer and nationality are both derived from it. */
  @IsString() @IsNotEmpty() NATIONALITY: string;
  /** One value only: REIS citizenship_customer and citizenship are both derived from it. */
  @IsString() @IsNotEmpty() CITIZENSHIP: string;
  @IsString() @IsNotEmpty() PROFESSION: string;
  /** Example name used by the FLEXCUBE team (ACC_PURPOSE -> account_purpose_individual). */
  @IsString() @IsNotEmpty() ACC_PURPOSE: string;
  @IsString() @IsNotEmpty() RESIDENT: string;
  /** STTM_KYC_RETAIL_CUSTOM.FUND_SOURCE: one source-of-income value (mapping V2_5). */
  @IsString() @IsNotEmpty() FUND_SOURCE: string;
  /** Numeric (REIS m_income is numeric). Numeric strings are accepted; blank/null/NaN are rejected, never 0. Transport TBD. */
  @StrictNumber() @IsNumber({ allowNaN: false, allowInfinity: false }) MONTHLY_INCOME: number;
}

/**
 * One key person of a corporate KYC: STTM_KYC_CORP_KEYPERSONS (k) joined to
 * STTM_KYC_CORP_KEYPERSONS_CUSTOM (cu) on KYC_REF_NO + KYC_ID + NAME. Raw values as read (text
 * trimmed, dates YYYY-MM-DD); every check happens in the FLEXCUBE -> canonical mapper.
 */
export class FlexcubeRelatedPartyDto {
  /** Free user input, unique only within the company: the systemId is built from both. */
  @IsOptional() @IsString() KYC_ID?: string;
  /** Individual: full (Arabic) name, join key only. Company: sent as business_name. */
  @IsOptional() @IsString() NAME?: string;
  /** 'I' individual (REIS formId 3) or 'C' company (formId 4). */
  @IsIn(['I', 'C']) KYC_KEYPERSON_TYPE: 'I' | 'C';
  /** Raw FLEXCUBE RELATIONSHIP code (AUTHORIZED, BENEFICIAR, CEO, ...). */
  @IsOptional() @IsString() RELATIONSHIP?: string;
  @IsOptional() @IsString() DATE_OF_BIRTH?: string;
  @IsOptional() @IsString() NATIONALITY?: string;
  /** Individual: citizenship. Company: nationality. */
  @IsOptional() @IsString() ADDRESS_COUNTRY?: string;
  @IsOptional() @IsString() PLACE_OF_BIRTH?: string;
  /** Company: trade_no. Individual: not used (REIS tin is the document type, PASS by default). */
  @IsOptional() @IsString() TIN?: string;
  /** false when the LEFT JOIN found no STTM_KYC_CORP_KEYPERSONS_CUSTOM row. */
  @IsOptional() HAS_CUSTOM_ROW?: boolean;
  /** English name (FLEXCUBE keeps the Arabic full name in NAME). */
  @IsOptional() @IsString() FIRST_NAME?: string;
  @IsOptional() @IsString() LAST_NAME?: string;
  @IsOptional() @IsString() PASSPORT_NUMBER?: string;
  @IsOptional() @IsString() PASSPORT_ISSUE_DATE?: string;
  @IsOptional() @IsString() PASSPORT_EXPIRY_DATE?: string;
  @IsOptional() @IsString() PLACE_OF_ISSUE?: string;
  @IsOptional() @IsString() NATIONAL_ID?: string;
}

export class FlexcubeCorporateDto {
  /** CONFIRMED: STTM_KYC_CORPORATE_CUSTOM.CRP_BUSINESS_NAME (maps to REIS business_name). */
  @IsString() @IsNotEmpty() CRP_BUSINESS_NAME: string;
  /** CONFIRMED: maps to REIS incorp_country (REIS nationality is derived from it too). */
  @IsString() @IsNotEmpty() PARENT_CMPNY_COUNTRY: string;
  /** PROVISIONAL: list of operation countries (REIS operation_country is an array). */
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  OPERATION_COUNTRY: string[];
  @IsString() @IsNotEmpty() LEGAL_ENTITY: string;
  @IsString() @IsNotEmpty() ACTIVITY: string;
  /** Values such as 203/204 await Bank verification. */
  @IsString() @IsNotEmpty() ACC_PURPOSE: string;
  @IsString() @IsNotEmpty() SOURCE_OF_INCOME: string;
  /** Numeric (REIS fin_info is numeric). Numeric strings are accepted; blank/null/NaN are rejected, never 0. Transport TBD. */
  @StrictNumber() @IsNumber({ allowNaN: false, allowInfinity: false }) FIN_INFO: number;
  @IsOptional() @IsString() TRADE_NO?: string;
  /** Key persons read from STTM_KYC_CORP_KEYPERSONS (absent / empty = no related parties). */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FlexcubeRelatedPartyDto)
  RELATED_PARTIES?: FlexcubeRelatedPartyDto[];
}

export class FlexcubeCustomerRequest {
  /** CONFIRMED: FLEXCUBE KYC reference number; REIS systemId. */
  @IsString() @IsNotEmpty() KYC_REF_NO: string;
  /** CONFIRMED to exist later; null/absent until the customer is created. */
  @IsOptional() @IsString() CUSTOMER_NO?: string;
  @IsIn(['INDIVIDUAL', 'CORPORATE']) CUSTOMER_TYPE: 'INDIVIDUAL' | 'CORPORATE';
  @IsString() @IsNotEmpty() ACCOUNT_MANAGER_LOGIN: string;
  @IsEmail() ACCOUNT_MANAGER_EMAIL: string;
  @IsIn(YES_NO) PEP: string;
  /**
   * CONFIRMED: FLEXCUBE stores PRODUCT_CODE (ACCOUNT_CLASS is reference only). One KYC can hold
   * several products (STTM_KYC_RETAIL_PRODUCT_CUSTOM / STTM_KYC_CORP_PRODUCT_CUSTOM rows).
   */
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  PRODUCT_CODES: string[];
  @IsString() @IsNotEmpty() DISTRIBUTION_CHANNEL: string;

  @ValidateIf((o: FlexcubeCustomerRequest) => o.CUSTOMER_TYPE === 'INDIVIDUAL')
  @IsDefined()
  @ValidateNested()
  @Type(() => FlexcubeIndividualDto)
  individual?: FlexcubeIndividualDto;

  @ValidateIf((o: FlexcubeCustomerRequest) => o.CUSTOMER_TYPE === 'CORPORATE')
  @IsDefined()
  @ValidateNested()
  @Type(() => FlexcubeCorporateDto)
  corporate?: FlexcubeCorporateDto;
}
