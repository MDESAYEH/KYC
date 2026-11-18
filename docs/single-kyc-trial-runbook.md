# Single-record trial runbook (KYC 001ZKYC26151003Y, MOD_NO 2) — FOR REVIEW, NOT EXECUTED

Status 17/11/2026: **local preparation only.** Nothing in this document has been run against UAT1 or REIS.
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
   `CIF_VALUE`). Without it: `FINEXTA_CIF_SQL_NOT_SUPPLIED`. `00005804` is only compared, never used as a source.

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

What step 2 would change: one INSERT + one claim on staging row (KYC 001ZKYC26151003Y, SEQ_NO 2), one local case, **one**
REIS onboarding call with the CIF as `systemId`, the raw response recorded, `PROCESS_STATUS = S` and `REIS_FINAL_STATUS`
(CLEAN / PENDING, or BLOCKED only if REJECT→BLOCKED was approved) on exactly SEQ_NO 2. No retry, no requeue, no other row.
If the response is lost: `E`/uncertain, **no resend**; a person reconciles with REIS.

## 4. Blockers (evidence required before any send)

Status as of 18/11/2026 (nothing below is "closed" until its evidence exists; no step is claimed as passed):

| #   | Blocker                                                                                                                                                                                                               | Owner             | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | CIF source/table/column/join, type, leading zeros, and that CIF `00005804` belongs to this KYC; available before the first REIS call                                                                                  | Finexta + bank IT | **PARTIAL.** Confirmed by Abhilash: `OBPPRD.STTM_CUSTOMER`, column `CUSTOMER_NO`, join `KYC_REF_NO`, conditions `KYC_DETAILS='V'`, `RECORD_STAT='O'`, `AUTH_STAT='A'`, related KYC open and authorized, CIF must exist before sending. **Not verified:** the CIF of `001ZKYC26151003Y`. Our `REIS_KYC` account got `ORA-00942` on `STTM_CUSTOMER` (no SELECT grant; Tareq asked to verify). `K.MOD_NO = :seqNo` in `docs/finexta-cif-source.sql` is a development addition, not in Abhilash's query: he must confirm it or we drop it. Closed only when the query returns exactly one CIF equal to `00005804`. No need to ask Abhilash for the source again |
| B2  | REIS has neither the old identity (`001ZKYC26151003Y`) nor the CIF; check without state-changing calls                                                                                                                | Vneuron/REIS ops  | **OPEN.** No confirmation from Noureddine                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| B3  | Real Oracle check of the claim SQL on an authorized disposable schema (`test/single-kyc-trial.oracle.spec.ts` and `test/oracle-staging.sql.integration.spec.ts`, skipped until then)                                  | Bank IT + Finexta | **PARTIAL.** Reported 30/30 read-only dictionary checks passed; the isolated real-Oracle `N -> W` claim/transition test has NOT run (the 7 Oracle tests stay skipped)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| B4  | `REIS_FINAL_STATUS` accepts and FLEXCUBE reads CLEAN / PENDING / BLOCKED (constraint + triggers + consuming logic); until then the default stays `APPROVED/BLOCKED`                                                   | Finexta           | **PARTIAL.** Abhilash confirmed CLEAN / PENDING / BLOCKED in writing ("Make it CLEAN, PENDING, BLOCKED") and that the account-creation check is deployed on UAT1 and reads `REIS_FINAL_STATUS`; that is enough to adopt the names in the design. Still required: confirmation or a controlled test of account opening per status: CLEAN allows, PENDING blocks, BLOCKED blocks, NULL blocks (expected rules, not tested results). Constraint/trigger text is still not visible to us                                                                                                                                                                        |
| B5  | Exact-revision callback route verified, then the quarantine lifted (`FLEXCUBE_FINAL_STATUS_VOCABULARY=clean-pending-blocked` + `seqNo` update are implemented and unit-tested, not integrated for the trial identity) | us, after B4      | **OPEN.** Binding of the REIS answer to the right revision and update of the intended row only is unproven end to end; callbacks of the trial identity stay quarantined                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| B6  | REJECT mapping (BLOCKED?) approved explicitly                                                                                                                                                                         | Bank/Compliance   | **OPEN.** Decision from Samer (Compliance)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| B7  | Other senders (FLEXCUBE scheduler, manual calls) stopped; backups verified (`npm run backup:sqlite`)                                                                                                                  | Bank IT           | **PARTIAL.** The deployment report mentions a backup and disabled polling; that no other sender is active is not proven                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Unchanged prohibitions until every row is closed with evidence: do not enable polling, do not send a real KYC, do not set
CLEAN by hand, do not reprocess the 58 historical `E` rows.

Order of work: (1) Tareq: SELECT on `STTM_CUSTOMER`, then verify the CIF of the record; (2) Noureddine: confirm neither
identity exists in REIS; (3) Abhilash: written account-opening rule for CLEAN / PENDING / BLOCKED / NULL and the `MOD_NO` condition;
(4) Samer: REJECT; (5) development: isolated Oracle tests and the exact-revision callback.

## 4b. Messages ready to send

**Finexta (Abhilash)** — The CIF source is answered (STTM_CUSTOMER.CUSTOMER_NO, join KYC_REF_NO): do not ask again. Please confirm in writing: (1) that our additional condition `K.MOD_NO = :seqNo` (docs/finexta-cif-source.sql) is correct, or that it must be dropped; (2) the account-opening rule per REIS_FINAL_STATUS: CLEAN allows, PENDING blocks, BLOCKED blocks, NULL blocks; (3) which column holds the key-person type I/C (`KYC_KEYPERSON_TYPE` exists in `STTM_KYC_CORP_KEYPERSONS_CUSTOM`, not in `STTM_KYC_CORP_KEYPERSONS`) and its values. **Tareq (bank IT)** — Please grant SELECT on OBPPRD.STTM_CUSTOMER to REIS_KYC, then we verify that the query returns exactly one CIF, 00005804, for KYC_REF_NO 001ZKYC26151003Y.

**Vneuron (REIS)** — Please confirm: (1) no onboarding/customer exists for systemId `001ZKYC26151003Y` or `00005804` in UAT
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
