# KYC submission workflow (Step 5)

`KycWorkflow.submit(request)` connects the components built so far. It is not exposed over HTTP yet (no FLEXCUBE controller, no `/customerStatus`).

```
provisional FLEXCUBE request
  1. find case by KYC_REF_NO            (repository)
  2. FlexcubeToCanonicalMapper          (no I/O)
  3. CanonicalToReisTransformer         (reference-mapping lookups only)
  4. create case / reopen after validation failure          (repository)
  5. status SUBMITTED_TO_REIS           (repository)
  6. ReisOnboardingClient.onboard()     -> POST /xauth/authenticate/  (fresh token)
                                        -> POST /onboarding/v2/searchOnboardCustomer
  7. persist the onboarding result      (repository)
```
`KYC_REF_NO` = REIS `systemId` = `kyc_case.reis_system_id`. Mapper/transformer never call REIS; the REIS client never touches the repository; the repository knows nothing about HTTP. **No retry, scheduler or automatic resubmission exists** (retry/resubmission policy is TBD).

## Result type
`submit` returns a typed result and throws only for unexpected infrastructure errors:
- `ONBOARDED` with `reisOnboardingStatus` `CLEAN` | `PENDING` | `REJECT` (+ `instruction` / `errorMessage` returned to the caller only);
- `DUPLICATE` with a `reason`, no external call, nothing changed;
- `FAILED` with `stage`, `code`, `requestMayHaveReachedReis` (diagnostic only), `persistedStatus`.

## Internal status transitions
```
(new)            -> RECEIVED -> SUBMITTED_TO_REIS -+-> REIS_CLEAN       (REIS: CLEAN)
                                                   +-> REIS_PENDING     (REIS: PENDING) -> FINALIZED   (later /customerStatus: CUSTOMER or BLOCKED)
                                                   +-> REIS_REJECTED    (REIS: REJECT; NOT BLOCKED, different stage)
                                                   +-> DELIVERY_UNCERTAIN   (outcome unknown; never retried)
                                                   +-> FAILED_PERMANENT / FAILED_RETRYABLE
(new, bad input) -> VALIDATION_FAILED --(corrected resubmission, same KYC_REF_NO)--> RECEIVED -> ...
```
`REIS_CLEAN`, `REIS_PENDING`, `REIS_REJECTED` also set `reis_onboarding_status`; `FINALIZED` (Step 7) sets `final_status`. `FAILED_RETRYABLE` is a classification only: nothing retries it.

## Exactly which external calls happen
"Auth" = `POST /xauth/authenticate/`; "Onb" = `POST /onboarding/v2/searchOnboardCustomer`.

| Scenario | Auth | Onb | Case after |
|---|---|---|---|
| New KYC_REF_NO, REIS answers CLEAN | 1 | 1 | `REIS_CLEAN` |
| New, REIS answers PENDING | 1 | 1 | `REIS_PENDING` (waits for `/customerStatus`) |
| New, REIS answers REJECT | 1 | 1 | `REIS_REJECTED` (final_status stays null) |
| Mapper/transformer failure (bad date/number, missing field, unmapped value incl. 203/204, several income sources) | 0 | 0 | `VALIDATION_FAILED` + error code |
| Blank KYC_REF_NO / unknown customer type | 0 | 0 | nothing persisted (no usable key) |
| Existing case: `RECEIVED`, `SUBMITTED_TO_REIS` | 0 | 0 | unchanged; `DUPLICATE / IN_PROGRESS_OR_UNCERTAIN` |
| Existing after CLEAN / PENDING / REJECT | 0 | 0 | unchanged; `ALREADY_CLEAN` / `AWAITING_FINAL_STATUS` / `ALREADY_REJECTED` |
| Existing after final status | 0 | 0 | unchanged; `ALREADY_FINALIZED` |
| Existing `DELIVERY_UNCERTAIN` | 0 | 0 | unchanged; `DUPLICATE / DELIVERY_UNCERTAIN` |
| Existing `FAILED_RETRYABLE` / `FAILED_PERMANENT` | 0 | 0 | unchanged; `PREVIOUS_ATTEMPT_FAILED` |
| Existing `VALIDATION_FAILED`, corrected data resubmitted | 1 | 1 | same case reopened -> CLEAN/PENDING/REJECT |
| Existing `VALIDATION_FAILED`, still invalid | 0 | 0 | stays `VALIDATION_FAILED` |
| Auth 401/403 | 1 | 0 | `FAILED_PERMANENT` `REIS_AUTH_REJECTED` |
| Auth timeout / network / 5xx | 1 | 0 | `FAILED_RETRYABLE` (retryCount + 1, not retried) |
| Auth other 4xx / malformed response | 1 | 0 | `FAILED_PERMANENT` |
| Onboarding HTTP 4xx (incl. 401/403) | 1 | 1 | `FAILED_PERMANENT` (REIS rejected the call) |
| Onboarding HTTP 5xx | 1 | 1 | `DELIVERY_UNCERTAIN` |
| Onboarding timeout (request may have reached REIS) | 1 | 1 | `DELIVERY_UNCERTAIN`, not retried |
| Onboarding connection reset | 1 | 1 | `DELIVERY_UNCERTAIN` |
| Onboarding connection refused / DNS / TLS failure (never sent) | 1 | attempted, not delivered | `FAILED_RETRYABLE` |
| Onboarding 2xx with unreadable body or unknown status | 1 | 1 | `DELIVERY_UNCERTAIN` (REIS probably processed it) |
| Unexpected non-REIS error from the client | 1 | maybe | `DELIVERY_UNCERTAIN`, error rethrown |

## Idempotency (submission)
The existing-case check runs before any processing, so a duplicate with different or invalid data is still a `DUPLICATE`. Concurrent submissions of one KYC_REF_NO produce one case and one REIS onboarding (the unique index decides; the loser gets `DUPLICATE`). The only existing case that is processed again is `VALIDATION_FAILED`, because REIS was never contacted - this lets a fixed mapping be followed by a resubmission under the same KYC_REF_NO.

## What is persisted (and not)
Persisted: `kyc_ref_no`, `reis_system_id`, customer type, `customer_no` (nullable), internal status, `reis_onboarding_status`, `risk_calculation_id`, `reis_id`, **`reis_instruction`, `reis_error_message`**, `retry_count`, `last_error_code`, `last_error_message`, timestamps.
- Error text (`last_error_message`) is a classification sentence built by the integration (e.g. "REIS searchOnboardCustomer returned HTTP 500"); unmapped-value errors name the mapping type, never the submitted value.
- **REIS `instruction` / `errorMessage`**: the confirmed KYC requirement is to store them, so they are saved on the case record (columns `reis_instruction`, `reis_error_message`, up to 4000 characters, nullable). They may be sensitive, so the rule is: **persisted, but never logged, never placed in exception messages, never exposed by unrelated responses** (logs, errors and the webhook response are tested not to contain them).
- **Never persisted:** tokens, REIS credentials, request/response payloads, customer values.

## Failure classification is PROVISIONAL
`FAILED_PERMANENT`, `FAILED_RETRYABLE`, `DELIVERY_UNCERTAIN` and the HTTP-status mapping (4xx = rejected, 5xx or unreadable 2xx = outcome unknown) are a **provisional diagnostic classification** made by this integration. REIS has not provided its final retry / timeout / error-code policy, so none of these is a confirmed REIS business rule. They never trigger automatic retry, and `requestMayHaveReachedReis` is diagnostic metadata only.

## TBD (unchanged by this step)
- Final REIS retry / timeout / error-code policy and the retry / resubmission business rule: `FAILED_*` and `DELIVERY_UNCERTAIN` cases stay as they are and block resubmission until it is defined (an operator procedure or a rule is needed).
- `/customerStatus` handling and FINALIZED transition (Step 7), and the real FLEXCUBE status update.
- Whether CLEAN needs any FLEXCUBE-side action.
