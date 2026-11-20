/**
 * PROVISIONAL SQL against the FLEXCUBE KYC tables. Table and column names come from the agreed
 * mapping file (RESI-KYC_Payload Field Mappings V2_5, column "FLEXCUBE Mapping V1") and from
 * Finexta's answers (03/11/2026). Read-only; every value is a bind variable.
 *
 * Verified on UAT1 (10/11/2026, read-only check): STTM_KYC_RETAIL_CUSTOM.FUNDS_SOURCE (not
 * FUND_SOURCE), STTM_KYC_OTHER_TYPES is keyed by KYC_REFERENCE_NO, and STTM_KYC_CORPORATE has no
 * DISTRIBUTION_CHANNEL (read from STTM_KYC_CORPORATE_CUSTOM, as for retail).
 *
 * Assumptions to confirm with Finexta (Abhilash):
 *  - the other KYC tables are keyed by KYC_REF_NO;
 *  - STTM_KYC_MASTER.RECORD_STAT = 'O' means an open (not closed / deleted) record;
 *  - KYC_CUST_TYPE is R (retail / individual) or C (corporate);
 *  - STTM_KYC_CORP_KEYPERSONS and STTM_KYC_CORP_KEYPERSONS_CUSTOM are keyed by KYC_REF_NO and
 *    pair up on KYC_REF_NO + KYC_ID + NAME (KYC_ID is free user input, unique only per company);
 *    they hold no modification number, so the current rows are read;
 *  - key-person columns: KEYPERSONS (KYC_ID, NAME, KYC_KEYPERSON_TYPE I / C, RELATIONSHIP,
 *    DATE_OF_BIRTH, NATIONALITY, ADDRESS_COUNTRY, PLACE_OF_BIRTH, TIN) and KEYPERSONS_CUSTOM
 *    (FIRST_NAME, LAST_NAME, PASSPORT_NUMBER, PASSPORT_ISSUE_DATE, PASSPORT_EXPIRY_DATE,
 *    PLACE_OF_ISSUE, NATIONAL_ID).
 */

/*
 * The key-person type column (I / C) is configurable (FLEXCUBE_KEYPERSON_TYPE_COLUMN, default
 * KYC_KEYPERSON_TYPE): UAT1 has no KYC_KEYPERSON_TYPE (OWNERSHIP_TYPE exists) and Finexta has not
 * said which column holds it. The value is validated as a plain identifier and aliased back to
 * KYC_KEYPERSON_TYPE, so only the .env changes when Finexta answers. Until the configured column
 * is proven to exist (CORPORATE_TYPE_COLUMN_EXISTS_SQL) corporate KYCs are not selected at all.
 */

/**
 * Is the configured key-person type column present in STTM_KYC_CORP_KEYPERSONS_CUSTOM? (metadata only)
 * UAT1 read-only check (17/11/2026): KYC_KEYPERSON_TYPE exists in OBPPRD.STTM_KYC_CORP_KEYPERSONS_CUSTOM and
 * NOT in OBPPRD.STTM_KYC_CORP_KEYPERSONS: the type is read from the CUSTOM table. Values (Abhilash, 10/11/2026):
 * I = Individual, C = Corporate.
 */
export const CORPORATE_TYPE_COLUMN_EXISTS_SQL = `
  SELECT COUNT(*) AS N FROM ALL_TAB_COLUMNS
   WHERE TABLE_NAME = 'STTM_KYC_CORP_KEYPERSONS_CUSTOM' AND COLUMN_NAME = :columnName`;

export const INDIVIDUAL_KYC_SQL = `
  SELECT r.BIRTH_DATE, r.BIRTH_PLACE, r.PASSPORT_NO, r.PASSPORT_EXPIRY_DATE, r.PEP,
         r.NATIONALITY, r.LOCAL_ADDR_COUNTRY, r.ACC_PURPOSE, r.RESIDENT, r.TOTAL_INCOME,
         c.FIRST_NAME, c.LAST_NAME, c.ACCOUNT_MANAGER_LOGIN, c.ACCOUNT_MANAGER_EMAIL,
         c.RELATION_PEP, c.DISTRIBUTION_CHANNEL, c.FUNDS_SOURCE,
         o.OCCUPATION
    FROM STTM_KYC_RETAIL r
    JOIN STTM_KYC_RETAIL_CUSTOM c ON c.KYC_REF_NO = r.KYC_REF_NO
    LEFT JOIN STTM_KYC_OTHER_TYPES o ON o.KYC_REFERENCE_NO = r.KYC_REF_NO
   WHERE r.KYC_REF_NO = :kycRefNo`;

export const INDIVIDUAL_PRODUCTS_SQL = `
  SELECT PRODUCT_CODE FROM STTM_KYC_RETAIL_PRODUCT_CUSTOM
   WHERE KYC_REF_NO = :kycRefNo ORDER BY PRODUCT_CODE`;

export const CORPORATE_KYC_SQL = `
  SELECT k.TRADE_LICENCE_NO, k.PARENT_CMPNY_COUNTRY, k.ACC_PURPOSE, k.FUNDS_SOURCE,
         k.ANNUAL_TURNOVER,
         c.CRP_BUSINESS_NAME, c.ACCOUNT_MANAGER_LOGIN, c.ACCOUNT_MANAGER_EMAIL, c.PEP,
         c.LEGAL_ENTITY, c.ACTIVITY, c.DISTRIBUTION_CHANNEL
    FROM STTM_KYC_CORPORATE k
    JOIN STTM_KYC_CORPORATE_CUSTOM c ON c.KYC_REF_NO = k.KYC_REF_NO
   WHERE k.KYC_REF_NO = :kycRefNo`;

export const CORPORATE_PRODUCTS_SQL = `
  SELECT PRODUCT_CODE FROM STTM_KYC_CORP_PRODUCT_CUSTOM
   WHERE KYC_REF_NO = :kycRefNo ORDER BY PRODUCT_CODE`;

/**
 * Key persons of a corporate KYC. LEFT JOIN: a missing CUSTOM row comes back as
 * CUSTOM_KYC_REF_NO = NULL and is reported as a validation error, never silently dropped.
 */
export const corporateKeypersonsSql = (typeColumn: string): string => `
  SELECT k.KYC_ID, k.NAME, cu.${typeColumn} AS KYC_KEYPERSON_TYPE, k.RELATIONSHIP, k.DATE_OF_BIRTH,
         k.NATIONALITY, k.ADDRESS_COUNTRY, k.PLACE_OF_BIRTH, k.TIN,
         cu.KYC_REF_NO AS CUSTOM_KYC_REF_NO, cu.FIRST_NAME, cu.LAST_NAME, cu.PASSPORT_NUMBER,
         cu.PASSPORT_ISSUE_DATE, cu.PASSPORT_EXPIRY_DATE, cu.PLACE_OF_ISSUE, cu.NATIONAL_ID
    FROM STTM_KYC_CORP_KEYPERSONS k
    LEFT JOIN STTM_KYC_CORP_KEYPERSONS_CUSTOM cu
      ON cu.KYC_REF_NO = k.KYC_REF_NO AND cu.KYC_ID = k.KYC_ID AND cu.NAME = k.NAME
   WHERE k.KYC_REF_NO = :kycRefNo
   ORDER BY k.KYC_ID, k.NAME`;

export const CORPORATE_COUNTRIES_SQL = `
  SELECT OPERATION_COUNTRY FROM STTM_KYC_CORP_COUNTRY_CUSTOM
   WHERE KYC_REF_NO = :kycRefNo ORDER BY OPERATION_COUNTRY`;
