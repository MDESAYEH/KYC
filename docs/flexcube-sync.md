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
`STTM_KYC_CORP_KEYPERSONS_CUSTOM` (not `STTM_KYC_CORP_KEYPERSONS`) that holds the party type `I` / `C`. UAT1 read-only
check (17/11/2026): `KYC_KEYPERSON_TYPE` exists in `OBPPRD.STTM_KYC_CORP_KEYPERSONS_CUSTOM` and not in
`OBPPRD.STTM_KYC_CORP_KEYPERSONS`, so the SELECT reads `cu.<column>`. Its values and meaning are still to be
confirmed (discovery part D); a key person without a CUSTOM row is a validation error. If Finexta names another
column only `.env` changes.
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

### Rows closed as E by the ORA-01745 incident (17/11/2026)

The first version of the fix turned 58 untouched rows into `E` (`RESPONSE = {"error":"ORA-01745"}`, no `REQUEST`). They are
kept as history. The reconciliation tool that could put them back to `N` was removed on 19/11/2026: those rows used
`SEQ_NO = KYC MOD_NO`, while the trigger-table flow uses `SEQ_NO = CIF MOD_NO` (`docs/customer-trigger-table.md`). When
FCUBS sets such a customer to `U` again, it is handled by that flow, not by a restore.

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

## Send guard: an uncertain delivery stops all sending

A delivery is uncertain when REIS may have received the request but no result was stored: a REIS timeout / network
error / 5xx after the call (`requestMayHaveReachedReis`), an unexpected error during the submission, a result that could
not be written to the staging table (row left in progress), or a duplicate whose earlier delivery was uncertain. Then:

- the row is closed as `E` with `"delivery":"UNCERTAIN"` in `RESPONSE` (or stays in progress), and is never resent;
- the current pass stops and no further KYC is sent (`flexcube.sync.haltingAfterUncertainDelivery`);
- every later pass, also after a restart, first looks for such rows of ours (and for our rows claimed more than 5 minutes
  ago) and sends nothing while one is unresolved or the check itself fails (`flexcube.sync.sendingHalted`, counts only);
- an operator reconciles with Vneuron (did REIS receive it?) and then lists the row in
  `FLEXCUBE_SYNC_UNCERTAIN_ACK=KYC_REF_NO:SEQ_NO`; sending resumes for the others, never for that row.

A failure known to happen before REIS (validation, missing details) does not stop the others.

## Parse-only Oracle check (`npm run check:oracle-sql`)

Every statement the integration can send (catalog built from the real code: polling source, staging repository,
reconciliation and rollback, final-status updater, single-KYC trial) is handed to Oracle's parser with
`connection.getStatementInfo()`. Nothing is executed, read, changed or committed; DDL, PL/SQL, MERGE and DELETE are refused
before Oracle is called. For each statement it reports OK, the Oracle code (e.g. ORA-01745, ORA-00904, ORA-00942) or the
difference between the bind names Oracle sees and the ones the code sends. This is the UAT1 evidence for the ORA-01745 fix
without any UPDATE / ROLLBACK on the bank database. The N -> W transition and CHECK constraints are tested on an isolated
Oracle schema only (`test/oracle-staging.sql.integration.spec.ts`, skipped unless explicitly enabled).
