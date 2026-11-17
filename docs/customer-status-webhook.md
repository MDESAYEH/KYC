> **CIF requirement update — 17 November 2026:** Statements below equating primary REIS `systemId` with `KYC_REF_NO` describe the historical baseline and are superseded. The required customer identity is CIF; its Oracle source, lifecycle, historical identity reconciliation and revision/callback contract are still unverified. The current application holds all new submissions; historical callbacks remain supported. See [CIF preparation and blockers](reis-cif-identity.md).

# `POST /customerStatus` - REIS final-status webhook (Step 6)

```
PENDING  (REIS answered PENDING to searchOnboardCustomer; case = REIS_PENDING)
   |
   v   ...REIS workflow completes...
REIS ---- POST /customerStatus ---->  Bank Integration API
                                        |
                                        v  1. webhook security strategy      (IWebhookSecurityStrategy)
                                        v  2. validate callback               (status CUSTOMER | BLOCKED only)
                                        v  3. audit row written               (webhook_event, no payload)
                                        v  4. correlate: callback.systemId -> kyc_case.reis_system_id (= KYC_REF_NO)
                                        v  5. idempotent final status         (APPLIED | DUPLICATE | CONFLICT | ...)
                                        v  6. persist CUSTOMER / BLOCKED      (case FINALIZED)
                                        v  7. FLEXCUBE status update adapter  (IFlexcubeStatusUpdater, mock for now)
                                        v  8. record flexcube_update_status   (APPLIED | FAILED), audit result
   <---- HTTP 200 on successful processing ----
```

## Confirmed vs TBD

**CONFIRMED**
- Endpoint `POST /customerStatus`, JSON body.
- Payload sample: `{"status":"BLOCKED","systemId":"2378287","customerId":217489,"systemName":"Flexcube","ServiceType":"CUSTOMER_STATUS"}`.
- Status field spelling: V1.5 names it `Status` in the attribute table, the sample uses `status`. Both are accepted; `Status` is used only when `status` is absent, and both present with different values is rejected as malformed.
- Final statuses are only `CUSTOMER` and `BLOCKED` (never CLEAN / PENDING / REJECT).
- Correlation: callback `systemId` = our KYC_REF_NO (= `kyc_case.reis_system_id`).
- HTTP 200 after valid processing, including a safe identical duplicate.
- The handler must be idempotent.

**PROVISIONAL (implemented, to be confirmed)**
- The final callback schema is not approved: `customerId` is optional/nullable (integer), `systemName` optional, `ServiceType` validated against `CUSTOMER_STATUS` only when present, `systemId` strictly a string, unknown fields ignored (never stored).
- Every non-200 HTTP status below (400/401/404/409). We do not know REIS' retry behaviour or its retry-trigger status codes, and nothing here claims that any code will or will not cause REIS to retry.
- 200 for `UPDATE_FAILED` is **PROVISIONAL BANK-SIDE BEHAVIOUR, not a REIS contract.** Reason: the REIS decision has already been durably accepted and stored, and REIS' callback retry / error-code behaviour is still TBD, so we must not depend on undocumented REIS retries. The failed FLEXCUBE update stays visible (`flexcube_update_status = FAILED`, see `docs/operations.md`) for operator recovery.

**TBD**
- Inbound authentication (see below): mTLS, API key, OAuth, IP allowlist or an API gateway are all possibilities; none is confirmed.
- REIS callback retry policy, timeout policy, and the exact non-200 retry-trigger codes.
- The real FLEXCUBE update mechanism (the FLEXCUBE team will confirm it). Nothing here touches FLEXCUBE tables, stored procedures or APIs.
- Production database transaction/concurrency implementation (see below).

## Processing outcomes
| Result (audit + body) | When | HTTP (provisional except 200) | State change | FLEXCUBE updater |
|---|---|---|---|---|
| `APPLIED` | first valid callback for a case in `REIS_PENDING` | 200 | final status stored once, case `FINALIZED`, REIS `customerId` stored if the case had none, `flexcube_update_status` PENDING -> APPLIED | called exactly once |
| `UPDATE_FAILED` | as APPLIED, but the FLEXCUBE update threw | 200 (PROVISIONAL bank-side) | same, but `flexcube_update_status` = FAILED (+ code, safe message). The REIS decision is **not** lost | called once, not retried automatically; operator recovery available |
| `DUPLICATE` | same final status again | 200 | only `final_status_received_count` grows | not called |
| `CONFLICT` | CUSTOMER after BLOCKED or BLOCKED after CUSTOMER | 409 | none; original kept; `conflicting_final_status` records the attempt | not called |
| `CUSTOMER_ID_MISMATCH` | callback `customerId` differs from the stored REIS customer id | 409 | none | not called |
| `INCONSISTENT_STATE` | case has no final status but is not `REIS_PENDING` (CLEAN, REJECT, failed, ...) | 409 | none; no override rule exists | not called |
| `RECONCILIATION_REQUIRED` | case is `DELIVERY_UNCERTAIN` (onboarding outcome unknown) and a CUSTOMER/BLOCKED callback arrives | 409 | none: finalStatus is NOT set; the audit row keeps the incoming status. Distinct from a normal lifecycle conflict | not called; onboarding not retried |
| `UNKNOWN_CASE` | no case with that `systemId` | 404 | none (no other case is ever touched) | not called |
| `INVALID` | not a valid callback (bad/non-final status, missing systemId, wrong types, ...) | 400 | none | not called |
| `SECURITY_REJECTED` | strategy returned anything but `true`, or threw | 401 | none; body not read | not called |

Notes: syntactically broken JSON, oversized or undecodable bodies are rejected by the HTTP layer with the same 4xx **and are now audited** (see below). Correlation uses only `systemId`; names or other personal data are never used to find a case. REIS `customerId` and FLEXCUBE `CUSTOMER_NO` are different identifiers and are stored in different columns.

## Idempotency
`applyFinalStatus` (persistence) decides the outcome with atomic conditional updates (`... WHERE final_status IS NULL AND internal_request_status = 'REIS_PENDING'`). Only the call that wins that update returns `APPLIED` and triggers the FLEXCUBE update, so concurrent identical callbacks produce exactly one business application (tested with 6 parallel callbacks). A changed final status is never silently overwritten.

## FLEXCUBE update state is separate from the REIS decision
`kyc_case.final_status` (REIS decision) and `kyc_case.flexcube_update_status` (`NOT_ATTEMPTED` -> `PENDING` -> `APPLIED` | `FAILED`, plus `flexcube_update_error_code`, `flexcube_update_error_message`, `flexcube_updated_at`) are independent. A valid callback is stored first; a FLEXCUBE failure only changes the update state. **There is no automatic retry** of FLEXCUBE updates (no approved retry rule); a duplicate callback does not repeat a failed or successful update. A case left in `PENDING` means the update was interrupted.

## Audit trail (`webhook_event`)
One row per callback, written before the callback is applied (`PROCESSING`) and completed afterwards:
`event_id` (generated UUID), `received_at`, `processed_at`, `system_id`, `incoming_status`, `incoming_customer_id`, `system_name`, `service_type`, `processing_result` (APPLIED, DUPLICATE, CONFLICT, UNKNOWN_CASE, INCONSISTENT_STATE, RECONCILIATION_REQUIRED, CUSTOMER_ID_MISMATCH, INVALID, SECURITY_REJECTED, UPDATE_FAILED), `detail_code`, `kyc_case_internal_id` (nullable).
Never stored: the payload, unknown fields, headers, tokens, credentials, names or other personal data. Echoed text fields are truncated. For `SECURITY_REJECTED` nothing from the unauthorized body is read or stored. A row stuck in `PROCESSING` shows an interrupted run. (Unauthenticated callers can create audit rows; rate limiting is a deployment concern.)

## Webhook security
`IWebhookSecurityStrategy` is invoked for every callback, before anything else. Selection (`WEBHOOK_SECURITY_MODE`):
| Configuration | Behaviour |
|---|---|
| not set | **deny-all** strategy: every call is `SECURITY_REJECTED` (401); warning logged at startup. Safe in every environment |
| `unrestricted-dev` | explicit development/test-only open strategy; **refused at startup in production** |
| anything else (`api-key`, `mtls`, ...) | **startup fails**: the mechanism is TBD and nothing silently falls back to open |
Production therefore cannot accidentally run an unrestricted webhook. No API key, certificate or IP list is hardcoded or assumed; the later mechanism (mTLS, API key, OAuth, IP allowlist or API gateway) plugs in as a new strategy. A strategy that throws is treated as a rejection.

## Transactions and concurrency
SQLite runs on a single connection, so correctness relies on single atomic conditional/incremental UPDATE statements, not on a multi-statement transaction. **This is not claimed to be the final production transaction design.** When the production database is selected, review: isolation level, whether final-status application, audit completion and the FLEXCUBE update state should share one transaction, row locking, and unique-constraint error handling.

## Logging
Logs contain only the audit event id, the typed result and the internal case id. Never payloads, REIS text (`instruction`/`errorMessage`), systemId/KYC_REF_NO, names, headers or credentials (tested).


## Malformed HTTP attempts are audited (Step 7)
Express' JSON body parser rejects syntactically invalid JSON (and oversized or undecodable bodies) before the controller runs. A global exception filter (`CustomerStatusMalformedRequestFilter`, registered by `configureApp`) now records such `POST /customerStatus` attempts as an audit row with `processing_result = INVALID` and a `detail_code` (`MALFORMED_JSON`, `PAYLOAD_TOO_LARGE`, `UNREADABLE_BODY`), `event_id`, `received_at`, `processed_at`; `system_id` and the other echo fields stay null. The security strategy still runs first (headers and address only), so an unauthorized caller is `SECURITY_REJECTED`. The raw body and the parser's error text (which can quote the body) are never stored or echoed. JSON validation is not weakened: the request is still rejected with the parser's 4xx status. Only `POST /customerStatus` is audited; other routes keep Nest's default handling.

## DELIVERY_UNCERTAIN followed by a callback - TBD
```
onboarding request times out (or the outcome is otherwise unknown)
  -> requestMayHaveReachedReis = true, case = DELIVERY_UNCERTAIN
  -> REIS may later send CUSTOMER / BLOCKED
  -> RECONCILIATION_REQUIRED
```
Today the callback is **audited and nothing else happens**: `finalStatus` is not set, FLEXCUBE is not called, onboarding is not retried, and there is no automatic reconciliation or operator approval mechanism. The audit row preserves the incoming CUSTOMER/BLOCKED value as evidence (and `findDeliveryUncertainCases` shows how many such callbacks arrived). **Decision needed from the Bank / REIS:** may a valid final callback reconcile a `DELIVERY_UNCERTAIN` case automatically (and if so, under which checks, e.g. matching systemId and customerId), or must an operator approve it? Until then the final reconciliation rule is TBD.

## REIS reply (2026-10-10): retries and authentication
- **REIS retries any non-200 response**, with a final retry at about midnight (00:00); if retries are exhausted without FLEXCUBE being updated, a manual FLEXCUBE update is expected. REIS timeout, retry interval and maximum attempts were not given.
- Consequences for this endpoint: a **200 ends REIS retries** (APPLIED, DUPLICATE and the provisional bank-side `UPDATE_FAILED`), while 400 / 401 / 404 / 409 results will be retried by REIS (they stay audited each time; `RECONCILIATION_REQUIRED`, `CONFLICT`, `INCONSISTENT_STATE`, `UNKNOWN_CASE` would simply repeat). The earlier statement that no claim is made about REIS retries is superseded for the *any non-200* rule; which of our codes SHOULD be non-200 is still a design choice to review.
- The incoming status is kept in the audit row, so a manual FLEXCUBE update after exhausted retries can use `findRecentUnknownCaseCallbacks` / `findRecentCallbackConflicts` (see `docs/operations.md`).
- REIS says the bank logic should rely on `systemId` and `status` (CUSTOMER / BLOCKED); other fields are not stated as final.
- **Callback authentication modes REIS supports:** NONE, BASIC (plain-text credentials in the request), BEARER (access token / API key), NTLM. The Bank chooses; nothing is implemented (deny-all until configured). Using BASIC requires TLS; NONE would leave the endpoint open.
