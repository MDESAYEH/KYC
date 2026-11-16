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
