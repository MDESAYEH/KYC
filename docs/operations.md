# Operations: recovery, queries and health (Step 7)

None of this is exposed over public HTTP (except the two health endpoints). There is **no automatic retry, no scheduler and no admin endpoint**. These are application services for operators and later monitoring/runbooks.

## FLEXCUBE update recovery (`IFlexcubeUpdateRecoveryService`)
`retryFailedUpdate(kycCaseId)` is an explicit, operator-triggered call.

| Case state | Outcome | `IFlexcubeStatusUpdater` called? |
|---|---|---|
| `final_status` set and `flexcube_update_status = FAILED` | `RECOVERED` (update succeeded -> `APPLIED`) or `STILL_FAILED` (stays `FAILED`, refreshed safe metadata) | yes, once |
| `flexcube_update_status = APPLIED` | `ALREADY_APPLIED` (idempotent) | no |
| no `final_status` | `NOT_ELIGIBLE / NO_FINAL_STATUS` | no |
| update `NOT_ATTEMPTED` or `PENDING` (interrupted / in flight) | `NOT_ELIGIBLE / UPDATE_NOT_FAILED` | no |
| unknown id | `CASE_NOT_FOUND` | no |

Rules: the REIS final decision (`final_status`, `final_status_at`, internal status, REIS customer id) is **never modified**. The case is claimed atomically (`FAILED -> PENDING` by a conditional UPDATE), so concurrent operators run the updater once. The updater receives the same idempotency key as the first attempt (`<internalId>:<finalStatus>`) so a real implementation can deduplicate. The real FLEXCUBE updater is still TBD (a mock is bound); this exercises the seam only.

Recorded per attempt (`kyc_case`, migration 4 plus the existing Step 6 columns): `flexcube_update_attempt_count` (every updater call, automatic first attempt included), `flexcube_last_attempt_at`, `flexcube_update_error_code`, `flexcube_update_error_message` (generic text + error class name, never the error message itself), `flexcube_updated_at` (set on success). No customer payloads, tokens or credentials.

## DELIVERY_UNCERTAIN reconciliation support
A final callback for a `DELIVERY_UNCERTAIN` case produces the typed outcome `RECONCILIATION_REQUIRED` (not a normal `INCONSISTENT_STATE`): audit row preserved with the incoming `CUSTOMER`/`BLOCKED` value, `final_status` not set, FLEXCUBE not called, onboarding not retried. There is no operator approval mechanism and **the reconciliation rule is TBD** (Bank/REIS decision), see `docs/customer-status-webhook.md`.

## Operational queries (`IOperationalQueryService`)
| Method | Returns |
|---|---|
| `findStuckPendingCases(olderThan)` | cases still `REIS_PENDING` and last updated before `olderThan` (callback overdue) |
| `findDeliveryUncertainCases()` | `DELIVERY_UNCERTAIN` cases + number/last time/incoming status of audited `RECONCILIATION_REQUIRED` callbacks |
| `findFailedFlexcubeUpdates()` | cases whose `flexcube_update_status = FAILED` |
| `findRecentCallbackConflicts(since)` | audit events `CONFLICT`, `CUSTOMER_ID_MISMATCH`, `INCONSISTENT_STATE`, `RECONCILIATION_REQUIRED` |
| `findRecentUnknownCaseCallbacks(since)` | audit events `UNKNOWN_CASE` |

All accept `{ limit }` (default 100, hard cap 500). Case summaries contain identifiers, statuses, timestamps, counters and error **codes** only. They exclude customer data, `CUSTOMER_NO`, REIS `instruction`/`errorMessage`, free-text error messages and payloads. Event results are the audit rows (safe technical fields).

## Health
- `GET /health/live`: process liveness, always `200 {"status":"ok"}` while the process answers.
- `GET /health/ready`: `200 {"status":"ok","checks":{"database":"up","configuration":"ok"}}`, or `503 {"status":"unavailable", ...}` with `database: down` (2 s timeout) and/or `configuration: invalid`.
- Readiness checks only: database reachable (`SELECT 1` through a persistence-private probe) and required configuration present/valid (REIS and database settings are re-validated, details not reported).
- Readiness **does not call REIS**: no authenticate traffic, no flapping on an external dependency. If a REIS connectivity probe is ever added it must be separate and non-default.
- Responses contain only those coarse words: no credentials, URLs, tokens, configuration values or customer data.

## Manual FLEXCUBE update after REIS retries (REIS reply 2026-10-10)
REIS retries a callback that did not get HTTP 200 (final retry about 00:00) and then expects a **manual FLEXCUBE update**. Operators can find the decisions with the existing queries: `findFailedFlexcubeUpdates` (decision stored, FLEXCUBE update failed: use `retryFailedUpdate` first), `findRecentCallbackConflicts` and `findRecentUnknownCaseCallbacks` (callbacks we could not apply; the audit row shows the incoming status and systemId), and `findDeliveryUncertainCases` (with reconciliation callbacks). The runbook itself (who, when, how) is an open Bank operations decision (N13).
