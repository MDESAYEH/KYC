# Single-record trial runbook (KYC 001ZKYC26151003Y, CIF 00005818, SEQ_NO 1 = CIF MOD_NO)

## Result 19/11/2026 14:43 (Libya): CLEAN

REIS authentication 200, `searchOnboardCustomer` 200, status **CLEAN**, REIS customer id 247 (risk LR). FLEXCUBE staging
SEQ_NO 1 = `S` / `CLEAN`, trigger `P`. Earlier attempts (11:07 firewall + expired REIS certificate + timeout/base URL,
12:58 authentication 403 because of an unquoted `#` in `.env`, 14:14 HTTP 400 `account_manager_email` case-sensitive)
were reset with `npm run trial:reset` after REIS confirmed nothing was created. The rest of this file is the history.

## First attempt 19/11/2026 11:07 and how to reset it

The send stopped at REIS **authentication** (no onboarding call): `REIS_TIMEOUT_MS=30` (ms) in `.env`, the base URL
without `/kyc-web-restful`, and TCP 443 from 10.250.100.28 to reiskycuat.aiib.ly (10.250.40.1) blocked by the firewall.
No `wire.json` was saved, `failure.json` = `{"wire":null,"delivery":"UNCERTAIN"}`. Left: staging SEQ_NO 1 = E with that
marker, trigger = E, one local case DELIVERY_UNCERTAIN.

Reset (only after the firewall is open and REIS confirmed nothing arrived):
`node dist/tools/reset-single-kyc-trial.js --evidence-dir <dir>` (dry run), then the same with
`--confirm RESET_UNDELIVERED_TRIAL --reis-confirmation "<who/when>" --backup-file <new file>`. It refuses unless every
piece of evidence says nothing reached REIS; then preflight -> approval -> send as before.

## Update 19/11/2026: Finexta trigger-table flow

- Finexta (Abhilash): from now on (UAT and PROD) a KYC is sent only when its row in `STTM_CUSTOMER_CUSTOM` is
  `READY_TO_SCAN = 'U'` (FCUBS sets U after the CIF is authorized, and again after a CIF modification). The API sets `P`
  when it picks the row and `E` when processing fails. **SEQ_NO = `STTM_CUSTOMER.MOD_NO`** (every send carries the CIF).
- Read on UAT1 (read-only): CIF `00005818` MOD_NO **1**, KYC MOD_NO 2, trigger row `U`. The existing staging row SEQ_NO 1
  is OUR row (UUID MSGID) that failed with `ORA-01745` at the claim, before anything reached REIS.
- The trial therefore targets **SEQ_NO 1** and **reuses** that row under its own MSGID (E -> N -> W), but only when it
  is exactly a never-sent technical error (E, RETRY_COUNT 1, no REQUEST / REQ_DATE / final status, RESPONSE
  `{"error":"ORA-…"}`), the CIF is still at MOD_NO 1, and the trigger is still `U`. Any other E row is refused.
- Order of writes: restore (if E) -> claim -> re-read payload -> trigger `U -> P` (if refused: claim given back, nothing
  sent) -> intent -> REIS. An uncertain / failed delivery also sets the trigger `P -> E`. A success leaves `P`.
- `docs/finexta-cif-source.sql` now binds `:seqNo` to `STTM_CUSTOMER.MOD_NO` and requires the trigger at `U`.
- `claimSqlSha256` now covers the three pre-REIS writes (restore, claim, trigger U -> P): the preflight of 19/11 is
  stale; run preflight again after deploying this change.
- B4 closed (Abhilash 19/11: the account is authorized only when `REIS_FINAL_STATUS = CLEAN`). B6 closed (Bank, from the
  start of the project: REIS REJECT -> `BLOCKED`; approval file `rejectToBlockedApproved: true`).
- Abhilash 19/11: the account authorization reads the row with the **highest SEQ_NO** of the KYC. The trial therefore
  refuses (`HIGHER_SEQ_NO_EXISTS`) when the KYC has a row above the CIF MOD_NO (old rows used the KYC MOD_NO); the
  trigger source reports `higherRows` for the poller. Tareq's KYC has only SEQ_NO 1.
- B5 (19/11, review of 9f8b5fc): the callback route is exact for this trial: applied only when one revision was ever sent
  under the CIF (`revision_count = 1`) and the staging UPDATE requires the case's exact SEQ_NO. The CLI refusal
  `EXACT_REVISION_CALLBACK_ROUTE_NOT_IMPLEMENTED` and the quarantine of the CIF are removed; the old, never-sent identity
  (systemId = KYC_REF_NO) stays quarantined. Residual limit (unchanged): a second revision of the same CIF is quarantined
  until REIS echoes a per-submission identifier.


Status 17/11/2026: **local preparation only.** Nothing in this document has been run against UAT1 or REIS.
Update 18/11/2026: build `f641768` deployed on UAT1 with polling off; `check:oracle-sql` parsed 30/30 statements. The
blocker status is in section 4: none is closed, so no send is allowed.
Polling stays disabled. The 58 historical `E` rows are never touched. No commit, push or deployment is implied.

## 1. What exists (local, tested with synthetic Oracle / in-memory SQLite / fake HTTP REIS)

| Piece                                                                         | File                                                                        | State                                          |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------- |
| Fixed scope (one KYC + revision, reported CIF is comparison-only)             | `src/kyc/single-kyc-trial.scope.ts`                                         | done                                           |
| Approval contract (named approver, hashes, evidence references, 1 h validity) | `src/tools/single-kyc-trial.contract.ts`                                    | done                                           |
| Exact-revision staging SQL (claim, intent, completion, status)                | `src/tools/single-kyc-trial.repository.ts`                                  | done, **Oracle SQL unverified on real Oracle** |
| Read-only plan / single send / readback, raw REIS response capture            | `src/tools/single-kyc-trial.ts`, `.transport.ts`, `run-single-kyc-trial.ts` | done                                           |
| Callback quarantine for the trial identities (old KYC ref and CIF)            | `src/webhook/customer-status.service.ts`                                    | active                                         |
| Status vocabulary (opt-in) and exact-revision (`seqNo`) final-status update   | `staging/flexcube-staging.ts`, `staging-flexcube-status-updater.ts`         | done, **default unchanged**                    |

## 2. Hard gates that stay closed

1. `--mode send` is refused with `EXACT_REVISION_CALLBACK_ROUTE_NOT_IMPLEMENTED` while the trial identity is quarantined.
   Do **not** just remove the guard: lift it only after the exact-revision callback route is verified and Finexta has confirmed
   the status vocabulary (see 4).
2. The legacy `KYC_WORKFLOW` is the CIF hold (`CifSubmissionHoldWorkflow`): no automatic send path exists.
3. The CIF comes only from a reviewed read-only SELECT supplied as a file (binds `:kycRefNo`, `:seqNo`, one row, column
   `CIF_VALUE`). Without it: `FINEXTA_CIF_SQL_NOT_SUPPLIED`. `00005818` is only compared, never used as a source.

## 3. Review-only commands (do not run until the blockers in 4 are closed)

```bash
# 0. nothing changes the server: work in a separate checkout of the reviewed commit, never in /opt/aiib-dashboard
node dist/tools/run-single-kyc-trial.js --help

# 1. read-only preflight (SELECTs only; writes a NEW protected report file)
node dist/tools/run-single-kyc-trial.js --mode preflight --cif-sql approved-cif-select.sql --report /secure/preflight.json

# 2. after the approval file is written (section 5) and every gate is open:
node dist/tools/run-single-kyc-trial.js --mode send --cif-sql approved-cif-select.sql \
  --reviewed-plan /secure/preflight.json --approval /secure/approval.json \
  --evidence-dir /secure/evidence-NEW --report /secure/result.json --confirm SEND_ONE_VERIFIED_KYC

# 3. read-back only
node dist/tools/run-single-kyc-trial.js --mode verify --report /secure/verify.json
```

What step 2 would change: one restore or INSERT + one claim on staging row (KYC 001ZKYC26151003Y, SEQ_NO 1), trigger U -> P, one local case, **one**
REIS onboarding call with the CIF as `systemId`, the raw response recorded, `PROCESS_STATUS = S` and `REIS_FINAL_STATUS`
(CLEAN / PENDING, or BLOCKED only if REJECT→BLOCKED was approved) on exactly SEQ_NO 1. No retry, no requeue, no other row.
If the response is lost: `E`/uncertain, **no resend**; a person reconciles with REIS.

## 4. Blockers (evidence required before any send) — status 18/11/2026

“Partially resolved” means information was received but the evidence the gate needs does not exist yet. **No blocker is closed.** Nothing below has been tested by a send, and none of it may be assumed to work.

| #   | Blocker                                                                 | Owner             | Status 18/11/2026      | What is known                                                                                                                                                                                                                                                                                                                                                                                                                        | What is still required to close it                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------- | ----------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | CIF source, join and value for this KYC, available before the REIS call | Finexta + Bank IT | **Partially resolved** | Abhilash gave the source: `OBPPRD.STTM_CUSTOMER.CUSTOMER_NO`, joined on `KYC_REF_NO`, with `KYC_DETAILS='V'`, `RECORD_STAT='O'`, `AUTH_STAT='A'`, and the related KYC open and authorized; the CIF must exist before the KYC is sent. Adapted query: `docs/finexta-cif-source.sql`. The extra `K.MOD_NO = :seqNo` condition was added by development to target revision 2 and was **not** in Abhilash's query.                       | `REIS_KYC` gets `ORA-00942` on `STTM_CUSTOMER`: SELECT grant / synonym requested from Tareq. Then the read-only preflight must return **exactly one** CIF for `001ZKYC26151003Y`, equal to `00005818`, with the data type and leading zeros recorded. Abhilash must confirm or reject the `MOD_NO` condition in writing.                                                                                                       |
| B2  | REIS UAT holds neither `001ZKYC26151003Y` nor `00005818`                | Vneuron/REIS ops  | **Open**               | Nothing received.                                                                                                                                                                                                                                                                                                                                                                                                                    | Written confirmation from Vneuron, obtained without any state-changing REIS call.                                                                                                                                                                                                                                                                                                                                              |
| B3  | Real Oracle check of the staging / trial SQL                            | Bank IT + Finexta | **Partially resolved** | `npm run check:oracle-sql` on UAT1 reported 30/30 read-only dictionary checks passed, including the trial claim, intent, wire-status, and completion statements; nothing executed. This proves syntax, bind names, columns and privileges only.                                                                                                                                                                                      | The isolated real-Oracle `N -> W` claim/transition test, CHECK constraints, and triggers must be exercised on an authorized isolated Oracle schema (`test/single-kyc-trial.oracle.spec.ts`, `test/oracle-staging.sql.integration.spec.ts`). The seven Oracle tests remain skipped. Never run this on UAT1.                                                                                                                     |
| B4  | `REIS_FINAL_STATUS` values and how FLEXCUBE uses them                   | Finexta           | **Partially resolved** | Abhilash confirmed “Make it CLEAN, PENDING, BLOCKED”, and that the account-creation check is deployed on UAT1 and reads `REIS_FINAL_STATUS`. This is enough to adopt the three names in the design.                                                                                                                                                                                                                                  | Written confirmation or a controlled test of the account-opening rule for CLEAN / PENDING / BLOCKED / NULL: CLEAN allows, PENDING blocks until the final decision, BLOCKED blocks, and NULL blocks. These are expected rules, not tested results. Constraint and trigger text is still not visible to us; until confirmed, the default remains `APPROVED/BLOCKED` and `FLEXCUBE_FINAL_STATUS_VOCABULARY` stays at its default. |
| B5  | Exact-revision callback route, then lift the trial quarantine           | us, after B4      | **Partial**            | Reviewed 18/11/2026 (docs/callback-revision-binding.md): the staging update now REQUIRES the exact `seqNo` (no `MAX(SEQ_NO)` fallback); a callback is applied only when exactly one revision was ever sent under the identity (`kyc_case.revision_count`), otherwise it is quarantined (`RECONCILIATION_REQUIRED`). Delayed, duplicate and out-of-order callbacks are tested with mocks; real-Oracle tests are prepared but skipped. | Safe by quarantine, not by design: REIS returns no per-submission identifier in the callback, so closing B5 needs Vneuron to return one. Trial callbacks stay quarantined until the exact-revision route is verified and evidence is kept.                                                                                                                                                                                     |
| B6  | REJECT mapping (BLOCKED?)                                               | Bank/Compliance   | **Open**               | Nothing decided.                                                                                                                                                                                                                                                                                                                                                                                                                     | Explicit written decision from Samer.                                                                                                                                                                                                                                                                                                                                                                                          |
| B7  | No other sender; backups verified                                       | Bank IT           | **Partially resolved** | The 18/11 deployment report mentions a verified backup and disabled polling; service health was reported and `flexcube.sync.started` was absent.                                                                                                                                                                                                                                                                                     | Proof immediately before the trial that no other sender is active (FLEXCUBE scheduler, manual scripts, or another instance); backups must be re-taken and verified on the trial day.                                                                                                                                                                                                                                           |

### Standing restrictions (unchanged)

- Polling stays disabled (`FLEXCUBE_POLL_ENABLED` not `true`).
- No real KYC is sent, no status (for example CLEAN) is set by hand in `REIS_FINAL_STATUS`, and the 58 historical `E` rows are not reprocessed or reconciled.
- `--mode send` stays refused until every row above is closed with its evidence.

### Order of work

1. Tareq: grant SELECT on `STTM_CUSTOMER` to `REIS_KYC`; then the read-only preflight proves the CIF of this KYC (B1).
2. Vneuron: confirm neither identity exists in REIS UAT (B2).
3. Abhilash: confirm the account-opening rule for CLEAN / PENDING / BLOCKED / NULL, the `MOD_NO` condition, and the key-person type I/C column and values (B4, B1).
4. Samer: decide REJECT handling (B6).
5. Development: run isolated Oracle tests (B3) and complete the exact-revision callback route (B5).

## 4b. Messages ready to send

**Finexta (Abhilash)** — The CIF source is answered: `STTM_CUSTOMER.CUSTOMER_NO`, joined on `KYC_REF_NO`; do not ask for the source again. Please confirm in writing: (1) whether the additional `K.MOD_NO = :seqNo` condition in `docs/finexta-cif-source.sql` is correct or must be dropped; (2) the account-opening behavior for CLEAN / PENDING / BLOCKED / NULL; (3) the CHECK constraints and triggers on `STTM_KYC_REIS_PAYLOAD_CUSTOM`; and (4) which column holds the key-person type I/C and its values (`KYC_KEYPERSON_TYPE` exists in `STTM_KYC_CORP_KEYPERSONS_CUSTOM`, not `STTM_KYC_CORP_KEYPERSONS`).

**Bank IT (Tareq)** — Please grant SELECT on `OBPPRD.STTM_CUSTOMER` to `REIS_KYC` (and provide a synonym like the other KYC tables), then verify that the query returns exactly one CIF, `00005818`, for `KYC_REF_NO = '001ZKYC26151003Y'`. Immediately before the trial, confirm that no other sender is active.

**Compliance (Samer)** — Decide how a REIS REJECT is reflected in FLEXCUBE: BLOCKED or another rule.

**Vneuron (REIS)** — Please confirm: (1) no onboarding/customer exists for systemId `001ZKYC26151003Y` or `00005818` in UAT
(without calling the state-changing onboarding endpoint); (2) that systemId = CIF is accepted, how an update of the same CIF
is handled, and how to avoid a duplicate customer for a record previously sent under the KYC reference; (3) that the
callback carries or allows deriving the KYC revision; (4) the idempotency behavior for a repeated request after a timeout.

## 5. Approval file (blank template; the tool checks the hashes, not the signature)

```json
{
  "approvedBy": "",
  "approvedAt": "<ISO time, valid for 1 hour>",
  "planSha256": "<from the preflight report>",
  "sourceSqlSha256": "<sha256 of the approved CIF SELECT, printed by preflight>",
  "claimSqlSha256": "<printed by preflight>",
  "sourceReference": "<Finexta written confirmation reference>",
  "cifSourceAndJoinVerified": false,
  "cifAvailableBeforeSubmission": false,
  "oldAndCifIdentitiesAbsent": false,
  "reisIdentityCheckReference": "",
  "isolatedOracleClaimTestReference": "",
  "cleanPendingBlockedContractReference": "",
  "exactRevisionCallbackRoutingReference": "",
  "pollingAndOtherSendersStopped": false,
  "backupsVerified": false,
  "rejectToBlockedApproved": false
}
```

## 6. Deployment of the reviewed build (no polling, no send)

Follow `docs/deployment-uat1.md` exactly (stop the `--watch` service first, polling off, backup with
`npm run backup:sqlite`, build, test, start, verify, rollback plan). Deploying this build does not enable any send path:
the CIF hold and the trial gates remain.
