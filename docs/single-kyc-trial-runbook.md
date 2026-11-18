# Single-record trial runbook (KYC 001ZKYC26151003Y, MOD_NO 2) — FOR REVIEW, NOT EXECUTED

Status 17/11/2026: **local preparation only.** Nothing in this document has been run against UAT1 or REIS.
Update 18/11/2026: build `f641768` deployed on UAT1 with polling off; `check:oracle-sql` parsed 30/30 statements. The
blocker status is in section 4: none is closed, so no send is allowed.
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

## 4. Blockers (evidence required before any send) — status 18/11/2026

"Partially resolved" means information was received but the evidence the gate needs does not exist yet. **No blocker is
closed.** Nothing below has been tested by a send, and none of it may be assumed to work.

| # | Blocker | Owner | Status 18/11/2026 | What is known | What is still required to close it |
| --- | --- | --- | --- | --- | --- |
| B1 | CIF source, join and value for this KYC, available before the REIS call | Finexta + Bank IT | **Partially resolved** | Abhilash (17/11) gave the source: `OBPPRD.STTM_CUSTOMER.CUSTOMER_NO`, joined on `KYC_REF_NO`, customer `KYC_DETAILS='V'`, `RECORD_STAT='O'`, `AUTH_STAT='A'`, related KYC open and authorized; the CIF must exist before the KYC is sent. Adapted query: `docs/finexta-cif-source.sql`. The extra `K.MOD_NO = :seqNo` condition was added by development to target revision 2 and was **not** in Abhilash's query. | `REIS_KYC` gets `ORA-00942` on `STTM_CUSTOMER`: SELECT grant / synonym requested from Tareq. Then the read-only preflight must return **exactly one** CIF for `001ZKYC26151003Y`, equal to `00005804`, with the data type and leading zeros recorded. Abhilash to confirm (or reject) the `MOD_NO` condition in writing. |
| B2 | REIS UAT holds neither `001ZKYC26151003Y` nor `00005804` | Vneuron | **Open** | Nothing received. | Written confirmation from Vneuron, obtained without any state-changing REIS call. |
| B3 | Real Oracle check of the staging / trial SQL | Bank IT + dev | **Partially resolved** | `npm run check:oracle-sql` on UAT1 (18/11, build `f641768`): **30/30 statements parsed** by Oracle on the real objects, including `trial.claim`, `trial.storeIntent`, `trial.writeWireStatus`, `trial.complete`; nothing executed. This proves syntax, bind names, columns and privileges only. | The N -> claimed transition, CHECK constraints and triggers must be exercised on an authorized **isolated** Oracle schema (`test/single-kyc-trial.oracle.spec.ts`, `test/oracle-staging.sql.integration.spec.ts`), never on UAT1. Not run yet. |
| B4 | `REIS_FINAL_STATUS` values and how FLEXCUBE uses them | Finexta | **Partially resolved** | Abhilash: "Yes Make it CLEAN, PENDING, BLOCKED". He reported that the account-creation check is deployed on UAT1 and reads `REIS_FINAL_STATUS`. Enough to adopt the three names in the design. | Written confirmation (or a controlled UAT test by Finexta) of the account-opening rule for each value: CLEAN = allowed, PENDING = blocked until the final decision, BLOCKED = blocked, NULL = blocked until a result arrives. These are the expected rules, **not** tested results. Until then `FLEXCUBE_FINAL_STATUS_VOCABULARY` stays at its default. |
| B5 | Exact-revision callback route, then lift the trial quarantine | dev, after B4 | **Open** | Vocabulary and `seqNo` update implemented and unit-tested, not integrated for the trial identity. | Callback mapped to the exact KYC revision, updating only the intended staging row; reviewed; only then lift `EXACT_REVISION_CALLBACK_ROUTE_NOT_IMPLEMENTED`. |
| B6 | REJECT -> BLOCKED mapping | Compliance (Samer) | **Open** | Nothing decided. | Explicit written decision. |
| B7 | No other sender; backups verified | Bank IT | **Partially resolved** | Deployment 18/11: backup `/root/kyc-backup-20261118-100604` (SQLite snapshot `integrity: ok`, SHA-256 recorded), polling off (`flexcube.sync.started` absent), service healthy. | Proof that no other sender is active (FLEXCUBE scheduler, manual scripts, another instance) immediately before the trial; backups re-taken and verified on the day of the trial. |

### Standing restrictions (unchanged)

- Polling stays disabled (`FLEXCUBE_POLL_ENABLED` not `true`).
- No real KYC is sent, no status (e.g. CLEAN) is set by hand in `REIS_FINAL_STATUS`, and the 58 historical `E` rows are
  not reprocessed or reconciled.
- `--mode send` stays refused until every row above is closed with its evidence.

### Order of work

1. Tareq: SELECT on `STTM_CUSTOMER` for `REIS_KYC`; then the read-only preflight proves the CIF of this KYC (B1).
2. Vneuron: confirm neither identity exists in REIS UAT (B2).
3. Abhilash: confirm the account-opening rule for CLEAN / PENDING / BLOCKED / NULL, and the `MOD_NO` condition (B4, B1).
4. Samer: REJECT handling (B6).
5. Development: isolated Oracle tests (B3) and the exact-revision callback route (B5).

## 4b. Messages ready to send

**Finexta (Abhilash)** — The CIF source is answered (17/11), and CLEAN / PENDING / BLOCKED is confirmed. Still needed, in
writing: (1) whether the CIF query must also be tied to the KYC revision (`K.MOD_NO = :seqNo`), or not; (2) the
account-opening behavior of the deployed check for each `REIS_FINAL_STATUS` value: CLEAN allowed, PENDING blocked until
the final decision, BLOCKED blocked, NULL (no result yet) blocked, or the actual rule if different; (3) the CHECK
constraints and triggers on `STTM_KYC_REIS_PAYLOAD_CUSTOM`.

**Bank IT (Tareq)** — SELECT on `OBPPRD.STTM_CUSTOMER` (and a `REIS_KYC` synonym, like the other KYC tables) for the
`REIS_KYC` user: it currently returns ORA-00942. Then confirm, just before the trial, that no other sender is active.

**Compliance (Samer)** — Decide how a REIS REJECT is reflected in FLEXCUBE (BLOCKED or another rule).

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
