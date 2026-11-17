# FLEXCUBE sync (polling) and staging table

Agreed architecture: FLEXCUBE never calls the integration layer. The integration layer reads
FLEXCUBE, calls REIS, and writes the result to the FLEXCUBE staging table. FLEXCUBE (Finexta)
authorizes the KYC from `REIS_FINAL_STATUS`.

## Flow (one pass every `FLEXCUBE_POLL_INTERVAL_MS`, default 2 minutes)

1. `STTM_KYC_MASTER`: open KYCs (`RECORD_STAT = 'O'`, type R or C, `MAKER_DT_STAMP >= FLEXCUBE_SYNC_START_DATE`)
   whose `MOD_NO` has no staging row yet. `AUTH_STAT` is NOT filtered: FLEXCUBE no longer blocks
   KYC authorization (the check moved to account level), so a KYC may already be authorized (`A`)
   when it is first seen.
2. Insert `STTM_KYC_REIS_PAYLOAD_CUSTOM` row: `KYC_REF_NO`, `SEQ_NO = MOD_NO`, new `MSGID`,
   `PROCESS_STATUS = N`, then claim it (`N -> W`, `REQ_DATE = SYSDATE`).
3. Read the STTM detail tables (mapping V2_5), validate, map, send to REIS (`systemId = KYC_REF_NO`).
4. `PROCESS_STATUS = S` with `REQUEST` / `RESPONSE` JSON, or `E` (+1 `RETRY_COUNT`, technical
   error code only in `RESPONSE`); `RES_DATE = SYSDATE` in both cases.
5. Final decision in `REIS_FINAL_STATUS` (latest `SEQ_NO`):
   - CLEAN -> `APPROVED`, REJECT -> `BLOCKED`, written at once (Reis sends no webhook);
   - PENDING -> written when the `/customerStatus` webhook arrives (CUSTOMER -> `APPROVED`).
   The result is still written to the staging table, but it no longer gates KYC authorization.

An amendment (new `MOD_NO`) is a new `SEQ_NO`; it is sent to REIS with the same `systemId`
(Reis: treated as an update) once the previous submission is closed.

## Related parties (corporate customers only)

For a corporate KYC the source reads `STTM_KYC_CORP_KEYPERSONS` LEFT JOIN
`STTM_KYC_CORP_KEYPERSONS_CUSTOM` on `KYC_REF_NO + KYC_ID + NAME` (read-only, bind variables) and
sends the key persons in `relations` of the same REIS call:

- type `I` -> formId 3: `first_name` / `last_name` = CUSTOM `FIRST_NAME` / `LAST_NAME`,
  `cus_birth_date` = `DATE_OF_BIRTH`, `nationality` = `NATIONALITY`, `citizenship` = `ADDRESS_COUNTRY`,
  `birth_place` = `PLACE_OF_BIRTH`, `nid` = `PASSPORT_NUMBER`, `tin` = `PASS`,
  `issue_date` = `PASSPORT_ISSUE_DATE`, `valid_until` = `PASSPORT_EXPIRY_DATE`,
  `issue_place` = `PLACE_OF_ISSUE`, `national_id` = `NATIONAL_ID`.
  `nid`, `issue_date` and `valid_until` are mandatory (REIS V1.5); `national_id` is optional.
- type `C` -> formId 4: `business_name` = `NAME`, `nationality` = `ADDRESS_COUNTRY`, `trade_no` = `TIN`.
- `RELATIONSHIP` -> REIS id: AUTHORIZED 1, BENEFICIAR 2, CEO 3, CFO 4, COOWNER 5, MANAGER 6, OWNER 7,
  SHAREHOLDE 8 (`src/flexcube/related-party.ts`). Type `C` accepts only 2, 5, 7, 8.
- systemId of a related party = `<company KYC_REF_NO>-<KYC_ID>` (both trimmed; `KYC_ID` is free input).

The whole request is rejected before REIS (staging `E`, technical code only) when: a code is unknown
or not allowed for the party type, `KYC_ID` is blank, two parties share a systemId, an individual's
CUSTOM row is missing, or a mandatory field is missing. Error messages name the field, never the value.

## Not done yet / to confirm

- Confirm on UAT1: `RECORD_STAT` values ('O' = open) and `MAKER_DT_STAMP` in `STTM_KYC_MASTER`.
- SQL is PROVISIONAL (`src/flexcube/source/flexcube-kyc.queries.ts`): verify on UAT1
  (`MOD_NO` as `SEQ_NO`, join keys, column names).
- `E` rows are not retried automatically: Finexta set no limit; the Bank decides the retry policy.
- Related parties: confirm the key-person column names on UAT1 (checked by `npm run check:uat1`) and
  that the two key-person tables hold the current rows only (no modification number is used).
- Customer identifier (customer number vs KYC reference) decision pending with the Bank / Reis.

## Configuration

`FLEXCUBE_DB_USER`, `FLEXCUBE_DB_PASSWORD`, `FLEXCUBE_DB_CONNECT_STRING` (host:port/SERVICE),
`FLEXCUBE_STAGING_TABLE` (optional), `FLEXCUBE_POLL_ENABLED=true`, `FLEXCUBE_POLL_INTERVAL_MS`
(60000-300000), `FLEXCUBE_POLL_BATCH_SIZE` (1-200), `FLEXCUBE_SYNC_START_DATE` (mandatory when polling is enabled:
ISO date `2026-11-16` or timestamp `2026-11-16T08:00:00`, no time-zone suffix; startup fails with a
config error when missing or invalid, so historical KYCs are never sent by accident). The database user needs SELECT on the STTM
tables and INSERT / UPDATE (no DELETE) on the staging table.

`FLEXCUBE_STAGING_STATUS_IN_PROGRESS` (default `W`, one uppercase letter) is the `PROCESS_STATUS` of a
claimed row, so it can follow Finexta's CHECK constraint on the staging table without a code change.
The claim stays conditional (only from `N`), so two instances never send the same KYC.

`FLEXCUBE_KEYPERSON_TYPE_COLUMN` (default `KYC_KEYPERSON_TYPE`, a plain Oracle identifier) names the column of
`STTM_KYC_CORP_KEYPERSONS` that holds the party type `I` / `C`. UAT1 has no `KYC_KEYPERSON_TYPE` column
(`OWNERSHIP_TYPE` exists) and Finexta has not said which column to use; when they answer only `.env` changes.
The SELECT aliases it back to `KYC_KEYPERSON_TYPE`, and `npm run check:uat1` checks the configured column.
Corporate KYCs are only selected while that column is proven to exist (a metadata check, repeated every
10 minutes, `flexcube.sync.corporateDisabled` when it is missing): without it no corporate KYC is claimed, no row is
written and nothing is sent. Individuals keep flowing. Never replace the column by a guess (`OWNERSHIP_TYPE`):
only Finexta can confirm it.

## SQL bind variable names (ORA-01745)

UAT1, 17/11/2026: the claim `UPDATE` failed for every KYC with **ORA-01745** (invalid host/bind variable name)
because it used the bind variables `:to` and `:from`, which are Oracle reserved words (`complete()` used `:from`
too). The names are now `targetStatus`, `sourceStatus`, `initialStatus`, `responseJson`, ... and every statement
is checked by `assertValidBinds` (`src/flexcube/staging/sql-binds.ts`) before it reaches Oracle: no reserved word,
and the placeholders must match the supplied binds exactly. The in-memory test databases apply the same check, and
`test/oracle-staging.sql.integration.spec.ts` runs the staging statements (and reproduces ORA-01745) on a real,
isolated Oracle schema when the person running it sets the `KYC_ORACLE_TEST_*` variables (skipped otherwise).
The cause is considered proven only after that test passes on Oracle; until then it is the best-supported cause.

## Failures never damage a staging row

A failure is classified (`src/flexcube-sync/flexcube-sync.service.ts`) and the class decides what happens to the row:

| Failure | Example | Row | Retried |
| --- | --- | --- | --- |
| **technical** at the INSERT / claim | ORA-01745, ORA-02290, ORA-01031, ORA-00942, lost connection | stays `N` (never `E`) | recovered by the next pass |
| **technical** while reading the KYC | Oracle error in a detail query | released `W -> N` (only while `REQUEST` is empty) | recovered by the next pass |
| **data** | the KYC detail rows do not exist | `E`, `RESPONSE = {"error": "<code>"}` | no |
| **uncertain delivery** | the submission step threw, REIS may have been called | `E`, `RESPONSE = {"error": "<code>", "delivery": "UNCERTAIN"}` | never automatically: needs reconciliation |
| **recording** | REIS answered but `S` / `E` could not be written | stays in progress, reported as stuck after 15 min | never: a resend could duplicate |

A technical failure means the database or the code failed, not the KYC, and nothing was sent. If releasing or marking
fails too the failure is logged (`action` `release_failed` / `mark_error_failed`) and the pass continues.

**Circuit breaker.** Three technical failures in a row stop the pass and open the breaker: the next passes do nothing
(`flexcube.sync.circuitOpen`) for 5 minutes, doubling up to 60 minutes while the probe keeps failing. A KYC processed
without a technical failure closes it. So a systemic fault touches three rows, not the whole batch.

**Restart safety.** A crash after the INSERT leaves `N` (recovered once). A crash after the claim leaves `W`: it is
never resent, only reported. Insert and claim are conditional, so two instances never send the same KYC.

## Recovery of stuck rows

At the start of every pass:

- **Rows left at `N`** by an earlier failed pass are processed first through the same claim -> load -> submit path (no
  second INSERT). Only our own rows qualify: `MSGID` in UUID format, `REQ_DATE IS NULL`, `REQUEST IS NULL`, and
  `KYC_REF_NO` / `SEQ_NO` matching an open KYC in `STTM_KYC_MASTER` since the cut-off. A row with any other `MSGID`
  (for example Finexta's `TEST123`) is never touched.
- **Rows stuck in the in-progress status** for more than 15 minutes (our own `MSGID`) are only reported
  (`flexcube.sync.stuckInProgress`, counts only). They are never resent: the submission may already have reached REIS.

### Rows closed as E by the ORA-01745 incident (reconciliation, never automatic)

The first version of the fix turned 58 untouched rows into `E` (`RESPONSE = {"error":"ORA-01745"}`, no `REQUEST`, no
`REQ_DATE`). `npm run reconcile:staging` (alias `npm run staging:requeue`) can put them back to `N`. It is built to be
audited and reversed, and it never runs by itself.

**Evidence, in two separate layers.**

- *Programmatic* (what the code proves): the row is ours (UUID `MSGID`), `E`, `RETRY_COUNT = 1`, no `REQUEST` / `REQ_DATE` /
  `REIS_FINAL_STATUS`, `RESPONSE` is exactly the marker of an allowed Oracle code, and its KYC is still open at the same
  `MOD_NO` since the cut-off. In this application the claim comes before the read and the REIS call, so a claim that
  never succeeded means no REIS call from this code path. In addition the integration layer's own database must hold
  **no case and no REIS callback** for the KYC.
- *Operational* (what only people can confirm): the local SQLite file could have been replaced or restored, another
  instance or a manual call could have sent the request, and a sender outside this application (for example a FLEXCUBE
  scheduler, open question N24) is not visible to the code. So applying needs an **attestation file**, bound by hash to the
  exact list, in which a named approver states that REIS was checked for those systemIds, that no other sender was
  active, and that the local database is the continuous one (and, if it has no case at all, acknowledges that an empty
  database proves nothing). It is refused when stale (> 72 h), in the future, or written for another list.

**Procedure** (Oracle is read-only until step 4; exports and backups write protected local files):

Keep polling disabled on every instance and suspend all other senders throughout reconciliation and rollback.
Use a restricted directory (0700 on Linux, an explicit restricted ACL on Windows); file mode 0600 alone does not set Windows ACLs.

1. `npm run reconcile:staging -- --export-candidates /secure/path/candidates.csv` (dry run). It prints counts, the evidence and
   the **hash of the eligible list**, and writes the list (mode 600, must not exist) for the REIS-side check.
2. People check REIS for those systemIds and write the attestation:
   ```json
   {
     "approvedBy": "Name Surname",
     "approvedAt": "2026-11-17T10:00:00Z",
     "candidateListSha256": "<hash printed by the dry run>",
     "reisChecked": true,
     "reisCheckMethod": "REIS portal search by systemId for every row of candidates.csv",
     "noOtherSender": true,
     "localDatabaseIsContinuous": true
   }
   ```
3. Back up the local database: `npm run backup:sqlite -- /secure/path/kyc-local-<stamp>.sqlite`.
4. `KYC_RECONCILE_CONFIRM=RESTORE_NEVER_SENT_ROWS npm run reconcile:staging -- --apply --backup-file /secure/path/backup-<stamp>.json --attestation /secure/path/attestation.json`.

**What `--apply` does.** It re-checks everything, then writes and **verifies a full backup** of the original rows before any
UPDATE: one JSON file (mode 600, never overwritten, flushed, read back) with every value the rollback needs (status,
request, response, retry count, REQ_DATE, RES_DATE, final status, MSGID) and a manifest (row count, SHA-256 of the rows,
list hash, the attestation and its hash, local-database facts). Then one conditional UPDATE per row, and the UPDATE repeats the
**whole** eligibility predicate (ownership of the MSGID, status, counters, empty request, KYC open at the same `MOD_NO`, type,
cut-off, exact RESPONSE marker), plus the exact backed-up MSGID and RES_DATE: a row that changed after it was selected is not touched. Concurrency tests cover every
condition.

**Rollback** (audited, same discipline): `npm run reconcile:staging -- --rollback /secure/path/backup-<stamp>.json` is a dry run;
with `--apply` and `KYC_ROLLBACK_CONFIRM=ROLLBACK_RECONCILIATION` it puts the saved values back for each row that is still in the
exact post-restore state. A row the service has claimed or sent since is left alone (a person decides). Accidental backup corruption is detected by hashes; these are not a digital signature and do not protect against an attacker who can rewrite the file and its hashes. Restrict access to the backup and approval files. Keep every backup and attestation: together they are the audit trail.

After a restore the service sends the rows by itself on its next pass, so enable polling only afterwards and on purpose.
The reconciliation was tested only against the in-memory test database; it has **not** been run on Oracle.

## UAT check diagnostics (`npm run check:uat1`, read-only)

Besides the connection, tables and columns, the report (console and `uat1-check-report.json`, no customer data) shows,
all with SELECT only:

- the CHECK constraints (`ALL_CONSTRAINTS`, type `C`) and the triggers (`ALL_TRIGGERS`) of the staging table: where to look
  when a claim (`N -> W`) fails;
- the rows per `PROCESS_STATUS`, split into ours (UUID `MSGID`) and others (e.g. Finexta test rows);
- our rows against the current KYC versions (kind x state: matches the current `MOD_NO`, `MOD_NO` changed, not open, before
  the cut-off, no master): how many the service recovers by itself, how many `E` rows were never sent (and their technical
  marker), how many need a manual look;
- whether the configured key-person type column exists and which columns of `STTM_KYC_CORP_KEYPERSONS` have TYPE in their
  name (candidates to ask Finexta about; nothing is guessed);
- the pending KYCs with the current `FLEXCUBE_SYNC_START_DATE` and the latest `MAKER_DT_STAMP` per branch (first 3
  characters of `KYC_REF_NO`), to choose the cut-off on UAT.

## Logs (no customer data)

Every pass has a `runId` (random UUID). Events: `flexcube.sync.run` (`runId`, `durationMs`, `found`, `sent`, `failed`,
`skipped`, `technicalFailures`, `recovered`, `lastSuccessfulRunAt`), `flexcube.sync.kycFailed` (`runId`, `item`, `step`,
`kind`, `action`, Oracle `error` code), `flexcube.sync.failed` (`runId`, `phase`, `durationMs`, `error`),
`flexcube.sync.circuitOpened` / `circuitOpen`, `flexcube.sync.stuckInProgress`, `flexcube.sync.corporateDisabled`.
Logs never contain a KYC reference, a name, a payload, an error message, SQL or a bind value.
