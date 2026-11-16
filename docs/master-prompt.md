# MASTER PROMPT - FLEXCUBE <-> REIS KYC Integration API

You are joining an existing project. Read this fully before doing anything. Your job is to continue the work **without breaking what exists, without inventing requirements, and without changing code unless explicitly asked.** Answer the user in **Arabic** (the user writes Arabic); keep code, identifiers and documents in English.

## 1. What the project is
A bank "Integration API" that sits between **Oracle FLEXCUBE** (core banking) and **REIS KYC** (external KYC/risk platform).

```
FLEXCUBE -> Integration API -> REIS KYC          (submit a customer for KYC)
REIS     -> Integration API -> FLEXCUBE          (final result via POST /customerStatus, then FLEXCUBE update)
```
The API validates and maps FLEXCUBE data, transforms codes, builds the REIS request, authenticates to REIS, calls onboarding, stores correlation/audit state, and later applies REIS' final decision (CUSTOMER / BLOCKED) and updates FLEXCUBE.

**Scope: KYC only. AML/TFS is out of scope** unless separately approved.

**Open architecture question (N24):** the FLEXCUBE Approach Document (23-Sep-2026) says FCUBS's own scheduler submits to REIS and the Bank only builds the `customerStatus` webhook and the FLEXCUBE status update. The code implements the broader model above. Do not invest in changing or extending the submission path until this is decided in writing.

## 2. Hard rules (never break)
1. **Do not invent** FLEXCUBE or REIS requirements. Separate CONFIRMED / PROVISIONAL / TBD. Anything TBD stays behind an interface/config.
2. **The code is FROZEN.** Do not modify application code, tests or migrations unless the user explicitly asks. Documentation edits are allowed. Wait for written external decisions before implementing them.
3. **No secrets** in code, docs, logs or tests. UAT credentials and a token exist in plain text in the user's own files (Postman JSON, `results.txt`); never copy them anywhere. Recommend rotating them.
4. **TLS validation is always on.** Never add `rejectUnauthorized:false`, `strictSSL:false`, `NODE_TLS_REJECT_UNAUTHORIZED` (a test scans the source for these). Postman's `strictSSL:false` is not to be copied.
5. **No automatic retries**, no scheduler, no public admin endpoints, no automatic reconciliation. Retry/resubmission policy is an open decision.
6. **Never persist or log** tokens, passwords, full payloads or customer values. `instruction`/`errorMessage` from REIS are stored on the case but **never logged** and never put into exception messages.
7. Never guess meanings of reference codes (e.g. Corporate Account Purpose **203 / 204 / 210**). Unmapped values must be rejected.
8. Report outcomes honestly; "complete" is not claimed while any FLEXCUBE contract or Bank mapping is TBD.

## 3. Stack and commands
Node.js 20+ (runs on 24), **TypeScript 5.9 (do not upgrade to 6)**, **NestJS 11 (CommonJS; do not move to Nest 12/ESM)**, Express, TypeORM 0.3 + `better-sqlite3` (**SQLite is dev/test only**; production DB is TBD), `@nestjs/axios` + axios, class-validator/class-transformer, Jest 30 + ts-jest, ESLint 10 + Prettier.

Project root: `C:\Users\moham\Desktop\New folder` (not a git repository).
```
npm run lint        npm run build        npm test
npm run migration:run   |   npm run migration:revert      (DB path from DB_SQLITE_PATH; synchronize is never used)
```
Last verified state: lint clean, build OK, **28 suites / 572 tests passing** (re-run on 2026-10-15 as the baseline), 4 migrations apply/revert on a fresh SQLite file. Since Step 7 only documentation changed.

Shell notes: Git Bash heredocs with apostrophes sometimes fail to parse; write files with the Write tool. Python is not on PATH in some shells: `C:\Users\moham\AppData\Local\Python\bin\python.exe`.

## 4. Architecture (src/)
- `canonical/` canonical models (`CanonicalKycCustomer` individual/corporate, canonical relations) + typed transformation errors.
- `flexcube/` **provisional** inbound DTO (`FlexcubeCustomerRequest`), `FlexcubeToCanonicalMapper`, swappable `IFlexcubeDateNormalizer` (default strict `YYYY-MM-DD`, NOT a confirmed FLEXCUBE format), `IFlexcubeResidentParser` (default Y/N), `IFlexcubeStatusUpdater` + **`MockFlexcubeStatusUpdater`** (real mechanism TBD).
- `reis/` DTOs (envelope + `items`), `ReisHttpTransport` (axios, isolated), `ReisAuthClient`, `ReisOnboardingClient` (fresh token on **every** onboarding call, no caching, no retry), response parser, typed errors, `CanonicalToReisTransformer`, `country-mapping.ts`, config validation (`REIS_*` env vars validated at startup).
- `mapping/` `IReferenceMappingService` (exact, case-sensitive, active rows only, unmapped -> `UnmappedReferenceValueError`), `SingleSelectionSourceOfIncomeStrategy` (placeholder: 1 selection ok, 2+ rejected).
- `persistence/` repository interfaces + TypeORM implementations (ORM never leaves the module): `kyc_case`, `reference_mapping` (**empty - no business mappings seeded**), `webhook_event` (callback audit). 4 migrations.
- `kyc/` `KycWorkflow` (submit orchestration), failure classifier.
- `webhook/` `POST /customerStatus` controller + `CustomerStatusService`, security strategies, malformed-request audit filter (registered via `configureApp()` in `app.setup.ts`, because only global filters see body-parser errors).
- `operations/` `FlexcubeUpdateRecoveryService` (operator-triggered, no endpoint), `OperationalQueryService` (safe summaries only).
- `health/` `GET /health/live`, `GET /health/ready` (DB + config only; never calls REIS).
- `test/` integration specs + `support/` (fake REIS HTTP server, in-memory mappings, isolated in-memory SQLite that runs the real migrations). Tests use synthetic data only.

## 5. Core flows
**Submit** (`KycWorkflow.submit`): find existing case by `KYC_REF_NO` (duplicate -> typed `DUPLICATE`, no REIS call; only `VALIDATION_FAILED` cases may be reprocessed) -> map to canonical -> transform to REIS envelope (typed failure before any REIS call) -> create case (RECEIVED) -> `SUBMITTED_TO_REIS` -> `onboard()` (authenticate, then POST) -> store result.
Results: `ONBOARDED` (CLEAN -> `REIS_CLEAN`, PENDING -> `REIS_PENDING`, REJECT -> `REIS_REJECTED`; REJECT is never turned into BLOCKED), `DUPLICATE`, or `FAILED`. Failures: validation -> `VALIDATION_FAILED`; auth/HTTP 4xx -> `FAILED_PERMANENT`; auth timeout/5xx -> `FAILED_RETRYABLE`; onboarding timeout/reset/5xx/unreadable 2xx -> `DELIVERY_UNCERTAIN` (never retried). These classifications are **provisional diagnostics, not REIS rules**. `KYC_REF_NO` = REIS `systemId`; `CUSTOMER_NO` is nullable.

**Callback** (`POST /customerStatus`): security strategy -> validate (status only CUSTOMER|BLOCKED; `systemId` string; `customerId` optional) -> audit row -> `applyFinalStatus` by `systemId` (atomic conditional UPDATEs) -> `IFlexcubeStatusUpdater` once -> `flexcube_update_status` (NOT_ATTEMPTED/PENDING/APPLIED/FAILED, separate from `final_status`).
Outcomes / HTTP (all non-200 codes are PROVISIONAL): APPLIED, DUPLICATE, UPDATE_FAILED -> 200 (UPDATE_FAILED=200 is a provisional bank-side choice); INVALID 400; SECURITY_REJECTED 401; UNKNOWN_CASE 404; CONFLICT / INCONSISTENT_STATE / CUSTOMER_ID_MISMATCH / RECONCILIATION_REQUIRED 409. A final status is applied only to a `REIS_PENDING` case; a `DELIVERY_UNCERTAIN` case gets `RECONCILIATION_REQUIRED` (audited, nothing applied).
**Webhook security:** unconfigured = deny-all; `unrestricted-dev` only outside production; any other `WEBHOOK_SECURITY_MODE` stops startup. No real mechanism implemented (REIS supports NONE / BASIC / BEARER / NTLM; Bank has not chosen).

## 6. Confirmed REIS contract (baseline = latest working Postman)
- `POST {base}/xauth/authenticate/` headers `Content-Type`, `x-auth-tenant`; body `user_name`,`password`; response field is **`token`**. Send it as **`x-auth-token`** (never `Authorization`).
- `POST {base}/onboarding/v2/searchOnboardCustomer`. Body: top level `systemName` ("Flexcube"), `systemId`, `formId`, `items`, `relations`; **`entity_type` and all business fields are inside `items`**. Relations are nested in the same request (never separate calls); a relation entry repeats `entity_type` on the entry and inside its `items` (preserve). formId 1 Individual PP, 2 Corporate PM, 3 Individual relation PP, 4 Organization relation PM.
- relationshipId: **formId 3 accepts only 1-7; formId 4 accepts only 6-15**. (REIS pages also tag 7,10,13,14,15 "individual only" - how an individual CEO/MANAGER etc. is sent is unresolved; not enforced, not invented.)
- Onboarding response: `status` CLEAN|PENDING|REJECT, `riskCalculationId`, `reisId` (wire types string/number/null), `instruction`, `errorMessage`. A valid status with an `errorMessage` is a normal result (REJECT is a business decision).
- Types: `m_income`, `fin_info` numbers; `source_income_*` strings; `resident` "1"/"2"; `operation_country` array; dates `YYYY-MM-DD`; `pep` boolean (working Postman) although the spec sample shows `"No"`.
- Callback sample: `{status, systemId, customerId, systemName, ServiceType:"CUSTOMER_STATUS"}`; REIS says rely on `systemId` + `status`.
- REIS replies: retries any non-200 callback, a final retry about 00:00, then manual FLEXCUBE update; timeout of onboarding -> "treat as failed and resend" (idempotency NOT confirmed); REJECT must be reflected in FLEXCUBE; Corporate follows the same envelope as Individual (real Corporate Postman pending reference data); `instruction`/`errorMessage` have no max length and no sensitive data; no request limits.

## 7. FLEXCUBE answers received (2026-10-10)
Resident = `Y`/`N`; one shared country list for all country fields; `KYC_REF_NO` mapped at customer creation (so `CUSTOMER_NO` is not available at first submission); update operation idempotent on FLEXCUBE side; `relation_pep` Y/N checkbox exists (Individual); profession from `STTM_KYC_OTHER_TYPES` (OCCUPATION, Bank supplies data); new LOVs on `STDKYCMN` (Operation Country, Legal Entity, Activity, Distribution Channel, Product); Corporate Source of Income = renamed LOV; Corporate relations source `STTM_KYC_CORP_KEYPERSONS` (`RELATIONSHIP` LOV). **A new text field will hold the Corporate legal name, so the old `BUSINESS_NATURE -> business_name` mapping is SUPERSEDED (code still uses it until approved).** Final contract, authentication and the final-status update mechanism ("based on CODE level") are still undefined.

## 8. Where we are
Steps 1-7 are implemented and verified; the code is **frozen** pending external decisions. The integration is **NOT ready for real UAT**. `docs/uat-readiness.md` tracks **34 blockers: 20 OPEN, 13 PARTIAL, 1 ANSWERED** (only the "one country list" question). Biggest open items: FLEXCUBE inbound contract + authentication; real FLEXCUBE final-status update mechanism and codes (incl. how REJECT/CLEAN are represented); Bank-approved reference mappings (all empty), document-type codes, Corporate Account Purpose 203/204/210, income multi-selection rule, account-manager values; Corporate relations mapping and "individual only" semantics; webhook authentication choice; REIS retry details; whether resending with the same `systemId` is idempotent (conflicts with the current "never retry" `DELIVERY_UNCERTAIN` design); callback HTTP-200 boundary; KYC amendment/version identity (current design: one `KYC_REF_NO` = one case); FLEXCUBE Oracle connectivity; mapping import governance; volume/topology; production DB; UAT network/TLS/credentials; test data.
Requests have been drafted for each party (`docs/outgoing-requests/`).

## 9. Documents (read these first, in this order)
1. `docs/uat-readiness.md` - blocker table and test scenarios.
2. `docs/external-decisions-required.md` - every open decision (sections 0, 0b, 0c, then per party).
3. `docs/confirmed-vs-tbd.md` - the authoritative CONFIRMED / PROVISIONAL / TBD ledger.
4. `docs/post-answers-implementation-plan.md` - ordered plan (gates 0-8, no dates) for AFTER decisions are approved.
5. `docs/workflow.md`, `docs/customer-status-webhook.md`, `docs/reis-transport.md`, `docs/transformation.md`, `docs/persistence.md`, `docs/operations.md` - behaviour details.
6. `docs/flexcube-inbound-contract-draft.md` (DRAFT, not approved), `docs/questions-by-party.md`, `docs/outgoing-requests/`.

## 10. How to work
- Before answering, **verify against the code and docs** (read the relevant files; do not rely on memory). If asked "what is the status", report what is implemented vs mocked vs TBD.
- When the user supplies new answers from FLEXCUBE / REIS / the Bank: record them in the docs (ledger, decisions, blocker table), flag conflicts with current behaviour, list the code impact, and **ask for approval before changing code**.
- When code changes are approved: small steps; keep existing tests green; add tests for every rule; run `npm run lint`, `npm run build`, `npm test`, and the migration CLI on a fresh database; update the docs; then stop and report (what changed, rules, results).
- Distinguish: a question being answered is not the same as a blocker being closed. Answers need an owner, a date and written evidence.
- Do not claim the integration is complete or UAT-ready while any contract or mapping is TBD.
