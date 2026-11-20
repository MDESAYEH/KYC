# KYC submission workflow

`KycWorkflow.submit(request, { seqNo })` sends one CIF revision. It is called only by the trigger poller
([flexcube-sync.md](flexcube-sync.md)), after the staging row was claimed.

```
FLEXCUBE request (CUSTOMER_NO = CIF)
  1. find the case by KYC_REF_NO                      (repository)
  2. FlexcubeToCanonicalMapper                        (no I/O)
  3. CanonicalToReisTransformer, systemId = CIF       (reference-mapping lookups only)
  4. create / reopen the case                         (repository)
  5. status SUBMITTED_TO_REIS
  6. ReisOnboardingClient.onboard()   -> POST /xauth/authenticate/ (fresh token)
                                      -> POST /onboarding/v2/searchOnboardCustomer
  7. store the result; CLEAN / REJECT -> REIS_FINAL_STATUS at once
```

`KYC_REF_NO` + `SEQ_NO` is the internal key; REIS `systemId` = CIF (`kyc_case.reis_system_id`). A related party may not
use the CIF as its own systemId.

## Result

- `ONBOARDED`: `CLEAN` | `PENDING` | `REJECT`;
- `DUPLICATE`: REIS already answered this revision (or another submission of it is running); nothing is sent;
- `FAILED`: `stage`, `code`, `persistedStatus`. The poller retries `FAILED_RETRYABLE` and `DELIVERY_UNCERTAIN`.

## Internal statuses

```
RECEIVED -> SUBMITTED_TO_REIS -+-> REIS_CLEAN / REIS_REJECTED
                               +-> REIS_PENDING -> FINALIZED (callback CUSTOMER / BLOCKED)
                               +-> FAILED_RETRYABLE / DELIVERY_UNCERTAIN  (sent again by the poller)
                               +-> FAILED_PERMANENT                       (final for the revision)
VALIDATION_FAILED (bad input, REIS not called)
```

The same revision is sent again only from `RECEIVED`, `SUBMITTED_TO_REIS`, `VALIDATION_FAILED`, `FAILED_RETRYABLE`,
`DELIVERY_UNCERTAIN` or `FAILED_PERMANENT` (`reopenForRetry`; the poller decides when). A higher `SEQ_NO` (CIF modified) replaces a closed previous revision
(`reopenForAmendment`).

## Failure classification

| Failure | Case | Poller |
| --- | --- | --- |
| Mapping / validation (missing field, invalid value, unmapped code) | `VALIDATION_FAILED` | `E` |
| Any authenticate failure (credentials, timeout, network, HTTP, malformed) | `FAILED_RETRYABLE` | retry |
| Onboarding 401 / 403 (token refused) | `FAILED_RETRYABLE` | retry |
| Onboarding connection refused / DNS / TLS (never sent) | `FAILED_RETRYABLE` | retry |
| Onboarding timeout / reset / 5xx / unreadable answer / unknown status | `DELIVERY_UNCERTAIN` | retry |
| Onboarding other 4xx (REIS refused the data) | `FAILED_PERMANENT` | `E` |

## What is persisted (and not)
Persisted: `kyc_ref_no`, `reis_system_id`, customer type, `customer_no` (nullable), internal status, `reis_onboarding_status`, `risk_calculation_id`, `reis_id`, **`reis_instruction`, `reis_error_message`**, `retry_count`, `last_error_code`, `last_error_message`, timestamps.
- Error text (`last_error_message`) is a classification sentence built by the integration (e.g. "REIS searchOnboardCustomer returned HTTP 500"); unmapped-value errors name the mapping type, never the submitted value.
- **REIS `instruction` / `errorMessage`**: the confirmed KYC requirement is to store them, so they are saved on the case record (columns `reis_instruction`, `reis_error_message`, up to 4000 characters, nullable). They may be sensitive, so the rule is: **persisted, but never logged, never placed in exception messages, never exposed by unrelated responses**.
- **Never persisted:** tokens, REIS credentials, request/response payloads, customer values.
