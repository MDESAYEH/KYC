# REIS transport

```
onboard(request)
   |
   v
authenticate()  --  POST {REIS_BASE_URL}/xauth/authenticate/
   |   headers: Content-Type: application/json, x-auth-tenant: {REIS_TENANT}
   |   body:    { "user_name": REIS_USERNAME, "password": REIS_PASSWORD }
   v
response { "token": "..." }          (field is `token`; validated, blank/missing -> failure)
   |
   v
x-auth-token: <token>                (NOT `Authorization`)
   |
   v
searchOnboardCustomer -- POST {REIS_BASE_URL}/onboarding/v2/searchOnboardCustomer
       headers: Content-Type: application/json, x-auth-tenant, x-auth-token
       body:    main request, with `relations` nested inside it
   |
   v
validated ReisOnboardingResponse { status, riskCalculationId?, reisId?, instruction?, errorMessage? }
```

## Fresh token on every call
The current working Postman behaviour is to authenticate before each onboarding request. The client does exactly that: **every `onboard()` performs a new `authenticate()`**; there is no token cache, no reuse, no expiry logic. Tests assert that two onboarding calls produce two authentication calls with different tokens. The token is held only in a local variable: never logged, persisted, or attached to errors.

## Request envelope (confirmed by the working Postman)
```json
{
  "systemName": "Flexcube",
  "systemId": "<KYC_REF_NO>",
  "formId": 1,
  "items": { "entity_type": "PP", "first_name": "...", "...": "..." },
  "relations": []
}
```
Top level: `systemName`, `systemId`, `formId`, `relations`. Inside `items`: `entity_type` and all individual/corporate business fields. The Individual shape is confirmed; the Corporate shape (`formId` 2, `entity_type` `PM`) is derived from V1.2 and awaits UAT verification with a real Corporate request.

## Relations
Relations are not separate calls: they are the `relations` array of the main request, `[]` when there are none. An individual relation entry is:

```json
{ "formId": 3, "entity_type": "PP",
  "items": { "entity_type": "PP", "first_name": "...", "last_name": "...", "cus_birth_date": "...",
             "nationality": "...", "citizenship": "..." },
  "relationshipId": 1, "systemName": "Flexcube", "systemId": "..." }
```
`entity_type` is present on both the entry and `items`; this is the current working wire shape and is preserved deliberately. The client sends the request exactly as given (no flattening, stripping or splitting). Only the FLEXCUBE-side source mapping for corporate relations is TBD.

## Response handling
- `status` must be `CLEAN`, `PENDING` or `REJECT`; anything else fails (`ReisUnsupportedStatusError`), never coerced.
- `riskCalculationId` / `reisId` keep their wire type (string or number, or null). `instruction` and `errorMessage` are preserved as response data. A finite numeric `instruction` is normalized to text; an object-valued `instruction` is preserved as compact JSON text before persistence. `errorMessage` must remain text or null.
- **A valid REJECT is a normal result**, even with an informational `errorMessage`; the workflow decides the business outcome and persists it. A non-empty `errorMessage` alone never causes a failure.
- Undocumented fields are dropped.

## Error taxonomy (`reis.errors.ts`)
| Error | Category | Meaning |
|---|---|---|
| `ReisAuthenticationError` | AUTHENTICATION | HTTP 401/403 from authenticate or onboarding |
| `ReisTimeoutError` | TIMEOUT | No answer within `REIS_TIMEOUT_MS`; `requestMayHaveReachedReis = true` (diagnostic only) |
| `ReisNetworkError` | NETWORK | Connection failure; `errorCode`; `requestMayHaveReachedReis` is false for refused/DNS/TLS-validation failures, true otherwise (e.g. reset) |
| `ReisHttpStatusError` | HTTP_STATUS | Any other non-2xx |
| `ReisMalformedResponseError` | MALFORMED_RESPONSE | Empty/invalid JSON, wrong shape, missing/blank token, missing status, wrong field types |
| `ReisUnsupportedStatusError` | UNSUPPORTED_STATUS | Status outside CLEAN/PENDING/REJECT |
| `ReisConfigError` | (startup) | Invalid REIS configuration; names variables only |
| `ReisApplicationError` | APPLICATION_ERROR | **Reserved** for a future confirmed REIS application-error contract; nothing raises it today |

## Retry policy
The clients **never retry** and `requestMayHaveReachedReis` is diagnostic metadata. Errors are only classified; the trigger poller decides whether a revision is sent again (`docs/flexcube-sync.md`).

## Security and logging
- TLS certificate validation is always on: no custom agent, no `rejectUnauthorized`, `strictSSL` or `NODE_TLS_REJECT_UNAUTHORIZED` anywhere. `REIS_BASE_URL` must be `https` in production. Redirects are not followed, so the token is never re-sent elsewhere.
- Credentials come only from `REIS_*` environment variables; the validated config hides the password from JSON/inspect output.
- Thrown errors are built from our own text and never carry the Axios error (whose config holds headers and body).
- Logs contain only: event, operation, HTTP status, duration, caller-supplied correlation id, form id, onboarding status, and presence flags (`hasReisId`, `hasRiskCalculationId`, `hasInstruction`, `hasErrorMessage`). Never: passwords, tokens, headers, request bodies, `errorMessage`/`instruction` text, ids' values, or personal data.
- The REIS clients do not use persistence; the future workflow coordinates clients and repository.

## Configuration
`REIS_BASE_URL`, `REIS_TENANT`, `REIS_USERNAME`, `REIS_PASSWORD`, `REIS_TIMEOUT_MS` (positive integer, ms) are all required and validated when the application starts. See `.env.example` (names only).

## REIS reply (2026-10-10) vs the current "no retry" behaviour
REIS advises: if a `searchOnboardCustomer` request times out or the network is interrupted, **consider it failed and send it again**; a request is unsuccessful whenever HTTP 200 is not returned; no lookup/reconciliation mechanism is offered. The clients still **never retry** and the workflow classifies such cases `DELIVERY_UNCERTAIN`, because a resend could create a duplicate onboarding unless REIS confirms that a resend with the same `systemId` is idempotent, and the Bank has not yet set its resend rule. This is an open decision, see `docs/external-decisions-required.md` (section 0b, N9). Also from REIS: REJECT is a business decision to be reflected on FLEXCUBE; Corporate follows the same envelope as Individual; `instruction` / `errorMessage` have no maximum length and carry no sensitive data; there are no request limits.
