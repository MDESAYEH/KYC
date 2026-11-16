# Transformation: FLEXCUBE -> canonical -> reference mapping -> REIS JSON (Step 4)

```
FlexcubeCustomerRequest  (provisional inbound DTO)
   |  FlexcubeToCanonicalMapper   validate / normalize (dates, Y/N, numbers, resident, income flags)
   v
CanonicalKycCustomer     (raw FLEXCUBE reference values, normalized dates, real numbers)
   |  CanonicalToReisTransformer  reference mapping + REIS-only derivations
   v
REIS onboarding envelope (systemName / systemId / formId / items / relations)
```

Neither step calls REIS, writes to the database, or retries. Any problem throws a typed error **before** a REIS call; no partially valid payload is ever returned.

Status labels used below: **CONFIRMED** (stated by the Bank/FLEXCUBE/REIS documentation or the working Postman), **PROVISIONAL** (implemented behind a swappable interface, to be confirmed), **TBD** (deliberately not implemented).

## Wire shape (REIS onboarding request)
| Rule | Status |
|---|---|
| Top level: `systemName`, `systemId`, `formId`, `items`, `relations` | CONFIRMED (Individual, working Postman) |
| Inside `items`: `entity_type` and all business fields (not flat on the top level) | CONFIRMED (Individual) |
| `systemName` = configured value (`REIS_SYSTEM_NAME`, default `Flexcube`) | CONFIRMED value, configurable |
| `systemId` = FLEXCUBE `KYC_REF_NO` | CONFIRMED |
| Individual: `formId` 1, `items.entity_type` `PP` | CONFIRMED |
| Corporate: `formId` 2, `items.entity_type` `PM`, same envelope, fields inside `items` | Field definitions CONFIRMED (V1.2). Wire serialization DERIVED from V1.2 + the Individual example: **UAT verification pending** with a real Corporate request |
| Relation entry: `formId`, `entity_type`, `items`, `relationshipId`, `systemName`, `systemId`; `entity_type` on the entry AND inside `items` (both preserved; do not "clean up" until REIS confirms) | CONFIRMED (Individual relation) |
| Corporate relation entry (`formId` 4, same shape, `entity_type` `PM` in both places) | DERIVED; UAT verification pending |
| `relations` is always present; `[]` when no confirmed relations exist | CONFIRMED |
| Individual relation (formId 3, V1.5): `nid`, `issue_date`, `valid_until` mandatory; `national_id` optional | CONFIRMED (REIS V1.5) |
| Names are Latin-only: `first_name`, `last_name` (customer and individual relations) and `business_name` (corporate customer and relations) accept only A-Z, a-z, space, dot, hyphen, apostrophe after trimming (REIS sanctions screening matches the same script only); the error names the field, never the value | Bank decision |
| Relations are part of the main request, never separate calls | CONFIRMED |
| `relationshipId` per form (V1.4 / V1.5): **formId 3 (Individual Relation) accepts 1-8** (AUTHORIZED, BENEFICIAR, CEO, CFO, COOWNER, MANAGER, OWNER, SHAREHOLDE); **formId 4 (Organization Relation) accepts only 2, 5, 7, 8** (BENEFICIAR, COOWNER, OWNER, SHAREHOLDE) | CONFIRMED (REIS V1.4 / V1.5) |
| FLEXCUBE source of corporate relations | `STTM_KYC_CORP_KEYPERSONS` + `_CUSTOM`, read by `FlexcubeKycSource` (see `docs/flexcube-sync.md`); the related-party systemId is `<company KYC_REF_NO>-<KYC_ID>` | PROVISIONAL (UAT1 verification pending) |

## FLEXCUBE -> canonical (`FlexcubeToCanonicalMapper`)
| FLEXCUBE | Canonical | Rule | Status |
|---|---|---|---|
| `KYC_REF_NO` | `kycRefNo` | required, unchanged | CONFIRMED |
| `CUSTOMER_NO` | `customerNo` | nullable; absent/blank -> `null` | CONFIRMED |
| `FIRST_NAME`, `LAST_NAME` | `firstName`, `lastName` | required, unchanged | CONFIRMED |
| `BIRTH_DATE` | `birthDate` | required; normalized to `YYYY-MM-DD` by `IFlexcubeDateNormalizer` (injected) | Field CONFIRMED; **wire format PROVISIONAL** (default accepts only strict ISO; swappable) |
| `ISSUE_DATE`, `EXPIRY_DATE` | `issueDate`, `expiryDate` | optional; same normalizer | PROVISIONAL |
| `PRODUCT_CODE` | `productCode` | raw FLEXCUBE value, translated later | CONFIRMED |
| `BUSINESS_NATURE` (STTM_KYC_CORPORATE) | `businessName` | unchanged (not mapped) | **SUPERSEDED 2026-10-10:** REIS `business_name` is the legal name; FLEXCUBE will add a new text field. The code still maps `BUSINESS_NATURE` until a change is approved |
| `PARENT_CMPNY_COUNTRY` | `incorporationCountry` | raw value, translated later | CONFIRMED |
| `ACC_PURPOSE` | `accountPurpose` | renamed only (field names are the integration layer's job) | Field name CONFIRMED as an example |
| `PEP`, `RELATION_PEP` | `pep`, `relationPep` | `Y` -> true, `N` -> false; anything else rejected (case-sensitive) | CONFIRMED (Y/N -> boolean) |
| `RESIDENT` | `isResident` | interpreted by `IFlexcubeResidentParser`; default accepts only `Y`/`N`, else rejected | **PROVISIONAL** (FLEXCUBE source values unconfirmed) |
| `NATIONALITY`, `CITIZENSHIP` | `nationality`, `citizenship` | one value each; FLEXCUBE need not send duplicates | PROVISIONAL field names |
| `INCOME_SOURCES` (map name -> Y/N) | `selectedIncomeSources` | names set to `Y`, in received order; non Y/N flag rejected | PROVISIONAL shape (real columns unknown) |
| `MONTHLY_INCOME`, `FIN_INFO` | `monthlyIncome`, `financialInfo` | strict number: numeric strings like `"1500.50"` accepted; blank, whitespace, null, undefined, NaN, Infinity, `1e3`, text rejected - never becomes 0 | CONFIRMED numeric type; FLEXCUBE transport PROVISIONAL |
| `OPERATION_COUNTRY` | `operationCountries` | list, at least one, every entry non-blank | PROVISIONAL input shape; REIS array semantics CONFIRMED |
| `TIN`, `NID` | `documentTypeRaw`, `nid` | optional, kept separate; blank = not provided | CONFIRMED (free text; never sent unmapped) |
| `BIRTH_PLACE`, `TRADE_NO` | `birthPlace`, `tradeNo` | optional | PROVISIONAL names |

Required text is only checked for presence; values are never trimmed, case-folded or altered. Errors: `MissingRequiredFieldError`, `InvalidFieldValueError` (both `TransformationError`).

## Canonical -> REIS (`CanonicalToReisTransformer`)
| REIS `items` field | Source | Rule | Status |
|---|---|---|---|
| `nationality_customer` and `nationality` | `nationality` | **one** `NATIONALITY` mapping, written to both | Duplication rule CONFIRMED; mapping data TBD |
| `citizenship_customer` and `citizenship` | `citizenship` | **one** mapping, written to both (via `COUNTRY_MAPPING_TYPE`) | Duplication CONFIRMED; list used PROVISIONAL |
| `profession` | `profession` | `PROFESSION` mapping | CONFIRMED mechanism |
| `account_purpose_individual` | `accountPurpose` | `ACCOUNT_PURPOSE_INDIVIDUAL` mapping | CONFIRMED mechanism |
| `product` | `productCode` | `PRODUCT` mapping | CONFIRMED |
| `distribution_channel` | `distributionChannel` | `DISTRIBUTION_CHANNEL` mapping | CONFIRMED mechanism |
| `resident` | `isResident` | true -> `"1"`, false -> `"2"` | CONFIRMED REIS values; FLEXCUBE side PROVISIONAL |
| `pep`, `relation_pep` | booleans | as is | CONFIRMED |
| `tin` | `documentTypeRaw` | `DOCUMENT_TYPE` mapping; unmapped -> `UnmappedReferenceValueError`; omitted if absent | CONFIRMED (approved code list TBD) |
| `nid` | `nid` | document number, unchanged, separate from `tin` | CONFIRMED |
| `source_income_individual` | `selectedIncomeSources` | `ISourceOfIncomeStrategy`: exactly one selected -> `SOURCE_OF_INCOME` mapping (PROVISIONAL); none -> `MissingRequiredFieldError`; **two or more -> `SourceOfIncomeRuleNotConfiguredError`** (never guessed, never "first checkbox") | Aggregation rule **TBD** |
| `m_income` | `monthlyIncome` | number, finite | CONFIRMED |
| `cus_birth_date`, `issue_date`, `expiry_date` | dates | re-validated as strict `YYYY-MM-DD` before sending | CONFIRMED |
| `birth_place` | `birthPlace` | optional, unchanged | CONFIRMED |
| `business_name` | `businessName` | unchanged | CONFIRMED |
| `incorp_country` and `nationality` (corporate) | `incorporationCountry` | one mapped value written to both | Derivation CONFIRMED (V1.2); list used PROVISIONAL |
| `operation_country` | `operationCountries` | **array**: each entry mapped, order and length preserved | Array semantics CONFIRMED |
| `legal_entity`, `activity` | `legalEntity`, `activity` | `LEGAL_ENTITY`, `ACTIVITY` mappings | CONFIRMED mechanism |
| `account_purpose_organization` | `accountPurpose` | `ACCOUNT_PURPOSE_CORPORATE` mapping; **203/204 have no mapping and are not guessed** | Mapping data TBD (Bank verification) |
| `source_income_organization` | `sourceOfIncome` | single value via `SOURCE_OF_INCOME` mapping | PROVISIONAL |
| `fin_info` | `financialInfo` | number, finite | CONFIRMED |
| `trade_no` | `tradeNo` | optional | CONFIRMED |
| `account_manager_login`, `account_manager_email` | as is | required, unchanged | CONFIRMED |

### Country fields
- **REIS country-code requirement = CONFIRMED**: `nationality_customer`, `citizenship_customer`, `incorp_country`, `nationality` and `operation_country` are country codes (V1.2).
- **Reuse of the FLEXCUBE `NATIONALITY` source mapping for all country fields = PROVISIONAL**: the documentation does not say FLEXCUBE uses one identical source list for all of them. The choice is isolated in `src/reis/country-mapping.ts` (`COUNTRY_MAPPING_TYPE`, `DEFAULT_COUNTRY_MAPPING_TYPES`, one entry per `CountryField`: NATIONALITY, CITIZENSHIP, INCORPORATION_COUNTRY, OPERATION_COUNTRY). To split later, point a field at its own mapping type (and add that type to `ReferenceMappingType`); the transformer is unchanged and no mapping data is duplicated. A test demonstrates a per-field split.

## Failures (all thrown before any REIS call)
`MissingRequiredFieldError`, `InvalidFieldValueError`, `SourceOfIncomeRuleNotConfiguredError` (all `TransformationError`, permanent/non-retryable) and `UnmappedReferenceValueError` (no active approved mapping, or an unapproved document code). Messages name fields/rules, not customer data.

## Not part of this step
Production FLEXCUBE controller, orchestration workflow, database writes during transformation, REIS HTTP calls from the mapper/transformer, `/customerStatus`, FLEXCUBE status update, automatic retry, and any Bank-unapproved reference data (the mapping table stays empty; tests use synthetic `T-*`/`R-*` values only).
