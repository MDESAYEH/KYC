# Single-record trial runbook (KYC 001ZKYC26151003Y, MOD_NO 2) — FOR REVIEW, NOT EXECUTED

Status 17/11/2026: **local preparation only.** Nothing in this document has been run against UAT1 or REIS.
Polling stays disabled. The 58 historical `E` rows are never touched. No commit, push or deployment is implied.

## 1. What exists (local, tested with synthetic Oracle / in-memory SQLite / fake HTTP REIS)

| Piece | File | State |
| --- | --- | --- |
| Fixed scope (one KYC + revision, reported CIF is comparison-only) | `src/kyc/single-kyc-trial.scope.ts` | done |
| Approval contract (named approver, hashes, evidence references, 1 h validity) | `src/tools/single-kyc-trial.contract.ts` | done |
| Exact-revision staging SQL (claim, intent, completion, status) | `src/tools/single-kyc-trial.repository.ts` | done, **Oracle SQL unverified on real Oracle** |
| Read-only plan / single send / readback, raw REIS response capture | `src/tools/single-kyc-trial.ts`, `.transport.ts`, `run-single-kyc-trial.ts` | done |
| Callback quarantine for the trial identities (old KYC ref and CIF) | `src/webhook/customer-status.service.ts` | active |
| Status vocabulary (opt-in) and exact-revision (`seqNo`) final-status update | `staging/flexcube-staging.ts`, `staging-flexcube-status-updater.ts` | done, **default unchanged** |

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

| # | Blocker | Owner |
| --- | --- | --- |
| B1 | CIF source/table/column/join, type, leading zeros, and that CIF `00005804` belongs to this KYC; available before the first REIS call | Finexta |
| B2 | REIS has neither the old identity (`001ZKYC26151003Y`) nor the CIF; check without state-changing calls | Vneuron/REIS ops |
| B3 | Real Oracle check of the claim SQL on an authorized disposable schema (`test/single-kyc-trial.oracle.spec.ts` and `test/oracle-staging.sql.integration.spec.ts`, skipped until then) | Bank IT + Finexta |
| B4 | `REIS_FINAL_STATUS` accepts and FLEXCUBE reads CLEAN / PENDING / BLOCKED (constraint + triggers + consuming logic); until then the default stays `APPROVED/BLOCKED` | Finexta |
| B5 | Exact-revision callback route verified, then the quarantine lifted (`FLEXCUBE_FINAL_STATUS_VOCABULARY=clean-pending-blocked` + `seqNo` update are implemented and unit-tested, not integrated for the trial identity) | us, after B4 |
| B6 | REJECT mapping (BLOCKED?) approved explicitly | Bank/Compliance |
| B7 | Other senders (FLEXCUBE scheduler, manual calls) stopped; backups verified (`npm run backup:sqlite`) | Bank IT |

## 4b. Messages ready to send

**Finexta (Abhilash)** — Please confirm in writing: (1) the table and column that hold the customer CIF and the exact join from
`STTM_KYC_MASTER.KYC_REF_NO`; its data type and whether leading zeros are stored; (2) that CIF `00005804` is the CIF of
KYC_REF_NO `001ZKYC26151003Y` and exists before the KYC is sent to REIS; (3) the CHECK constraints and triggers on
`STTM_KYC_REIS_PAYLOAD_CUSTOM`, and that `REIS_FINAL_STATUS` may hold CLEAN, PENDING and BLOCKED and that FLEXCUBE reads them
(blocking account activation on PENDING and BLOCKED); (4) which column holds the key-person type I/C in
`STTM_KYC_CORP_KEYPERSONS` (the expected `KYC_KEYPERSON_TYPE` does not exist; `OWNERSHIP_TYPE` does).

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
