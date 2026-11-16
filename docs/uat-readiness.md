# UAT readiness checklist

Status: **NOT READY for real end-to-end UAT.** Everything below marked open blocks it. The integration is not complete while any FLEXCUBE contract or Bank reference mapping is TBD. All current tests use fake REIS/FLEXCUBE stand-ins and synthetic data.

## Blockers
Legend: **OPEN** = not answered; **PARTIAL** = an answer exists but details remain; **ANSWERED** = the specific question is settled, even if other data is still required. Review of 2026-10-10 (based on the replies from the FLEXCUBE and REIS teams).

| # | Blocker | Owner | Status | What is confirmed / what is missing |
|---|---|---|---|---|
| 1 | Final FLEXCUBE -> Integration API inbound URL, method and request contract (`docs/flexcube-inbound-contract-draft.md` is a draft only) | FLEXCUBE team | **OPEN** | FLEXCUBE said this will be discussed internally later. |
| 2 | FLEXCUBE -> Integration API authentication | FLEXCUBE team / Bank security | **OPEN** | Authentication method not yet defined. |
| 3 | Final Bank-approved reference mappings (nationality/country, profession, product, account purpose individual and corporate incl. 203/204/210, legal entity, activity, channel, source of income, document type codes); the mapping tables are empty | Bank | **OPEN** | The Bank must approve and provide the LOV / reference mapping data (the step FLEXCUBE explicitly asked for). |
| 4 | Mandatory FLEXCUBE fields still marked NA in the workbook; income-source columns; RESIDENT values; Source-of-Income rule for several ticked flags | FLEXCUBE team / Bank | **PARTIAL** | Resident = Y/N confirmed; new LOV fields are being prepared. Income-source field names and the multiple-selection rule are still open. |
| 5 | Corporate related-person FLEXCUBE mapping (REIS relation contract is already confirmed) | FLEXCUBE team | **PARTIAL** | Source known: `STTM_KYC_CORP_KEYPERSONS` -> `RELATIONSHIP` LOV. Codes come from the Bank; detailed columns and the final request shape are still needed. |
| 6 | Whether one FLEXCUBE list may serve all country fields (currently PROVISIONAL) | Bank / FLEXCUBE team | **ANSWERED** | FLEXCUBE confirmed one shared list for all country fields (as in the Excel). Bank mapping data and its approval are still required (#3). |
| 7 | REIS -> bank `/customerStatus` security mechanism (none is implemented; production default is deny-all) | Bank security / REIS | **PARTIAL** | REIS supports NONE, BASIC, BEARER, NTLM. The Bank has not chosen the final mode. |
| 8 | REIS retry / timeout / error-code policy, including which non-200 codes trigger callback retries and the final retry/resubmission rule for onboarding | REIS / Bank | **PARTIAL** | REIS explained callback and onboarding retry behaviour (any non-200 is retried, final retry about 00:00). Timeouts, attempt counts and exact details are still missing. |
| 9 | Real FLEXCUBE final-status update mechanism (only a mock exists) | FLEXCUBE team | **PARTIAL** | "Based on CODE level" does not say whether the update is an API, a table or another mechanism. |
| 10 | Bank/REIS decision on reconciling a `DELIVERY_UNCERTAIN` case when a final callback arrives | Bank / REIS | **PARTIAL** | REIS: treat as failed and resend. Safety of resending the same systemId and handling of a late callback are not confirmed. |
| 11 | Corporate onboarding wire shape verified against a real REIS request (derived today) and `relationshipId` / individual-only semantics confirmed | REIS | **PARTIAL** | REIS confirmed Corporate follows the same approach as Individual. The final Postman waits for reference-data approval; some relation semantics are unresolved (#22). |
| 12 | Production database choice, migrations for it, and production transaction/concurrency review (SQLite is dev/test only) | Bank infrastructure | **OPEN** | Production database, migrations and operational review not decided. |
| 13 | UAT network: REIS UAT base URL, tenant, DNS, firewall, TLS certificates trusted by the Integration API host, callback route from REIS to the bank | Network / REIS | **OPEN** | Network, DNS, firewall, TLS and callback route not confirmed. |
| 14 | UAT credentials delivered through the secret store (never in source control) | Bank / REIS | **OPEN** | Final credentials through a secret store not provided/confirmed. |
| 15 | UAT customer data: test CIF / customers and unique `KYC_REF_NO` values in FLEXCUBE UAT | FLEXCUBE team | **OPEN** | Test customers and unique `KYC_REF_NO` values needed from FLEXCUBE UAT. |
| 16 | Deployment/runtime decision (hosting, process manager, health probes wiring to `/health/live` and `/health/ready`) | Bank infrastructure | **OPEN** | Hosting, service operation and health-check wiring not decided. |
| 17 | Account manager login/email: which values FLEXCUBE should pass (FLEXCUBE asked) | Bank / REIS | **PARTIAL** | FLEXCUBE has the text fields but asked the Bank which values to send. |
| 18 | Identification document default (`pass`) vs TIN `code` wording, and Bank mapping to REIS document-type codes | FLEXCUBE team / Bank | **PARTIAL** | The reply does not define a clear enough rule linking `tin`, `nid` and the passport code; needs final clarification. |
| 19 | Corporate: new legal-name field (replaces BUSINESS_NATURE as `business_name`), own-country-of-incorporation semantics, Operation Country multiplicity | FLEXCUBE team | **PARTIAL** | New legal-name field and new LOVs were named. The correct source for country of incorporation and whether Operation Country is multi-valued are not settled. |
| 20 | REJECT must be reflected on FLEXCUBE (REIS): define how REIS outcomes (CLEAN, PENDING, REJECT, CUSTOMER, BLOCKED) are represented in FLEXCUBE; code does not send REJECT yet | FLEXCUBE team / Bank | **PARTIAL** | REIS confirmed REJECT is a business decision that must be reflected in FLEXCUBE. The update method and the required status/code are not defined. |
| 21 | Bank rule for resending an onboarding after timeout/non-200 (REIS advises resend) and REIS confirmation that a resend with the same systemId is idempotent | Bank / REIS | **PARTIAL** | REIS advised resending; idempotency when the same systemId is resent is not confirmed. |
| 22 | Organization-relation semantics: how an individual CEO/MANAGER/EXECUTIVE/CFO/AUTHORIZED of a corporate customer is sent (formId 3 allows 1-7, formId 4 carries business_name) | REIS | **OPEN** | Need clarity on how CEO / MANAGER / EXECUTIVE / CFO / AUTHORIZED are sent without conflicting with the form constraints. |
| 23 | Meaning of REIS `citizenship` ("Residence Country") and the FLEXCUBE field feeding it | FLEXCUBE team / REIS | **OPEN** | Not settled whether `citizenship` means Residence Country, nor which FLEXCUBE field feeds it. |
| 24 | Manual FLEXCUBE update runbook for callbacks REIS cannot deliver after its retries | Bank operations | **PARTIAL** | REIS said a manual update is required after retries are exhausted. Bank procedure, responsibilities and documentation are not defined. |
| 25 | KYC amendment/version identity: new `KYC_REF_NO` per amended version, or a version key if references are reused (N14) | FLEXCUBE team / Bank Business | **OPEN** | The current design treats one `KYC_REF_NO` as one case; reuse would need a different idempotency key and case model. |
| 26 | Callback HTTP 200 acknowledgement boundary: durable record vs successful FLEXCUBE update (N15) | Bank Integration owner / FLEXCUBE / REIS | **OPEN** | Current behaviour (200 after recording the REIS decision even if the FLEXCUBE update fails) is temporary, not approved. |
| 27 | FLEXCUBE status-update transport and Oracle connectivity, if an interface/staging table is chosen (N16) | FLEXCUBE team / Infrastructure-DBA | **OPEN** | Only a mock updater exists; no Oracle connection is implemented or confirmed. |
| 28 | Mapping-data import and governance: extract, format, approval, audit, versioning, promotion, rollback (N17) | Bank Business/Compliance / IT | **OPEN** | The mapping table and lookup exist, but no import workflow or approval trail. |
| 29 | Expected volume, concurrency, instance count and load-test target (N18) | Bank IT / Infrastructure / Business | **OPEN** | Needed for UAT sizing and the concurrency review. |
| 30 | REIS retry time zone and release/rollback plan (N19) | REIS / Bank IT-Operations | **OPEN** | Time zone matters for UAT; go-live window and rollback are for production. |
| 31 | `product` cardinality: single string/code or array, for Individual and Corporate (N21) | REIS / FLEXCUBE team | **OPEN** | The specification describes a string but also shows an array example. |
| 32 | HTTP 401 handling on `searchOnboardCustomer`: fresh token and one retry? (N22) | REIS / Bank Integration owner | **OPEN** | No 401 retry is approved or implemented. |
| 33 | KYC-only scope boundary recorded in writing; AML/TFS excluded unless separately approved (N23) | Bank Compliance / project sponsor | **OPEN** | Scope decision to record, not a feature. |
| 34 | Architecture: who calls REIS - FLEXCUBE's scheduler directly (per the FLEXCUBE Approach Document) or the Bank Integration API (N24); the Bank-side scope may be only the webhook and the FLEXCUBE status update | Bank architecture owner / FLEXCUBE team / REIS | **OPEN** | The Approach Document (23-Sep-2026) says FCUBS submits to REIS itself and the Bank builds the PENDING-status webhook; this project implements the other model. Decide in writing before further code investment. |

**Summary:** 34 blockers: 20 OPEN (#1, 2, 3, 12, 13, 14, 15, 16, 22, 23, 25 to 34), 13 PARTIAL (#4, 5, 7, 8, 9, 10, 11, 17, 18, 19, 20, 21, 24), 1 ANSWERED (#6). Only #6 is clearly answered, and it does not remove the need for the mapping data itself. Real end-to-end UAT is therefore **not ready**. Code `210` (Corporate Account Purpose) is tracked inside #3 and N20. Items #25 to #33 were added after the review of the remaining questions; the implementation order after the answers is in `docs/post-answers-implementation-plan.md`.

**Practical order**
1. **Bank:** review and approve the LOV / reference mappings (#3, plus #17 and #18 values). This is the step FLEXCUBE asked for explicitly.
2. **FLEXCUBE:** final inbound contract and authentication (#1, #2), the final-status update mechanism and codes (#9, #20), and the missing mapping fields (#4, #5, #19, #23).
3. **REIS + Bank:** choose the callback authentication mode (#7) and settle the resend rule and idempotency of resending the same systemId (#8, #10, #21), plus the relation semantics (#22).
4. **Infrastructure / Operations:** UAT network, credentials, test data and runtime (#12 to #16) and the manual-update procedure (#24).
5. After the requirements close: update the design and code, then run the test cases below against the real REIS and FLEXCUBE UAT.

## UAT test cases to run once unblocked
| Case | Steps | Expected result |
|---|---|---|
| CLEAN | submit a new KYC_REF_NO that REIS answers CLEAN | one authenticate + one onboarding call; case `REIS_CLEAN`; riskCalculationId / reisId (and any instruction/errorMessage) stored |
| PENDING -> CUSTOMER | submit; REIS answers PENDING; REIS posts `/customerStatus` CUSTOMER | case `REIS_PENDING`, then `FINALIZED` with final status CUSTOMER; FLEXCUBE update `APPLIED`; HTTP 200 |
| PENDING -> BLOCKED | as above with BLOCKED | `FINALIZED` BLOCKED; FLEXCUBE update `APPLIED`; HTTP 200 |
| REJECT | submit a customer REIS rejects | case `REIS_REJECTED` (not BLOCKED); response text stored |
| Duplicate submission | resubmit the same KYC_REF_NO | typed `DUPLICATE`, no second REIS call |
| Duplicate callback | REIS sends the same final callback twice | second is `DUPLICATE`, HTTP 200, no second FLEXCUBE update |
| Conflicting callback | CUSTOMER then BLOCKED (or reverse) | `CONFLICT`, original kept, audited |
| Unknown systemId | callback with an unknown systemId | `UNKNOWN_CASE`, nothing changed, audited |
| Callback for CLEAN/REJECT case | callback for a case not in PENDING | `INCONSISTENT_STATE`, nothing changed |
| Unknown id / bad payload / unauthorized | invalid JSON, non-final status, missing systemId, caller failing security | audited `INVALID` / `SECURITY_REJECTED`; nothing changed |
| Timeout / uncertain delivery | onboarding timeout, then a late final callback | `DELIVERY_UNCERTAIN`, then `RECONCILIATION_REQUIRED`; no automatic action; decision #10 needed |
| REIS authentication failure | wrong credentials | `FAILED_PERMANENT`, no onboarding call, no retry |
| Validation / mapping failure | missing mapping, bad date, several income sources | `VALIDATION_FAILED`, zero REIS calls; resubmission after the fix reuses the case |
| FLEXCUBE update failure and recovery | make the FLEXCUBE update fail on a valid callback; then run operator recovery | REIS decision kept, `UPDATE_FAILED` (HTTP 200), update `FAILED`; recovery -> `APPLIED`; repeat recovery -> `ALREADY_APPLIED` |
| Relations | corporate with related persons | relations nested in the single onboarding request (formId 3 ids 1-7, formId 4 ids 6-15) |
| Health | probe `/health/live` and `/health/ready` with DB up and down | 200 / 200, then 503 with `database: down`; no REIS traffic generated by probes |

## Already in place (for reference)
Per-call REIS authentication and onboarding with TLS validation on; transformation FLEXCUBE -> canonical -> REIS with typed failures; persistence with migrations; idempotent `/customerStatus` with audit; FLEXCUBE update tracked separately with operator recovery; operational queries; health endpoints. See `docs/confirmed-vs-tbd.md` for every confirmed/provisional/TBD item.
