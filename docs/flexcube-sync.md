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
While the column is wrong, a corporate KYC ends as `E` with the `ORA-00904` code and individuals keep flowing.

## UAT check diagnostics (`npm run check:uat1`, read-only)

Besides the connection, tables and columns, the report (console and `uat1-check-report.json`, no customer
data) shows, all with SELECT only:

- the CHECK constraints (`ALL_CONSTRAINTS`, type `C`: name and search condition) and the triggers
  (`ALL_TRIGGERS`: name, type, event, status) of the staging table: where to look when a claim (`N -> W`) fails;
- the rows per `PROCESS_STATUS`, split into ours (UUID `MSGID`) and others (e.g. Finexta test rows);
- the pending KYCs with the current `FLEXCUBE_SYNC_START_DATE`, and the latest `MAKER_DT_STAMP` per branch
  (first 3 characters of `KYC_REF_NO`), to choose the cut-off on UAT.

## Recovery of stuck rows

At the start of every pass:

- **Rows left at `N`** by an earlier failed pass are processed first through the same claim -> load ->
  submit path (no second INSERT). Only our own rows qualify: `MSGID` in UUID format, `REQ_DATE IS NULL`,
  `REQUEST IS NULL`, and `KYC_REF_NO` / `SEQ_NO` matching an open KYC in `STTM_KYC_MASTER` since the
  cut-off. A row with any other `MSGID` (for example Finexta's `TEST123`) is never touched.
- **Rows stuck in the in-progress status** for more than 15 minutes (our own `MSGID`) are only logged
  (`flexcube.sync.stuckInProgress`, `kycRefNo`, `seqNo`, once per process and row). They are never resent
  automatically: the submission may already have reached REIS.

## Errors never stop the pass

Any error after the pending query is handled for that KYC only: it is logged
(`flexcube.sync.kycFailed`: `kycRefNo`, `seqNo`, step `insert | claim | load | submit | complete`, and the
Oracle code such as `ORA-02290`, never the message, SQL, binds or customer data), the staging row is
marked `E` (`RETRY_COUNT + 1`, `RES_DATE`, `RESPONSE = {"error": "<code>"}`) when possible, and the next
KYC is processed. If marking `E` fails too (`flexcube.sync.markErrorFailed`) the pass still continues.
Only an error in the pending query itself fails the whole pass (`flexcube.sync.failed`).
