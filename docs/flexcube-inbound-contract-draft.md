# FLEXCUBE -> Integration API: inbound contract DRAFT

> **DRAFT - NOT YET APPROVED.** The final FLEXCUBE -> Integration API contract (URL, method, authentication, JSON shape, column names) is **TBD**. This document lists what the Integration API needs from FLEXCUBE, based on the current mapping, to support the discussion with the FLEXCUBE team. The application is NOT wired to this exact shape: it uses the provisional DTO adapter (`FlexcubeCustomerRequest`), which will be adjusted after the discussion.

> **Update 2026-10-10:** the FLEXCUBE team replied to the 18 questions (see `docs/external-decisions-required.md`, section 0). The rows below carry the effect of that reply. Requests 1 and 2 (final contract, authentication) are still to be discussed internally by FLEXCUBE.

FLEXCUBE does **not** have to use REIS field names. The Integration API renames and translates:

```
FLEXCUBE source field  ->  canonical field  ->  (reference mapping)  ->  REIS target field (inside items)
```

Legend: **CONFIRMED** = stated by the FLEXCUBE team / REIS docs; **PROVISIONAL** = implemented behind an adapter, name or format a placeholder; **TBD** = nothing decided, nothing invented.

## Transport and common data
| Item | Status |
|---|---|
| Inbound URL, HTTP method, how FLEXCUBE calls the API | TBD |
| FLEXCUBE -> API authentication | TBD |
| Response format / error codes returned to FLEXCUBE | TBD |
| Date wire format (e.g. `BIRTH_DATE`) | TBD. The adapter normalizes to `YYYY-MM-DD` (REIS requirement, CONFIRMED) through a swappable normalizer; the default accepts only strict ISO and is NOT a confirmed format |
| Numeric transport (`MONTHLY_INCOME`, `FIN_INFO`) | PROVISIONAL: number, or a plain decimal string such as `"1500.50"`; blank/null/NaN rejected, never treated as 0 |
| Y/N flags | CONFIRMED values Y / N (converted to boolean) |

| FLEXCUBE source | Canonical | REIS target | Status |
|---|---|---|---|
| `KYC_REF_NO` | `kycRefNo` | `systemId` (and our correlation key) | **CONFIRMED** |
| `CUSTOMER_NO` (nullable until the customer exists) | `customerNo` | not sent to REIS | **CONFIRMED** to exist later; submission-time presence TBD |
| customer type (`CUSTOMER_TYPE`: INDIVIDUAL / CORPORATE) | `customerType` | `formId` 1 / 2, `items.entity_type` PP / PM | PROVISIONAL name and values |
| `ACCOUNT_MANAGER_LOGIN`, `ACCOUNT_MANAGER_EMAIL` | `accountManagerLogin`, `accountManagerEmail` | `account_manager_login`, `account_manager_email` | PROVISIONAL names. FLEXCUBE text fields exist; **FLEXCUBE asks which value to pass** (Bank/REIS decision N1) |
| `PRODUCT_CODE` (ACCOUNT_CLASS is reference only) | `productCode` | `product` via `PRODUCT` mapping | **CONFIRMED** field; mapping data TBD |
| `DISTRIBUTION_CHANNEL` | `distributionChannel` | `distribution_channel` via `DISTRIBUTION_CHANNEL` mapping | PROVISIONAL name; mapping data TBD |
| `PEP` (Y/N) | `pep` | `pep` (boolean) | Y/N -> boolean CONFIRMED; field name PROVISIONAL |

## Individual (retail)
| FLEXCUBE source | Canonical | REIS target (`items.`) | Status |
|---|---|---|---|
| `FIRST_NAME` (new field) | `firstName` | `first_name` | **CONFIRMED** |
| `LAST_NAME` (new field) | `lastName` | `last_name` | **CONFIRMED** |
| `BIRTH_DATE` (`STTM_KYC_RETAIL.BIRTH_DATE`, mandatory) | `birthDate` | `cus_birth_date` (`YYYY-MM-DD`) | **CONFIRMED** source; wire format TBD |
| `BIRTH_PLACE` | `birthPlace` | `birth_place` (optional) | PROVISIONAL |
| `TIN` (currently free text, no validation) | `documentTypeRaw` | `tin` = ID document TYPE code, only through the `DOCUMENT_TYPE` mapping | **CONFIRMED** behaviour; approved code list TBD; FLEXCUBE column name PROVISIONAL. FLEXCUBE reply: "default will be 'pass'; if TIN data is available the value to pass is 'code'" - **ambiguous, to clarify (N2)** |
| `NID` (document number) | `nid` | `nid` (optional) | PROVISIONAL name |
| `ISSUE_DATE`, `EXPIRY_DATE` | `issueDate`, `expiryDate` | `issue_date`, `expiry_date` (optional) | PROVISIONAL |
| `RELATION_PEP` (Y/N) | `relationPep` | `relation_pep` | Source CONFIRMED (existing Y/N checkbox for Individual customers, 2026-10-10); column name TBD |
| `NATIONALITY` (one value) | `nationality` | `nationality_customer` and `nationality` (same value, derived) | Duplication rule CONFIRMED (FLEXCUBE sends one value); one FLEXCUBE list for all country fields **CONFIRMED by FLEXCUBE (2026-10-10)** ("same as provided in the Excel"); Bank mapping data still TBD |
| `CITIZENSHIP` (one value) | `citizenship` | `citizenship_customer` and `citizenship` (derived) | as above. **Open (N12):** the REIS relation form describes `citizenship` as "Residence Country (Country code)"; confirm the main-form wording and which FLEXCUBE field (country of residence?) should feed it |
| `PROFESSION` | `profession` | `profession` via `PROFESSION` mapping | Source named by FLEXCUBE: `STTM_KYC_OTHER_TYPES` (OCCUPATION), LOV; **Bank to provide the data** |
| `ACC_PURPOSE` | `accountPurpose` | `account_purpose_individual` via `ACCOUNT_PURPOSE_INDIVIDUAL` mapping | name used by the FLEXCUBE team as an example; mapping data TBD |
| `RESIDENT` | `isResident` | `resident` `"1"` (resident) / `"2"` (non-resident) | **CONFIRMED by FLEXCUBE (2026-10-10): values are `Y` / `N`.** Reading implemented: Y -> "1", N -> "2" (REIS values CONFIRMED) |
| income-source flags (Salary, Rental, Investment, Business, other; multiple may be Y) | `selectedIncomeSources` | `source_income_individual` (string) | flags exist (CONFIRMED); **column names TBD; the rule for several ticked flags is TBD** (one flag only is accepted today; two or more are rejected, never guessed) |
| `MONTHLY_INCOME` | `monthlyIncome` | `m_income` (number) | PROVISIONAL name; numeric type CONFIRMED |
| Individual related persons | - | formId 3 | Not required from FLEXCUBE now |

## Corporate
| FLEXCUBE source | Canonical | REIS target (`items.`) | Status |
|---|---|---|---|
| ~~`BUSINESS_NATURE`~~ (`STTM_KYC_CORPORATE.BUSINESS_NATURE`) -> **new legal-name TEXT field** (name TBD) | `businessName` | `business_name` (not mapped) | **SUPERSEDED (2026-10-10):** REIS says `business_name` is the legal name, not the business nature; FLEXCUBE will introduce a new text field. Field name TBD. Code still uses `BUSINESS_NATURE` until approved |
| "Parent Company Country of Incorporation" (`PARENT_CMPNY_COUNTRY`) | `incorporationCountry` | `incorp_country` and `nationality` (derived) | Field named by FLEXCUBE; **semantic conflict to resolve:** REIS wants the entity's OWN country of incorporation, the label says parent company |
| `OPERATION_COUNTRY` (list of countries) | `operationCountries` | `operation_country` (**array**) | REIS array CONFIRMED. FLEXCUBE: new LOV in `STDKYCMN`; **whether several can be selected is unanswered (N6)** |
| `LEGAL_ENTITY` | `legalEntity` | `legal_entity` via `LEGAL_ENTITY` mapping | New LOV in the `STDKYCMN` screen (FLEXCUBE, 2026-10-10); codes from Bank |
| `ACTIVITY` | `activity` | `activity` via `ACTIVITY` mapping | New LOV in the `STDKYCMN` screen (FLEXCUBE, 2026-10-10); codes from Bank |
| `ACC_PURPOSE` | `accountPurpose` | `account_purpose_organization` via `ACCOUNT_PURPOSE_CORPORATE` mapping | name as example; **values such as 203 / 204 need Bank verification and have no mapping** |
| `SOURCE_OF_INCOME` (single value) | `sourceOfIncome` | `source_income_organization` (string) | Single LOV value: FLEXCUBE will rename "Main Source of Funds" to "Corporate Source of Income" (2026-10-10); field name and codes TBD |
| `PRODUCT_CODE` | `productCode` | `product` | **CONFIRMED** |
| `FIN_INFO` | `financialInfo` | `fin_info` (number) | numeric CONFIRMED; FLEXCUBE source TBD |
| `TRADE_NO` | `tradeNo` | `trade_no` (optional) | PROVISIONAL |
| Corporate related persons | - | formId 4 `relations` | REIS contract CONFIRMED (ids 6-15 for formId 4); REIS pages (2026-10-10) tag organization-relation ids 7, 10, 13, 14, 15 as individual-only (how such persons are sent is open, N11). Source table named by FLEXCUBE: `STTM_KYC_CORP_KEYPERSONS` (field `RELATIONSHIP`, LOV); other columns, relation codes (Bank) and how it enters the request are **still TBD** |

Reference values (nationality, profession, product, account purpose, channel, legal entity, activity, document type, source of income) are sent as FLEXCUBE codes; the Bank-approved FLEXCUBE -> REIS mapping tables are still to be provided (RED/GREEN workbook items). Unmapped values are rejected, never passed through or guessed.

## Proposed JSON (for discussion only)

> **DRAFT - NOT YET APPROVED.** Illustrative values; field names other than those marked CONFIRMED above are placeholders. This is the shape of the current provisional adapter, not an agreed contract.

```json
{
  "KYC_REF_NO": "KYC0000001",
  "CUSTOMER_NO": null,
  "CUSTOMER_TYPE": "INDIVIDUAL",
  "ACCOUNT_MANAGER_LOGIN": "<login>",
  "ACCOUNT_MANAGER_EMAIL": "<email>",
  "PEP": "N",
  "PRODUCT_CODE": "<flexcube product code>",
  "DISTRIBUTION_CHANNEL": "<flexcube channel code>",
  "individual": {
    "FIRST_NAME": "<first name>",
    "LAST_NAME": "<last name>",
    "BIRTH_DATE": "<date, format TBD>",
    "TIN": "<document type, free text today>",
    "NID": "<document number>",
    "RELATION_PEP": "N",
    "NATIONALITY": "<flexcube code>",
    "CITIZENSHIP": "<flexcube code>",
    "PROFESSION": "<flexcube code>",
    "ACC_PURPOSE": "<flexcube code>",
    "RESIDENT": "<value TBD>",
    "INCOME_SOURCES": { "<FLAG_NAME_TBD>": "Y", "<OTHER_FLAG_NAME_TBD>": "N" },
    "MONTHLY_INCOME": 1500.5
  }
}
```
```json
{
  "KYC_REF_NO": "KYC0000002",
  "CUSTOMER_TYPE": "CORPORATE",
  "ACCOUNT_MANAGER_LOGIN": "<login>",
  "ACCOUNT_MANAGER_EMAIL": "<email>",
  "PEP": "N",
  "PRODUCT_CODE": "<flexcube product code>",
  "DISTRIBUTION_CHANNEL": "<flexcube channel code>",
  "corporate": {
    "BUSINESS_NATURE": "<business nature>",
    "PARENT_CMPNY_COUNTRY": "<flexcube code>",
    "OPERATION_COUNTRY": ["<flexcube code>", "<flexcube code>"],
    "LEGAL_ENTITY": "<flexcube code>",
    "ACTIVITY": "<flexcube code>",
    "ACC_PURPOSE": "<flexcube code, 203/204 unverified>",
    "SOURCE_OF_INCOME": "<flexcube code>",
    "FIN_INFO": 250000
  }
}
```

## Questions for the FLEXCUBE team
1. How will FLEXCUBE call the API (URL, method, push vs. batch) and how will it authenticate?
2. Date format for `BIRTH_DATE`, `ISSUE_DATE`, `EXPIRY_DATE`; decimal format for income fields.
3. Exact column/field names for everything marked PROVISIONAL, and which fields marked NA in the workbook are really mandatory.
4. Which values does `RESIDENT` carry? What are the income-source columns, and what is the Bank's rule when several are ticked?
5. Is `CUSTOMER_NO` ever present at submission, and how will the final REIS status be written back to FLEXCUBE (mechanism TBD)?
6. Are `NATIONALITY`, `CITIZENSHIP`, `PARENT_CMPNY_COUNTRY` and `OPERATION_COUNTRY` all drawn from one reference list?
7. When will the Corporate related-person data (and relationship type values) be provided?
