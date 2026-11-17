> **CIF requirement update — 17 November 2026:** Statements below equating primary REIS `systemId` with `KYC_REF_NO` describe the historical baseline and are superseded. The required customer identity is CIF; its Oracle source, lifecycle, historical identity reconciliation and revision/callback contract are still unverified. The current application holds all new submissions; historical callbacks remain supported. See [CIF preparation and blockers](reis-cif-identity.md).

# External decisions required

Only open decisions that someone outside the development team must make. Code is frozen; nothing here is implemented beyond the "current temporary behavior" column.

**Blocks:** `UAT` = must be resolved before real end-to-end UAT; `PROD` = can wait for UAT but must be resolved before production.

---

## 0. FLEXCUBE team reply received (2026-10-10)

The FLEXCUBE team answered the 18 questions. Their answers are recorded below as stated; nothing was inferred beyond what is flagged as a follow-up. Code is still frozen: the "Code impact" list is for approval later.

| # | Question | FLEXCUBE answer (summary) | Effect | Follow-up still needed |
|---|---|---|---|---|
| 1 | Final request contract | "Will be discussed internally later" | **F1 stays OPEN** | Date after which FLEXCUBE will answer |
| 2 | Authentication | "Will be discussed internally later" | **F2 stays OPEN** | as above |
| 3 | Corporate `business_name` | A **new TEXT field** will be introduced (legal name) | **Changes a mapping previously treated as CONFIRMED**: `BUSINESS_NATURE` -> `business_name` is SUPERSEDED (REIS: `business_name` = legal name) | New field name and table/screen |
| 4 | Corporate `incorp_country` | Field is "Parent Company Country of Incorporation" | **Open semantic conflict:** REIS wants the entity's OWN country of incorporation, not the parent's, but the FLEXCUBE label says "Parent Company" | Confirm this field holds the customer's own country of incorporation; if not, a new field is needed |
| 5 | Corporate relations | Source `STTM_KYC_CORP_KEYPERSONS`, field `RELATIONSHIP` (LOV). Relation codes: Bank to confirm/provide. How relation data enters the request and the delivery date: **not answered** | F3 partly answered | Other key-person columns needed by REIS (names, birth date, nationality, citizenship, business name...), relation code list, request shape, date |
| 6 | Resident values | `Y` or `N` | **Answered.** Current parser (Y/N) matches. Reading used: Y = resident -> "1", N = non-resident -> "2" | Trivial confirmation of that reading |
| 7 | Individual Source of Income | New LOV fields will be maintained | Fields/codes still TBD. **Multi-selection question NOT answered** (B4 stays OPEN) | Field names, codes, one vs many values sent |
| 8 | Corporate Source of Income | Existing label "Main Source of Funds" will be renamed "Corporate Source of Income", as LOV data | Single LOV value; fits the single-value mapping | Field name and codes |
| 9 | Country reference lists | Same list for all country data, "as provided in the Excel" | **Answered by FLEXCUBE** (F6): one list for nationality, residence, incorporation and operation countries. Bank mapping data still needed (B1). Note: "Country of Residence" is mentioned but the current REIS payload has no such field | Whether REIS needs a residence-country field |
| 10 | Account manager fields | Text fields already exist; **FLEXCUBE asks us what value to pass** | **New open decision** (see N1) | Bank/REIS to specify the values |
| 11 | `relation_pep` | Existing Y/N checkbox for Individual customers | Source exists (Individual); Corporate not addressed | Column name |
| 12 | Identification document | "Default data will be 'pass'; if TIN data is available the value to pass is 'code'" | **Ambiguous** (see N2) | Clarify wording; document-number source field not stated |
| 13 | Profession | Source `STTM_KYC_OTHER_TYPES` (OCCUPATION), LOV; Bank to provide the data | Source named; codes = B1 | Bank data |
| 14 | Corporate fields | New LOVs in the `STDKYCMN` screen: Operation Country, Legal Entity, Activity, Distribution Channel, Product | Sources confirmed as LOVs | Is Operation Country multi-select? (REIS needs an array); codes = B1 |
| 15 | NA / Bank data fields | New fields will be added if required | Acceptable | List of fields to add |
| 16 | `KYC_REF_NO` / `CUSTOMER_NO` | `KYC_REF_NO` is mapped **while the customer is created** | `CUSTOMER_NO` is **not** available at initial submission (matches current null handling) | How the link is kept after creation |
| 17 | Final status update mechanism | "Final status update based on CODE level" | **Not a mechanism** (no API/table/procedure named): F4 stays OPEN | What "code level" means; where the status is written |
| 18 | Update failure | Update is idempotent on the FLEXCUBE side: "Yes" | Matches our idempotency key; FLEXCUBE-side retry/recovery not described | Whether FLEXCUBE retries on its own |

### New or changed decisions raised by the reply
- **N1. Account manager values (Bank / REIS):** which `account_manager_login` / `account_manager_email` should FLEXCUBE populate (the branch officer, a fixed integration user, a REIS user such as the one used in the Postman sample)? REIS requires both. *Blocks UAT.*
- **N2. Identification document default (FLEXCUBE + Bank):** does "default 'pass'" mean FLEXCUBE sends the text `pass` when TIN is empty, and the TIN `code` when present? The Bank must then map `pass` (and each code) to the REIS document-type code (the Postman sample uses `PAS`). *Blocks UAT.*
- **N3. Corporate legal name field (FLEXCUBE):** name/location of the new text field. *Blocks UAT for Corporate.*
- **N4. Own country of incorporation (FLEXCUBE):** see row 4. *Blocks UAT for Corporate.*
- **N5. Key-person columns (FLEXCUBE):** the full column list of `STTM_KYC_CORP_KEYPERSONS`. *Blocks UAT for Corporate with related persons.*
- **N6. Operation Country multiplicity (FLEXCUBE):** can several be selected? *Blocks UAT for Corporate.*
- **N7. "Code level" status update (FLEXCUBE):** see row 17. *Blocks UAT.*

### Code impact (nothing changed yet; needs approval)
1. Corporate legal name: today `BUSINESS_NATURE` feeds `business_name`; this must move to the new legal-name field (provisional DTO, mapper, canonical source, tests).
2. Country mapping: FLEXCUBE confirmed one shared list, so the NATIONALITY reuse in `reis/country-mapping.ts` can be re-labelled CONFIRMED (the per-field switch can stay).
3. Resident: no change; the default Y/N parser matches.
4. Identification document: possible default-`pass` handling once N2 is clarified; mapping data from the Bank.
5. Account manager: values to be fixed once N1 is decided.
6. Corporate relations: a relation provider reading `STTM_KYC_CORP_KEYPERSONS` data once the contract and columns are known.

---

## 0b. REIS team reply received (2026-10-10)

REIS answered the technical questions and attached pages of the V1.2 specification (relation forms and the callback authentication modes). Recorded as stated. Code is still frozen: "Code impact" is for approval later.

| # | REIS answer (summary) | Effect | Follow-up still needed |
|---|---|---|---|
| 1 | `/customerStatus`: the bank service must rely on `systemId` and `status`; statuses `CUSTOMER` and `BLOCKED` | Confirms the minimum contract. `customerId`, `systemName`, `ServiceType` are **not** stated as final | Confirm whether the other fields are guaranteed |
| 2 | Callback authentication modes supported by REIS: **NONE** (no authentication), **BASIC** (credentials in plain text in the HTTP request), **BEARER** (access token / API key sent with each request), **NTLM** (hash of the credentials) | **Narrows I1** to these four. mTLS, OAuth and IP allowlist are not listed as REIS modes (an allowlist or gateway would be a network-level control chosen by the Bank). Nothing is implemented; the webhook stays deny-all until a mode is chosen | Bank security chooses; REIS provisions credentials. BASIC is plain text (TLS mandatory); NONE would leave the endpoint open |
| 3 | If the bank endpoint does not return HTTP 200, REIS performs **a final retry at around midnight (00:00)**. If retries are exhausted without FLEXCUBE being updated, a **manual update in FLEXCUBE** is required | **Confirms REIS retries on any non-200** (our 400/401/404/409 included). A 200 stops retries, so `UPDATE_FAILED` -> 200 means REIS will not retry and recovery is on our side (operator-triggered recovery and manual update exist). Our audit rows keep the incoming status for manual updates | Timeout used by REIS, retry interval, maximum attempts, and whether "final retry" means earlier retries also happen |
| 4 | `searchOnboardCustomer` timeout / network interruption: **consider the request failed and send it again (retry logic)**; no lookup/reconciliation mechanism is offered | **Conflicts with current behaviour:** we classify it `DELIVERY_UNCERTAIN` and never retry (duplicate-onboarding risk). Partly answers R4: no REIS-side lookup exists | Is resending the same `systemId` idempotent at REIS (no duplicate onboarding)? What if the original request was processed and a callback follows? Bank decides the resend rule (B5) |
| 5 | Standard HTTP status codes; **a request is unsuccessful if HTTP 200 is not returned**; automatic retries are triggered when no response is received | No per-code policy. Our provisional 4xx = permanent / 5xx = uncertain split is not REIS's. Note: a 200 with an unreadable body is a different case (REIS did answer) | Whether resending after a 4xx/5xx is always safe |
| 6 | `REJECT` is a business decision (onboarding prohibited), not a technical issue, and **should be reflected on FLEXCUBE** | **New requirement.** Today REJECT is only stored (`REIS_REJECTED`); nothing is sent to FLEXCUBE, and the update model only knows CUSTOMER/BLOCKED | See N8: how each REIS outcome is represented in FLEXCUBE |
| 7 | Corporate onboarding follows the same approach as the Individual payload (per the technical specification). A Corporate Postman collection will be shared once the reference data is provided and validated on our side | Corporate envelope **confirmed in principle**; real-request verification still pending (depends on reference data) | Provide reference data (B1) |
| 8 | Corporate relations: specify the associated entity in the `relations` of `searchOnboardCustomer`, as in the specification | Confirms nested relations. The attached pages tag each organization-relation id (see below) | See N11 |
| 9 | `instruction` / `errorMessage`: no maximum length; they **cannot** contain personal or sensitive information; no storage or masking recommendation | **Answers B6 from REIS' side.** Our implementation is stricter (stored, never logged, truncated at 4000 chars); relaxing is the Bank's choice | Bank decides whether to keep the stricter handling; the 4000-char truncation could be raised because REIS defines no maximum |
| 10 | No specific request limits | No constraint | - |

Not answered by REIS: callback timeout, retry interval and attempt count, whether a late callback after a timeout is authoritative, and the final callback schema beyond `systemId` / `status`.

**Specification pages received.** Individual Relation (formId 3, `PP`): relationshipId 1 PARENT, 2 SPOUSE, 3 CHILD, 4 LEGALGUARD, 5 EMERGENCY, 6 COOWNER, 7 AUTHORIZED, "all of these apply to individuals"; required fields match the implementation; `citizenship` is described as **"Residence Country (Country code)"**. Organization Relation (formId 4, `PM`): COOWNER (6), BENEFICIAR (8), SHAREHOLDE (9), PARTNER (11), OWNER (12) = individual or organization; AUTHORIZED (7), MANAGER (10), EXECUTIVE (13), CEO (14), CFO (15) = individual only; required `business_name`, `nationality`; optional `trade_no`. The sample JSON shows `"pep": "No"` (string) while the working Postman uses boolean `false` and returned 200: the boolean is kept; the sample also has stray spaces inside key names.

### New decisions raised by the REIS reply
- **N8. How REIS outcomes reach FLEXCUBE (FLEXCUBE + Bank):** REJECT must be reflected on FLEXCUBE. Also CLEAN, PENDING, CUSTOMER, BLOCKED: what does FLEXCUBE store for each ("code level")? *Blocks UAT.*
- **N9. Onboarding resend rule (Bank, with REIS confirming idempotency):** follow REIS' advice to resend after a timeout/non-200, under what limits and who triggers it? *Blocks UAT for timeout scenarios.*
- **N10. Callback authentication mode (Bank security):** choose among NONE / BASIC / BEARER / NTLM and agree credential handling. *Blocks UAT.*
- **N11. Organization-relation semantics (REIS):** ids 7, 10, 13, 14, 15 are "individual only", yet formId 4 carries `business_name` (an organization party) and formId 3 accepts only ids 1-7. How is an individual who is CEO/MANAGER/EXECUTIVE/CFO/AUTHORIZED of a corporate customer sent? *Blocks UAT for Corporate with related persons.*
- **N12. `citizenship` meaning (FLEXCUBE + REIS):** the relation form describes `citizenship` as Residence Country. Confirm the main form's `citizenship_customer` / `citizenship` wording and which FLEXCUBE field (country of residence?) feeds them. *Blocks UAT.*
- **N13. Manual-update runbook (Bank operations):** after REIS' retries are exhausted, who updates FLEXCUBE manually and how do they find the cases (audit and operational queries exist)? *Blocks PROD.*

### Code impact (nothing changed yet; needs approval)
1. Send REJECT (and whatever else N8 defines) to `IFlexcubeStatusUpdater`; extend the update model, FLEXCUBE-update tracking and recovery beyond CUSTOMER/BLOCKED.
2. Revisit `DELIVERY_UNCERTAIN` and the resubmission rule per N9 (today: never retried, repeat submission returns DUPLICATE).
3. Implement the webhook security strategy once N10 is decided.
4. Review which `/customerStatus` outcomes return non-200, knowing REIS retries any non-200 (UNKNOWN_CASE 404, CONFLICT / INCONSISTENT_STATE / RECONCILIATION_REQUIRED / CUSTOMER_ID_MISMATCH 409 would be retried once more at about midnight).
5. Relationship-id rules after N11; possibly the source of `citizenship` after N12.
6. `instruction` / `errorMessage` truncation limit (optional).

---

## 1. FLEXCUBE team

### F1. Final FLEXCUBE -> Integration API request contract  *(OPEN: FLEXCUBE will discuss internally)*
- **Question:** What exactly will FLEXCUBE send: URL, HTTP method (push per KYC, batch?), JSON field names, and value formats (dates, numbers, Y/N, Resident, country codes)? Which fields marked NA in the workbook are truly mandatory?
- **Why needed:** Every FLEXCUBE field name and format beyond the few confirmed ones is a placeholder.
- **Current temporary behavior:** Provisional DTO (`FlexcubeCustomerRequest`). Dates are normalized by a swappable normalizer that accepts only strict `YYYY-MM-DD`; numbers accept numeric strings and reject blanks; Resident accepts only `Y`/`N`. The draft in `docs/flexcube-inbound-contract-draft.md` is not approved. No production inbound endpoint exists.
- **Component affected:** FLEXCUBE inbound DTO, FLEXCUBE-to-canonical mapper, date normalizer, resident parser.
- **Blocks:** UAT.

### F2. FLEXCUBE -> Integration API authentication  *(OPEN: FLEXCUBE will discuss internally)*
- **Question:** How does FLEXCUBE authenticate to the bank API (API key, mTLS, OAuth, gateway, network allowlist)?
- **Why needed:** The inbound endpoint cannot be exposed without it.
- **Current temporary behavior:** None; no inbound endpoint exists, nothing is assumed.
- **Component affected:** Future FLEXCUBE inbound controller.
- **Blocks:** UAT.

### F3. Corporate relations source mapping  *(PARTLY ANSWERED - see section 0)*
- **Question:** Where do Corporate related persons come from in FLEXCUBE, with which fields, and how do FLEXCUBE relation codes map to REIS `relationshipId`? (REIS side is already confirmed: formId 4 accepts ids 6-15.)
- **Why needed:** Corporate onboarding needs the `relations` array populated.
- **Current behavior:** corporate key persons are read from `STTM_KYC_CORP_KEYPERSONS` (+ `_CUSTOM`) and sent in `relations` of the same call (see `docs/flexcube-sync.md`); individual customers send `relations: []`. Column names still need UAT1 verification.
- **Component affected:** Relation provider, FLEXCUBE-to-canonical mapping, transformer.
- **Blocks:** UAT for Corporate customers with related persons; otherwise PROD.

### F4. Real FLEXCUBE final-status update mechanism  *(OPEN: reply "based on CODE level" names no mechanism)*
- **Question:** How is the REIS result (CUSTOMER/BLOCKED) written back to FLEXCUBE (API, procedure, interface table, other), with what identifiers (`KYC_REF_NO`, later `CUSTOMER_NO`), and is the call idempotent? Is `CUSTOMER_NO` ever present at submission?
- **Why needed:** Without it the REIS decision never reaches FLEXCUBE.
- **Current temporary behavior:** `MockFlexcubeStatusUpdater` only. Failures are recorded (`flexcube_update_status = FAILED`) and can be recovered by an operator-triggered application service; no automatic retry, no admin endpoint.
- **Component affected:** `IFlexcubeStatusUpdater`, recovery service.
- **Blocks:** UAT.

### F5. Resident and Income-Source source fields  *(Resident ANSWERED: Y/N; income-source fields still open - see section 0)*
- **Question:** Which values does FLEXCUBE's Resident field carry, and what are the exact column names of the income-source checkboxes (Salary, Rental, Investment, Business, other)?
- **Why needed:** REIS needs `resident` "1"/"2" and `source_income_individual`.
- **Current temporary behavior:** Resident parser accepts only `Y`/`N`; income flags are an assumed name-to-Y/N map.
- **Component affected:** Resident parser, FLEXCUBE-to-canonical mapper.
- **Blocks:** UAT.

### F6. Reference lists for country fields  *(ANSWERED by FLEXCUBE 2026-10-10: one shared list - see section 0)*
- **Question:** Are nationality, citizenship, country of incorporation and operation countries all drawn from one FLEXCUBE list?
- **Why needed:** REIS requires country codes for all five fields; the docs do not say FLEXCUBE uses one list.
- **Current temporary behavior:** All use the `NATIONALITY` mapping (PROVISIONAL), isolated in one config so it can be split without data duplication.
- **Component affected:** Country mapping, reference mapping data.
- **Blocks:** UAT.

---

## 2. Bank / Compliance / Business

### B1. Bank-approved reference mappings
- **Question:** Provide the approved FLEXCUBE value -> REIS value tables for nationality/country, profession, product (from `PRODUCT_CODE`), account purpose (individual and corporate), legal entity, activity, distribution channel, source of income. (Workbook RED items must be supplied, GREEN items verified.)
- **Why needed:** Any unmapped value is rejected before REIS is called.
- **Current temporary behavior:** Mapping table is empty; nothing seeded or guessed. Every submission fails validation until data is loaded.
- **Component affected:** `reference_mapping` table, reference mapping service, transformer.
- **Blocks:** UAT.

### B2. Document Type code list
- **Question:** Which REIS document-type codes are approved for `tin`, and how do FLEXCUBE's free-text values map to them?
- **Why needed:** REIS `tin` is an ID document type code; FLEXCUBE's field is unvalidated free text.
- **Current temporary behavior:** Value must resolve through the `DOCUMENT_TYPE` mapping (empty), otherwise rejected; never sent raw.
- **Component affected:** `DOCUMENT_TYPE` mapping, transformer.
- **Blocks:** UAT (for customers that carry a document type).

### B3. Corporate Account Purpose 203 / 204 / 210
- **Question:** What do values 203 and 204 mean, and what are their REIS equivalents (or are they invalid)?
- **Why needed:** The meaning must be verified by the Bank, not inferred.
- **Current temporary behavior:** No mapping exists; both are rejected as unmapped.
- **Component affected:** `ACCOUNT_PURPOSE_CORPORATE` mapping.
- **Blocks:** UAT (Corporate customers using these values).

### B4. Source-of-Income multi-selection rule
- **Question:** When several income checkboxes are ticked, what single REIS `source_income_individual` value is sent (priority order, a "multiple" code, other)?
- **Why needed:** REIS accepts one string; FLEXCUBE allows several.
- **Current temporary behavior:** Exactly one ticked flag is mapped; two or more are rejected with a typed "rule not configured" error; none is rejected as missing. No selection is guessed.
- **Component affected:** `ISourceOfIncomeStrategy` (placeholder implementation).
- **Blocks:** UAT.

### B5. Retry / resubmission business rule  *(REIS advice received: resend after timeout / non-200 - see section 0b)*
- **Question:** After a failed or uncertain onboarding, may the same `KYC_REF_NO` be resubmitted, by whom, and when?
- **Why needed:** Blind resubmission could create duplicate onboarding at REIS.
- **Current temporary behavior:** No automatic retry. A repeated `KYC_REF_NO` returns `DUPLICATE` without calling REIS, except after a validation failure (REIS never contacted). Failed/uncertain cases stay as they are.
- **Component affected:** KYC workflow, failure classification.
- **Blocks:** PROD (UAT can proceed with manual handling).

### B6. Storage of REIS `instruction` / `errorMessage`  *(REIS: not sensitive, no max length, no storage/masking advice - see section 0b)*
- **Question:** Confirm retention, access and masking rules for these REIS texts, which may be sensitive.
- **Why needed:** They are stored by requirement.
- **Current temporary behavior:** Stored on the case; never logged, never in exception messages, excluded from operational summaries.
- **Component affected:** `kyc_case` columns, logging, operational queries.
- **Blocks:** PROD.

---

## 3. REIS team

### R1. Callback retry, timeout and non-200 behavior  *(PARTLY ANSWERED: retries on non-200, final retry ~00:00; timeout/interval/max not given)*
- **Question:** Does REIS retry `/customerStatus` callbacks, with what schedule and timeout, and which non-200 status codes trigger a retry?
- **Why needed:** Our non-200 responses may or may not cause repeated callbacks.
- **Current temporary behavior:** 200 for APPLIED/DUPLICATE and for UPDATE_FAILED (provisional bank-side choice); 400 invalid, 401 unauthorized, 404 unknown systemId, 409 conflict/inconsistent/mismatch/reconciliation-required. All non-200 codes are provisional. Handling is idempotent regardless.
- **Component affected:** `/customerStatus` controller.
- **Blocks:** UAT (to interpret results); retry-sensitive behavior PROD.

### R2. Final callback schema
- **Question:** Approve the payload (`status`, `systemId`, optional `customerId`, `systemName`, `ServiceType`), types (is `systemId` always a string?), and whether an event id exists.
- **Why needed:** Only a sample is available.
- **Current temporary behavior:** Validates against the sample; `customerId` optional; `ServiceType` checked only when present; unknown fields ignored; an internal event id is generated.
- **Component affected:** Callback DTO and validation.
- **Blocks:** UAT.

### R3. Onboarding error, status and timeout semantics  *(PARTLY ANSWERED: non-200 = unsuccessful, resend; REJECT = business decision to reflect on FLEXCUBE)*
- **Question:** Provide the final error-code/HTTP-status policy for `authenticate` and `searchOnboardCustomer`, onboarding timeout values, and whether REJECT/`errorMessage` ever represents an application error rather than a business outcome.
- **Why needed:** Our failure classes are our own diagnostics.
- **Current temporary behavior:** 4xx = permanent, 5xx / timeout / unreadable 2xx = `DELIVERY_UNCERTAIN`, auth failures separate (all provisional, never retried). REJECT with `errorMessage` is a normal result.
- **Component affected:** REIS clients, failure classifier.
- **Blocks:** PROD (UAT can proceed).

### R4. DELIVERY_UNCERTAIN reconciliation rule (REIS + Bank)  *(PARTLY ANSWERED: REIS says treat as failed and resend; no lookup; late-callback and idempotency questions open)*
- **Question:** If an onboarding times out and REIS later sends CUSTOMER/BLOCKED, may that callback reconcile the case automatically (under which checks), or must an operator approve? Can REIS be queried for the true status?
- **Why needed:** Such a case is otherwise stuck.
- **Current temporary behavior:** Callback returns `RECONCILIATION_REQUIRED` (409, audited with the incoming status); nothing is applied, FLEXCUBE is not called, onboarding is not retried.
- **Component affected:** Final-status handling, operations.
- **Blocks:** PROD (UAT blocked only for timeout scenarios).

### R5. Corporate wire shape and relationship semantics  *(Corporate envelope confirmed in principle; relationship semantics: see N11)*
- **Question:** Confirm the Corporate request shape (formId 2 envelope, corporate relation entry), and whether some organization relationship types (AUTHORIZED, MANAGER, EXECUTIVE, CEO, CFO) are valid only for individual related parties.
- **Why needed:** Corporate shape is derived, not tested; the "individual only" wording is ambiguous.
- **Current temporary behavior:** Corporate serialized from V1.2 plus the Individual example. formId 3 accepts ids 1-7, formId 4 accepts ids 6-15; no further compatibility rule is enforced.
- **Component affected:** Transformer, relation DTOs.
- **Blocks:** UAT (Corporate).

---

## 4. Infrastructure / Security

### I1. Webhook (REIS -> bank) authentication  *(narrowed: REIS supports NONE / BASIC / BEARER / NTLM - see section 0b)*
- **Question:** Which mechanism protects `/customerStatus` (mTLS, API key, OAuth, IP allowlist, API gateway) and who provisions credentials/certificates?
- **Why needed:** The endpoint is otherwise closed.
- **Current temporary behavior:** No mechanism implemented. Unconfigured = deny-all (every callback gets 401); `unrestricted-dev` exists for dev/test only and is refused in production; any other mode stops startup.
- **Component affected:** `IWebhookSecurityStrategy`, webhook module.
- **Blocks:** UAT.

### I2. Production database
- **Question:** Which database engine, hosting, backup, retention, and who owns schema migrations? (Oracle is a possibility, not a decision.)
- **Why needed:** SQLite is dev/test only; the migrations are SQLite-specific and transaction/concurrency design must be reviewed for the chosen engine.
- **Current temporary behavior:** TypeORM behind repository interfaces; any other `DB_TYPE`, or SQLite in production, fails at startup. Concurrency relies on atomic conditional updates.
- **Component affected:** Persistence module, migrations, final-status handling.
- **Blocks:** PROD.

### I3. UAT network, TLS, firewall and DNS
- **Question:** REIS UAT base URL and tenant, DNS names, firewall/proxy rules in both directions (bank -> REIS and REIS -> bank callback route), trusted CA certificates for the host, and credential delivery through the secret store.
- **Why needed:** Certificate validation is always on; nothing may be disabled to "make it work".
- **Current temporary behavior:** All REIS settings come from environment variables and are validated at startup; https required in production; redirects not followed. Tested only against a local fake REIS server.
- **Component affected:** REIS clients, configuration, deployment.
- **Blocks:** UAT.

### I4. Deployment and runtime
- **Question:** Hosting model, process management, secret store, log collection/retention, and wiring of `/health/live` and `/health/ready` to monitoring.
- **Why needed:** None is decided.
- **Current temporary behavior:** Plain Node/NestJS application; structured logs without payloads or secrets; health endpoints available.
- **Component affected:** Deployment, observability.
- **Blocks:** PROD.

---

## 5. Joint (FLEXCUBE team + Bank + REIS)

### J1. UAT test customers and scenarios
- **Question:** Provide UAT customers/CIFs with unique `KYC_REF_NO` values and agree the scenarios and expected REIS outcomes: CLEAN, PENDING -> CUSTOMER, PENDING -> BLOCKED, REJECT, duplicate submission, duplicate and conflicting callbacks, unknown systemId, authentication failure, timeout/uncertain delivery, FLEXCUBE update failure and recovery, Corporate with relations.
- **Why needed:** REIS and FLEXCUBE must be able to produce each outcome on demand.
- **Current temporary behavior:** All scenarios are tested only with a fake REIS server, mock FLEXCUBE updater and synthetic data (checklist in `docs/uat-readiness.md`).
- **Component affected:** End-to-end flow.
- **Blocks:** UAT.

---

## 0c. Additions and amendments (added after the review of the remaining questions)

Append the decisions below to the existing register. These are
**external decisions only**; no code change is approved by this
addendum. Keep existing answers and open items unchanged unless an
explicit amendment below says otherwise.

### Amend existing entries

-   **B3 - Corporate Account Purpose:** change the heading/question
    from `203 / 204` to **`203 / 204 / 210`**. FLEXCUBE must provide the
    source LOV code and exact description; Bank Business/Compliance must
    approve the meaning and REIS mapping. Do not infer meanings from
    numeric codes.
-   **FLEXCUBE identifiers / B5 / R4:** explicitly ask whether an
    amended or rescreened KYC record receives a new `KYC_REF_NO` per
    version or reuses the old reference. If reused, require a version
    identifier and a rule distinguishing resubmission from a duplicate.
-   **R1:** add the time zone for REIS's approximately-midnight retry
    and the precise callback timeout, retry interval, attempt count, and
    success handling for 2xx responses.
-   **R9:** add the expected handling when `searchOnboardCustomer`
    returns HTTP 401: whether to authenticate again and retry the same
    request once, and whether that retry is safe.
-   **FLEXCUBE final-status update / I2 / I3:** explicitly cover the
    possibility of an Oracle interface/staging table. If selected,
    obtain the approved connectivity model, host/port/service,
    schema/table, service account and privileges, network route,
    transaction/commit acknowledgement, and support owner.
-   **B1:** add the mapping-data import/release process: source extract,
    CSV/Excel or other approved format, data validation,
    reviewer/approver, audit/version history, environment promotion and
    rollback.
-   **I4 / J1:** capture expected daily volume, peak requests per
    second/minute, concurrency, number of running instances, load-test
    target and sign-off.
-   **R payload details:** explicitly confirm whether `product` is a
    single string/code or an array for both Individual and Corporate
    payloads.
-   **Scope:** record an explicit Bank Compliance decision that this
    project is KYC integration only; AML/TFS screening and decisioning
    are excluded unless separately approved as a distinct scope.

### N14. KYC amendment/version identity (FLEXCUBE + Bank Business) - **Blocks UAT**

-   **Question:** For an existing customer's corrected or amended KYC
    data that must be screened again, does FLEXCUBE issue a new
    `KYC_REF_NO` for each version, or reuse the previous value? If
    reused, what is the version identifier and how does the integration
    distinguish a legitimate rescreen from a duplicate?
-   **Why needed:** The current idempotency design treats one
    `KYC_REF_NO` as one case and returns `DUPLICATE` without calling
    REIS on reuse. Reusing the reference for amendments would require a
    different idempotency key and case model.
-   **Owners:** FLEXCUBE provides the source behaviour; Bank
    Business/Compliance approves the rescreening rule.
-   **Current state:** Code frozen; no versioning behaviour is approved.

### N15. Callback HTTP 200 acknowledgement boundary (Bank Integration owner + FLEXCUBE + REIS) - **Blocks UAT**

-   **Question:** Does HTTP 200 mean that the callback has been durably
    recorded by the integration, or that the resulting status has been
    successfully committed to FLEXCUBE? REIS has stated that non-200
    responses trigger retries and 200 is treated as success. Which
    acknowledgement boundary is approved?
-   **Why needed:** Current temporary behaviour can return 200 after
    recording the REIS decision even when the FLEXCUBE update fails. If
    200 is returned before the FLEXCUBE update succeeds, the Bank must
    own durable retry/recovery; if 200 is withheld until the update
    commits, the retry and exhausted-attempt procedure must be agreed.
-   **Owners:** Bank Integration/Architecture proposes the delivery
    guarantee; FLEXCUBE confirms update acknowledgement; REIS confirms
    callback delivery semantics.
-   **Current state:** Existing behaviour is temporary and must not be
    treated as approved.

### N16. FLEXCUBE status-update transport and Oracle connectivity (FLEXCUBE + Infrastructure/DBA) - **Blocks UAT**

-   **Question:** Is final status written through an API, stored
    procedure, or Oracle interface/staging table? If a database
    interface is chosen, provide the host/port/service, schema/table,
    service account, privileges, network/firewall route,
    transaction/commit semantics, acknowledgement and failure behaviour.
-   **Why needed:** The current implementation uses a mock updater and
    has no FLEXCUBE Oracle connection or staging-table integration.
-   **Owners:** FLEXCUBE defines the supported interface;
    Infrastructure/DBA provisions approved connectivity and
    least-privilege access.
-   **Current state:** Mechanism and connectivity are not implemented or
    confirmed.

### N17. Mapping-data import and governance (Bank Business/Compliance + IT) - **Blocks UAT**

-   **Question:** Who prepares and approves the reference mappings, what
    source extract and import format are used, who loads them, what
    validation/audit/versioning is required, and how are approved
    mappings promoted and rolled back across development, UAT and
    production?
-   **Why needed:** The current mapping table and lookup service exist,
    but there is no agreed data-loading/import workflow or approval
    trail.
-   **Owners:** Business/Compliance approves meanings and mappings; IT
    owns the controlled loading and environment-promotion process.
-   **Current state:** Mapping data remain unseeded/unapproved; no
    import mechanism is assumed.

### N18. Expected volume, concurrency and runtime topology (Bank IT/Infrastructure + Business) - **UAT sizing / PROD capacity**

-   **Question:** What are the expected daily submissions, peak requests
    per second/minute, concurrency, corporate related-person volume,
    response-time target and number of running instances? What load test
    is required before sign-off?
-   **Why needed:** Concurrency controls and final-status processing
    must be reviewed against the actual workload and deployment
    topology.
-   **Owners:** Business supplies volume estimates; IT/Infrastructure
    approves topology and performance criteria.
-   **Current state:** Volume and instance count are unknown; production
    sizing is not approved.

### N19. REIS retry time zone and release/rollback plan (REIS + Bank IT/Operations) - **Time zone: UAT; go-live/rollback: PROD**

-   **Question:** Which named time zone defines REIS's
    approximately-midnight final callback retry, including
    daylight-saving behaviour if applicable? What are the approved
    production go-live window, rollback triggers, rollback owner and
    post-rollback verification steps?
-   **Why needed:** Operational schedules and retry expectations cannot
    rely on an unspecified local time, and production deployment needs a
    tested recovery path.
-   **Owners:** REIS confirms its retry time zone; Bank IT/Operations
    owns release and rollback governance.
-   **Current state:** Time zone, go-live date and rollback plan are not
    confirmed.

### N20. Corporate Account Purpose code 210 (FLEXCUBE + Bank Business/Compliance) - **Blocks UAT where used**

-   **Question:** What is the exact FLEXCUBE source LOV description and
    source table/column for `210`, and is it a valid Corporate Account
    Purpose value? If valid, what is its approved REIS mapping?
-   **Why needed:** The source description has not been provided and
    must not be guessed from the numeric code.
-   **Owners:** FLEXCUBE extracts the actual code/description; Bank
    Business/Compliance approves its meaning and mapping.
-   **Current state:** Unmapped; no meaning or REIS value is assumed.

### N21. Product field cardinality (REIS + FLEXCUBE) - **Blocks UAT**

-   **Question:** Is `product` a single string/code or an array in the
    final Individual and Corporate request schemas? Provide a working
    example for each.
-   **Why needed:** The transformer must serialize the exact approved
    contract; a guessed cardinality can produce invalid requests.
-   **Owners:** REIS confirms the accepted payload; FLEXCUBE confirms
    the source field cardinality.
-   **Current state:** Not confirmed; code frozen.

### N22. Token HTTP 401 handling (REIS + Bank Integration owner) - **Blocks UAT**

-   **Question:** If `searchOnboardCustomer` returns HTTP 401, should
    the integration obtain a fresh token and retry the same request
    once? Is this safe after an uncertain response, and what should
    happen after a second 401?
-   **Why needed:** Token lifetime alone does not define a safe request
    retry policy.
-   **Owners:** REIS confirms authentication semantics; Bank Integration
    owner approves retry limits and audit behaviour.
-   **Current state:** No new 401 retry is approved or implemented.

### N23. KYC-only scope boundary (Bank Compliance) - **Must be recorded before scope sign-off**

-   **Question:** Confirm in writing that the current integration scope
    is KYC screening and that AML/TFS screening and decisioning are
    excluded unless separately approved through a distinct scope/change
    request.
-   **Why needed:** Prevents KYC outcomes from being interpreted as
    approval that AML/TFS controls were performed.
-   **Owner:** Bank Compliance / project sponsor.
-   **Current state:** Treat as an explicit scope decision to record,
    not as an implemented feature.

---

## 0d. Architecture finding from the FLEXCUBE Approach Document (found 2026-10-15)

Source: `AIIB_FCUBS_REIS-KYC_Integration_Approach_v1.0` (author Abhilash V, dated 23-Sep-2026, FCUBS 14.7.0.8.0). It describes a **different division of responsibilities from the one this project assumes**:

- On Save of `STDKYCMN`, FCUBS stores the KYC record in a **new custom staging table**; a **custom FCUBS scheduler job** picks up unprocessed records, populates the REIS fields and **submits the JSON itself to REIS `searchOnboardCustomer`**, obtaining an `authenticate` token for every request. The REIS response (`riskCalculationId`, `reisId`, `status`, instruction/error) is written back to the FCUBS custom table.
- `customerStatus` is listed as exposed by the "third-party application (FCUBS)". The note under the estimates says the **new API for PENDING KYC status is not included in FLEXCUBE's scope: "Bank team will perform same"**, and the FLEXCUBE team will provide **technical table details** saying which values must be updated for the final REIS status. (This is probably what "based on CODE level" meant.)
- Authorization in FCUBS: CLEAN / CUSTOMER allow it; **REJECT / BLOCKED make authorization impossible** (this partly answers how REJECT is reflected in FLEXCUBE). FLEXCUBE's estimates also include audit logs of requests/responses, a Force Release mechanism (table level) and KYC Amendment Screening.

### N24. Who calls REIS: FLEXCUBE directly, or the Bank Integration API? (Bank architecture owner + FLEXCUBE + REIS) - **Blocks UAT; decide in writing before further code investment**
- **Question:** Does FLEXCUBE's scheduler call REIS directly (as the Approach Document says), leaving the Bank with only the `/customerStatus` webhook and the FLEXCUBE status update, or will FLEXCUBE send KYC records to the Bank Integration API, which then calls REIS (the model this project implements and that Abhilash's later replies imply by promising an "inbound contract")? Is the Approach Document superseded?
- **Why needed:** If FLEXCUBE calls REIS, the submission path built here (FLEXCUBE inbound DTO, mapper, canonical-to-REIS transformer, reference mapping, REIS auth and onboarding clients, submit workflow, duplicate/idempotency by `KYC_REF_NO`) would not be used by the bank flow, and the mapping would be done in FCUBS. The webhook, final-status handling, FLEXCUBE update (writing the values FLEXCUBE specifies into the FCUBS custom table, i.e. Oracle connectivity, N16) and operations code would remain the Bank's part.
- **Current state:** The code implements the full model (FLEXCUBE -> API -> REIS plus webhook) and is frozen. Nothing is removed; any change waits for a written decision.
- **Related evidence:** Abhilash's later replies ("final contract will be discussed internally", "final status update based on CODE level") are consistent with either model, so the question must be answered explicitly.

### Other facts recorded from the same review
- The mapping workbook V1 names the source of REIS `business_name` as **`STTM_KYC_CORPORATE_CUSTOM - CRP_BUSINESS_NAME`** (a candidate source, PROVISIONAL until FLEXCUBE confirms the field); it is not `BUSINESS_NATURE`.
- The workbook describes the default `systemName` as "FLEXCUBE or FCUBS" (and "FCUBS" in another place) while the working Postman uses `Flexcube`. Which value REIS expects is open; the application keeps it configurable (`REIS_SYSTEM_NAME`, default `Flexcube`).
- The workbook describes `m_income` as the customer's total monthly income in local currency; the FLEXCUBE field is reportedly free text, so a numeric validation or an approved conversion rule is needed.
- Dates in these notes are the dates the replies were recorded by the project assistant; the actual send dates of the REIS and FLEXCUBE emails (for example the REIS reply may be 06-Oct) should be confirmed from the emails and the evidence log corrected.
