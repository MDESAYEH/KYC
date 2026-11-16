# Confirmed vs TBD requirements (KYC scope only - AML is out of scope)

Rule: nothing in the TBD table is invented. Each item is isolated behind an interface or configuration.
Important distinction: a **REIS contract** item can be CONFIRMED while the **FLEXCUBE source mapping** for the same thing is TBD.

## CONFIRMED

### REIS side (KYC V1.2 documentation + working Postman collection)

| Area | Requirement | Where in code |
|---|---|---|
| Auth request | `POST {base_url}/xauth/authenticate/`, headers `Content-Type`, `x-auth-tenant`; body `user_name`, `password`; fresh token before onboarding | `reis.constants.ts`, `dto/reis-auth.dto.ts` |
| Auth response | `{ "token": "..." }` (Postman reads `response.json().token`). Held internally under any name (e.g. `access_token`); never persisted/logged | `ReisAuthResponse` |
| Token header | Onboarding uses `x-auth-token`; no `Authorization` | `REIS_HEADERS` |
| Onboarding | `POST {base_url}/onboarding/v2/searchOnboardCustomer` | `REIS_PATHS` |
| Forms | Individual 1/PP, Corporate 2/PM, Individual relation 3/PP, Corporate relation 4/PM | `REIS_FORM` |
| Field types | `source_income_individual` string, `m_income` **number**, `source_income_organization` string, `fin_info` **number** | `ReisIndividualRequest`, `ReisCorporateRequest` |
| Date format | `cus_birth_date`, `issue_date`, `expiry_date`, `valid_until` must be `YYYY-MM-DD` (strict, real calendar dates). Enforced on the REIS outbound side | `reis/reis-date.ts` |
| Individual relation DTO (V1.5) | Required: systemName, systemId, formId, entity_type, relationshipId, first_name, last_name, cus_birth_date, nationality, citizenship, nid, issue_date, valid_until. Optional: birth_place, tin, national_id, issue_place | `ReisIndividualRelationEntry` / `ReisIndividualRelationItems` |
| Individual relation relationshipId (formId 3) | **Only** 1 PARENT, 2 SPOUSE, 3 CHILD, 4 LEGALGUARD, 5 EMERGENCY, 6 COOWNER, 7 AUTHORIZED; ids 8-15 are rejected | `ReisIndividualRelationshipId`, transformer |
| Corporate relation DTO | Required: systemName, systemId, formId, entity_type, relationshipId, business_name, nationality. Optional: trade_no | `ReisCorporateRelationEntry` / `ReisCorporateRelationItems` |
| Organization relation relationshipId (formId 4) | **Only** 6 COOWNER, 7 AUTHORIZED, 8 BENEFICIAR, 9 SHAREHOLDE, 10 MANAGER, 11 PARTNER, 12 OWNER, 13 EXECUTIVE, 14 CEO, 15 CFO; ids 1-5 are rejected | `ReisCorporateRelationshipId`, transformer |
| Onboarding statuses | `CLEAN`, `PENDING`, `REJECT` | `ReisOnboardingStatus` |
| Final (webhook) statuses | `CUSTOMER`, `BLOCKED` - a separate enum from onboarding statuses | `ReisFinalStatus` |
| Token lifecycle | A FRESH token is obtained before EVERY onboarding call; no caching or reuse (current working Postman behaviour) | `ReisOnboardingClient`, `docs/reis-transport.md` |
| Onboarding envelope | Top level `systemName`, `systemId` (= KYC_REF_NO), `formId`, `items`, `relations`; `entity_type` and all business fields INSIDE `items` (Individual confirmed by the working Postman). Types: `ReisOnboardingRequest<TItems, TRelation>`, `ReisIndividualItems`, `ReisCorporateItems` | `reis/dto/` |
| Relation entry wire shape | `{formId, entity_type, items:{entity_type,...}, relationshipId, systemName, systemId}`; `entity_type` intentionally present on BOTH the entry and `items` (preserve until REIS says otherwise) | `ReisIndividualRelationEntry` |
| Relations transport | Relations are NOT separate calls: they are the `relations` array inside the main `POST /onboarding/v2/searchOnboardCustomer` body (`{systemName, systemId, formId, items, relations:[{formId, entity_type, items, relationshipId, systemName, systemId}]}`) | `ReisOnboardingRequest`, `ReisRelationEntry` |
| Onboarding response | Fields `status` (CLEAN/PENDING/REJECT), `riskCalculationId`, `reisId`, `instruction`, `errorMessage`; ids kept as string or number; `instruction`/`errorMessage` preserved as response data | `ReisOnboardingResponse`, `reis-response.parser.ts` |
| REJECT handling | A valid REJECT is a NORMAL result, even with an informational `errorMessage`; a recognized status is never turned into a failure by `errorMessage` | `parseOnboardingResponse` |
| Hard failures | Malformed response / missing required structure, unknown status, non-2xx, 401/403, timeout, network failure | `reis.errors.ts` |
| TLS | Certificate validation always on; no `rejectUnauthorized`/`strictSSL`/`NODE_TLS_REJECT_UNAUTHORIZED` anywhere (enforced by a scan test); https required in production; redirects not followed | `test/tls-safety.spec.ts` |
| REIS startup config | `REIS_BASE_URL`, `REIS_TENANT`, `REIS_USERNAME`, `REIS_PASSWORD`, `REIS_TIMEOUT_MS` validated at startup; errors name variables only | `reis.config.ts` |
| Transformation (Step 4) | FLEXCUBE -> canonical -> reference mapping -> REIS envelope; rules labelled CONFIRMED/PROVISIONAL/TBD in `docs/transformation.md` | `flexcube-to-canonical.mapper.ts`, `canonical-to-reis.transformer.ts` |
| Derived duplicates | `nationality` = `nationality_customer`, `citizenship` = `citizenship_customer`, corporate `nationality` = incorporation country; FLEXCUBE need not send duplicates | `CanonicalToReisTransformer` |
| `operation_country` | REIS array semantics preserved (each entry mapped) | `ReisCorporateItems` |
| Country codes | REIS requires country codes for nationality_customer, citizenship_customer, incorp_country, nationality, operation_country (CONFIRMED); using the NATIONALITY source mapping for all of them is PROVISIONAL | `country-mapping.ts` |
| Fail-before-REIS | Missing input, bad date/number, unmapped value, unapproved document code, or a TBD rule the input needs -> typed error, no partial payload | `transformation.errors.ts` |
| Workflow (Step 5) | mapper -> transformer -> persist case -> fresh REIS auth -> onboarding -> persist result; KYC_REF_NO = systemId; CLEAN / PENDING / REJECT handled separately (REJECT is never converted to BLOCKED); duplicate KYC_REF_NO returns a typed DUPLICATE with no external call; validation/mapping failures happen before REIS; no automatic retry | `kyc/kyc.workflow.ts`, `docs/workflow.md` |
| Delivery uncertainty | Timeout / reset / 5xx / unreadable 2xx on onboarding are persisted as `DELIVERY_UNCERTAIN` (diagnostic `requestMayHaveReachedReis`), never retried | `kyc-failure.classifier.ts` |
| REIS response storage | `riskCalculationId`, `reisId`, `status`, `instruction`, `errorMessage` are stored on the KYC case (`reis_instruction`, `reis_error_message` added by migration 2). instruction/errorMessage may be sensitive: persisted but never logged, never in exception messages, never in unrelated responses | `typeorm-kyc-case.repository.ts`, `docs/workflow.md` |
| `/customerStatus` (Step 6) | `POST /customerStatus` JSON; final status only CUSTOMER or BLOCKED; correlation by systemId = KYC_REF_NO; HTTP 200 on successful processing incl. safe identical duplicate; idempotent (APPLIED / DUPLICATE / CONFLICT / UNKNOWN_CASE) | `webhook/`, `docs/customer-status-webhook.md` |
| Final-state safety | A final status is applied once and only for a case in `REIS_PENDING`; CLEAN/REJECT/other cases are never silently changed (typed INCONSISTENT_STATE); a different REIS customerId is a typed CUSTOMER_ID_MISMATCH; REIS customerId and FLEXCUBE CUSTOMER_NO are separate | `applyFinalStatus` |
| REIS decision vs FLEXCUBE update | Tracked separately: `final_status` vs `flexcube_update_status` (NOT_ATTEMPTED / PENDING / APPLIED / FAILED); a FLEXCUBE failure never erases the REIS decision; no automatic retry | `kyc_case` (migration 3) |
| Callback audit | `webhook_event` row per callback (eventId, receivedAt, systemId, incomingStatus, processingResult, kycCaseInternalId, processedAt + safe technical fields); no payload, secrets or PII | `webhook-event.ts` |
| Webhook security behaviour | Strategy invoked on every call; unconfigured = deny-all; `unrestricted-dev` only outside production; unknown modes stop startup. No mechanism is assumed | `webhook-security.ts` |
| Operational recovery (Step 7) | Operator-triggered `retryFailedUpdate` for FAILED FLEXCUBE updates (only with a CUSTOMER/BLOCKED decision; REIS decision never modified; success -> APPLIED, failure stays FAILED; attempt count/timestamps; idempotent). No automatic retry, scheduler or public admin endpoint | `operations/`, `docs/operations.md` |
| Operational queries (Step 7) | Stuck PENDING cases, DELIVERY_UNCERTAIN cases, FAILED FLEXCUBE updates, recent callback conflicts, recent UNKNOWN_CASE callbacks; safe metadata only (no customer data, CUSTOMER_NO, REIS free text) | `operational-query.service.ts` |
| Health (Step 7) | `GET /health/live`; `GET /health/ready` checks database + required configuration only; never calls REIS; responses contain no sensitive data | `health/` |
| Malformed callback audit (Step 7) | Malformed/oversized `POST /customerStatus` bodies produce an INVALID audit row (no raw body, no parser text); JSON validation not weakened | `customer-status-malformed.filter.ts`, `app.setup.ts` |
| Typed reconciliation outcome (Step 7) | A final callback for a `DELIVERY_UNCERTAIN` case is `RECONCILIATION_REQUIRED`: audited incl. incoming status, nothing applied, FLEXCUBE not called, onboarding not retried | `applyFinalStatus` |
| relationshipId per form | formId 3 accepts only 1-7; formId 4 accepts only 6-15 | transformer |
| Required fields | Individual and Corporate lists per V1.2 | `reis-individual.request.ts`, `reis-corporate.request.ts` |
| Webhook | Bank exposes `POST /customerStatus`; HTTP 200 on valid processing; idempotent | `webhook/dto/customer-status.dto.ts` (endpoint: Step 7) |

### Bank / FLEXCUBE side

| Area | Requirement | Where in code |
|---|---|---|
| Correlation | FLEXCUBE `KYC_REF_NO` = REIS `systemId`; later `CUSTOMER_NO`, nullable until created | `CanonicalKycBase`, `KycCase` |
| Individual | New `FIRST_NAME`, `LAST_NAME`; DOB = `STTM_KYC_RETAIL.BIRTH_DATE` (mandatory) | `FlexcubeIndividualDto` |
| TIN/document | FLEXCUBE field is free text; REIS `tin` = ID document type code; only an approved code may be sent | `documentTypeRaw`, `ReferenceMappingType.DOCUMENT_TYPE` |
| Corporate | ~~`business_name` <- `BUSINESS_NATURE`~~ **SUPERSEDED 2026-10-10** (REIS: `business_name` = legal name; FLEXCUBE will add a new text field; code not yet changed). `incorp_country` <- "Parent Company Country of Incorporation" (`PARENT_CMPNY_COUNTRY`): field named by FLEXCUBE, **semantic conflict with REIS's "entity's own country" to resolve** | `FlexcubeCorporateDto` |
| Product | FLEXCUBE `PRODUCT_CODE`, via configurable mapping (ACCOUNT_CLASS is reference only) | `ReferenceMappingType.PRODUCT` |
| Reference data | Configurable mappings (FLEXCUBE value -> REIS value, type, active, description); Excel values not hardcoded | `mapping/` |
| Related persons | Corporate key persons are read from `STTM_KYC_CORP_KEYPERSONS` and sent as `relations` (see `docs/flexcube-sync.md`) | `CanonicalRelatedPerson`, `FlexcubeKycSource` |
| Transformations | Name/code renames, Y/N -> boolean, Resident -> "1"/"2" are the integration layer's job | canonical -> REIS (Step 4) |
| Architecture | FlexcubeCustomerRequest -> CanonicalKycCustomer -> ReisIndividual/CorporateRequest | `canonical/`, `flexcube/`, `reis/` |
| Security | No hardcoded secrets; env config; real TLS validation; no tokens/passwords in DB or logs; masked payload logging | `config/`, `.env.example` |
| Persistence (Step 2) | KYC case correlation/audit/retry state via `IKycCaseRepository`; KYC_REF_NO and REIS systemId both unique and searchable; CUSTOMER_NO nullable; no tokens/passwords/full payloads stored. TypeORM + SQLite for local dev/test only; schema via migrations, never synchronized | `persistence/`, see `docs/persistence.md` |
| Reference mappings (Step 2) | `reference_mapping` table (type, FLEXCUBE value, REIS value, description, active, timestamps); exact case-sensitive lookup of ACTIVE rows; unmapped -> `UnmappedReferenceValueError`; no business mappings seeded | `mapping/`, `persistence/` |
| Strict numerics | Blank/whitespace/null/undefined/NaN/invalid numeric input is never coerced to 0 | `common/strict-number.ts` |
| Stack | Node.js + TypeScript 5.9 + NestJS 11 (CommonJS; NOT Nest 12/ESM); SQLite only for dev/test behind a repository abstraction | project |

## TBD / OPEN (design is pluggable)

| # | Open item | Current handling |
|---|---|---|
| 1 | Final FLEXCUBE -> API JSON contract | `FlexcubeCustomerRequest` is PROVISIONAL (only confirmed names marked) |
| 1a | FLEXCUBE date wire format (BIRTH_DATE etc.) | Not assumed: raw string in the FLEXCUBE DTO, converted to `YYYY-MM-DD` by `IFlexcubeDateNormalizer` (provisional strict-ISO default; ISO is NOT the confirmed FLEXCUBE format, and nothing in the workflow depends on that class - it is only reachable through `FLEXCUBE_DATE_NORMALIZER`). FLEXCUBE numeric transport for income/fin_info also provisional (numeric strings coerced) |
| 2 | How FLEXCUBE calls the API | Not assumed |
| 3 | FLEXCUBE -> API authentication | Not assumed |
| 4 | Final Bank-approved code mappings | Mapping table exists and is EMPTY (nothing seeded); unmapped value -> `UnmappedReferenceValueError` (never guessed) |
| 5 | Mandatory fields marked NA in the workbook | Validation rules provisional |
| 6 | **FLEXCUBE source mapping/population** for Corporate related persons. The REIS side is NOT TBD: relation DTOs and the nested `relations` transport are confirmed | `IRelationProvider` interface only |
| 7 | How FLEXCUBE is updated with the result | `IFlexcubeStatusUpdater` + `MockFlexcubeStatusUpdater` |
| 8 | Webhook security mechanism | `IWebhookSecurityStrategy`, `WEBHOOK_SECURITY_MODE`; none assumed |
| 9 | REIS webhook retry/timeout policy | Handler will be idempotent regardless |
| 10 | Multiple Source-of-Income checkboxes -> REIS string | `SingleSelectionSourceOfIncomeStrategy` placeholder: one selection -> `SOURCE_OF_INCOME` mapping; two or more -> `SourceOfIncomeRuleNotConfiguredError`; no guessing |
| 11 | Final document type code list | `DOCUMENT_TYPE` mapping type, no data |
| 12 | Corporate Account Purpose (e.g. 203/204) | `ACCOUNT_PURPOSE_CORPORATE` mapping type, no data |
| 13 | Production DB / deployment | `IKycCaseRepository` + TypeORM; SQLite for dev/test only. Non-SQLite types and SQLite-in-production fail fast. See `docs/persistence.md` |
| - | Retry policy | Configurable (`RETRY_*`); validation/business errors never retried |
| - | REIS retry policy for authenticate/onboarding | **PARTLY ANSWERED by REIS 2026-10-10:** on a timeout / no HTTP 200, treat the request as failed and send it again. The code still never retries (Bank resend rule pending, and REIS must confirm a resend with the same systemId creates no duplicate onboarding). Errors are classified only |
| - | Corporate onboarding wire shape (formId 2 envelope + `items`, corporate relation entry) | **Same approach as Individual CONFIRMED by REIS 2026-10-10** (per the technical specification). A real Corporate Postman will be shared once the reference data is provided and validated: UAT verification still pending |
| - | REIS application-error contract (when, if ever, a response is an "error" beyond the documented statuses) | `ReisApplicationError` exists but is reserved; nothing raises it today |
| - | Source for `fin_info` / `m_income` values on the FLEXCUBE side | Provisional DTO fields |
| - | FLEXCUBE Resident source values | **PROVISIONAL** `IFlexcubeResidentParser` (default: only `Y`/`N`); REIS `"1"`/`"2"` is confirmed |
| - | One FLEXCUBE reference list for all country fields (nationality, citizenship, incorporation, operation) | **CONFIRMED by FLEXCUBE 2026-10-10** ("same as provided in the Excel"); the REIS country-code requirement is CONFIRMED. Bank mapping data still TBD. The per-field switch in `reis/country-mapping.ts` is kept (its label can be changed to CONFIRMED when code changes are approved) |
| - | Corporate `source_income_organization` mapping list | **PROVISIONAL**: `SOURCE_OF_INCOME` mapping, single value |
| - | FLEXCUBE -> REIS relationshipId mapping | TBD with the corporate relation source mapping; canonical relations already carry a REIS relationshipId |
| - | **Organization-relation id semantics** | REIS pages (2026-10-10) tag 6, 8, 9, 11, 12 as individual-or-organization and 7, 10, 13, 14, 15 as individual-only. **Unresolved:** formId 4 carries `business_name` (an organization party) while formId 3 accepts only ids 1-7, so it is unclear how an individual CEO/MANAGER/EXECUTIVE/CFO/AUTHORIZED of a corporate customer is sent. Per-form id membership (formId 3: 1-7, formId 4: 6-15) stays enforced; no further rule is invented; question for REIS (N11) |
| - | Retry / resubmission business rule | **TBD.** No automatic retry exists. Cases in `FAILED_RETRYABLE`, `FAILED_PERMANENT`, `DELIVERY_UNCERTAIN` stay as they are and make a repeated KYC_REF_NO return `DUPLICATE`; only `VALIDATION_FAILED` cases (REIS never contacted) can be resubmitted |
| - | Storing REIS `instruction` / `errorMessage` | **CONFIRMED requirement, implemented.** REIS (2026-10-10): no maximum length, no personal/sensitive content, no storage/masking advice. Our stricter handling stays (stored, never logged, truncated at 4000 chars) until the Bank decides otherwise |
| - | Classification of failures (`FAILED_PERMANENT`, `FAILED_RETRYABLE`, `DELIVERY_UNCERTAIN`, HTTP 4xx vs 5xx handling) | **PROVISIONAL diagnostic classification, not confirmed REIS business rules**: REIS has not provided its retry/timeout/error-code policy. Never triggers automatic retry; `requestMayHaveReachedReis` is diagnostic only. Easily changed in `kyc-failure.classifier.ts` |
| - | **Inbound `/customerStatus` authentication** | **TBD, narrowed:** REIS supports NONE, BASIC (plain-text credentials), BEARER (access token / API key) and NTLM. None is implemented; unconfigured = deny-all; the Bank chooses (N10) |
| - | REIS callback retry / timeout policy | **PARTLY ANSWERED 2026-10-10:** any non-200 response makes REIS retry, with a final retry at about 00:00; afterwards a manual FLEXCUBE update is expected. Not given: REIS timeout, retry interval, maximum attempts. Our non-200 codes (400/401/404/409) remain provisional and would all be retried |
| - | Final `/customerStatus` schema | REIS (2026-10-10): the bank logic relies on `systemId` and `status` (CUSTOMER / BLOCKED). `customerId`, `systemName`, `ServiceType` are not stated as final; validation matches the sample |
| - | Real FLEXCUBE final-status update mechanism | **TBD** (FLEXCUBE team to confirm). `IFlexcubeStatusUpdater` + mock only; no automatic retry of failed updates (no approved rule) |
| - | Production database transaction / concurrency implementation | **TBD with the production database.** SQLite uses atomic conditional UPDATEs; review isolation, locking and a shared transaction when the engine is chosen |
| - | What to do with a callback for a case that is not `REIS_PENDING` (CLEAN, REJECT, delivery uncertain...) | No override rule invented: state preserved, audited, typed INCONSISTENT_STATE; business rule TBD |
| - | **DELIVERY_UNCERTAIN + later CUSTOMER/BLOCKED callback** | **PARTLY ANSWERED:** REIS says to treat a timed-out onboarding as failed and resend; no lookup mechanism exists. Open: idempotency of a resend, and whether a late callback is authoritative. Today: typed `RECONCILIATION_REQUIRED`, audited, nothing applied |
| - | `UPDATE_FAILED` -> HTTP 200 | **PROVISIONAL BANK-SIDE behaviour.** Consistent with REIS' confirmed retry-on-non-200: a 200 stops REIS retries, so a failed FLEXCUBE update is recovered by our operator service (REIS' own fallback is also a manual FLEXCUBE update) |
| - | Public admin/recovery endpoints, scheduler, automatic retry of FLEXCUBE updates | Not implemented (no approved rule); recovery is an application service only |
| - | FLEXCUBE inbound contract | **TBD.** `docs/flexcube-inbound-contract-draft.md` is a DRAFT for discussion, NOT approved; the provisional DTO adapter stays in place |
| - | Readiness for real UAT | Blockers listed in `docs/uat-readiness.md` |
| - | **FLEXCUBE reply 2026-10-10: Resident values** | **CONFIRMED** `Y` / `N`; implemented reading Y -> "1", N -> "2" |
| - | FLEXCUBE reply: `KYC_REF_NO` mapped to `CUSTOMER_NO` while creating the customer | **CONFIRMED**: `CUSTOMER_NO` is not available at initial submission (nullable) |
| - | FLEXCUBE reply: update operation idempotent on the FLEXCUBE side | **CONFIRMED** ("Yes"); FLEXCUBE-side retry/recovery still not described |
| - | FLEXCUBE reply: `relation_pep` source | Existing Y/N checkbox for Individual customers; column name TBD |
| - | FLEXCUBE reply: new LOV fields in `STDKYCMN` (Operation Country, Legal Entity, Activity, Distribution Channel, Product); profession from `STTM_KYC_OTHER_TYPES` (OCCUPATION); corporate source of income = renamed LOV; Corporate relations source `STTM_KYC_CORP_KEYPERSONS` (`RELATIONSHIP` LOV) | Sources named; **codes/mapping data from the Bank; other columns and request shape TBD** |
| - | FLEXCUBE reply: final contract and authentication | **Still OPEN** ("to be discussed internally") |
| - | FLEXCUBE reply: final status update "based on CODE level" | **Not a mechanism; still OPEN** (clarify what "code level" means) |
| - | Account manager login/email values | **NEW OPEN (Bank/REIS):** FLEXCUBE has the text fields and asks which value to pass |
| - | Identification document default `pass` / TIN `code` | **NEW OPEN:** wording ambiguous; Bank must map the values to REIS document-type codes |
| - | Operation Country multiplicity; key-person columns; corporate legal-name field name | **NEW OPEN (FLEXCUBE)** |
| - | **REIS reply 2026-10-10: REJECT** | **CONFIRMED by REIS:** a business decision (onboarding prohibited), not a technical issue, and it **must be reflected on FLEXCUBE**. NOT yet implemented: today REJECT is stored only and the FLEXCUBE update model supports CUSTOMER/BLOCKED only |
| - | How CLEAN / PENDING / REJECT / CUSTOMER / BLOCKED are represented in FLEXCUBE ("code level") | **NEW OPEN (FLEXCUBE + Bank)** (N8) |
| - | REIS sample JSON shows `"pep": "No"` (string) | The working Postman sends boolean `false` and returns 200: boolean kept; verify in UAT |
| - | REIS describes relation `citizenship` as "Residence Country (Country code)" | **NEW OPEN** (N12): confirm the main-form wording and which FLEXCUBE field feeds `citizenship` / `citizenship_customer` |
| - | REIS request limits | None to consider |
| - | UAT blocker status review 2026-10-10 | 24 blockers classified OPEN / PARTIAL / ANSWERED in `docs/uat-readiness.md` (10 / 13 / 1). The FLEXCUBE and REIS answers are already recorded here and in `docs/external-decisions-required.md` (sections 0 and 0b) so the same questions are not asked again |
| - | `KYC_REF_NO` / `CUSTOMER_NO` after customer creation | The link is made while the customer is created (confirmed), but whether `CUSTOMER_NO` is ever available at submission and how FLEXCUBE keeps the relationship afterwards is still to be detailed |
| - | Corporate Account Purpose `210` (in addition to 203 / 204) | **No meaning or REIS value assumed.** FLEXCUBE must extract the complete LOV (code + exact description, source table/column); Bank Business/Compliance approves meaning and mapping. All three stay unmapped |
| - | New external decisions N14-N23 (KYC version identity, callback 200 boundary, FLEXCUBE update transport / Oracle, mapping governance, volume and topology, retry time zone and rollback, `product` cardinality, 401 handling, KYC-only scope) | **OPEN.** Registered in `docs/external-decisions-required.md` (section 0c); nothing is implemented or assumed; code stays frozen until approved |
| - | Ordered plan after the answers | `docs/post-answers-implementation-plan.md` (gates 0-8, no dates). Receiving answers closes information blockers only: code, migrations, mapping data, operations and UAT remain to be done |
| - | Requests sent to each party | Drafts kept in `docs/outgoing-requests/` (REIS, FLEXCUBE, Bank Business/Compliance, IT/Security/Infrastructure) |
| - | **Architecture: who calls REIS (N24)** | **OPEN.** FLEXCUBE Approach Document (23-Sep-2026): FCUBS scheduler submits to REIS directly via a custom staging table; the Bank builds the PENDING-status webhook and updates FLEXCUBE with the table details FLEXCUBE will provide. This project implements FLEXCUBE -> API -> REIS. Decide in writing |
| - | FCUBS authorization rule (Approach Document) | CLEAN / CUSTOMER allow authorization; REJECT / BLOCKED make it impossible (answers part of how REJECT is reflected in FLEXCUBE; the technical update mechanism is still open) |
| - | Candidate source of `business_name` | Mapping workbook V1: `STTM_KYC_CORPORATE_CUSTOM - CRP_BUSINESS_NAME` (PROVISIONAL until FLEXCUBE confirms) |
| - | `systemName` value | Workbook says "FLEXCUBE or FCUBS"; working Postman uses `Flexcube`; stays configurable (`REIS_SYSTEM_NAME`), open |
| - | Code comment calling `BUSINESS_NATURE` -> `business_name` "CONFIRMED" (`flexcube-to-canonical.mapper.ts`) | Outdated (mapping superseded); the comment is to be corrected when a code change is approved |
