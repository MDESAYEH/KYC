# FLEXCUBE sync (trigger-table poller)

FLEXCUBE never calls the integration layer. The poller reads FLEXCUBE, calls REIS and writes the result to the staging
table `STTM_KYC_REIS_PAYLOAD_CUSTOM`. FCUBS allows account opening only when `REIS_FINAL_STATUS = CLEAN` on the row with
the highest `SEQ_NO` of the KYC. Trigger table contract: [customer-trigger-table.md](customer-trigger-table.md).

## One pass (every `FLEXCUBE_POLL_INTERVAL_MS`, default 10 s)

`FlexcubeSyncScheduler` runs `TriggerSyncService.runOnce()`; the next pass starts `FLEXCUBE_POLL_INTERVAL_MS` after the
previous one ended, so two passes never overlap. A failing pass is logged and the next one runs normally.

1. **Stale claims**: our rows (UUID `MSGID`) left at `W` for more than 5 minutes (the process died, possibly during the
   REIS call) go back to `N` with `RETRY_COUNT + 1`.
2. **New revisions**: `STTM_CUSTOMER_CUSTOM` rows at `U`, joined to `STTM_CUSTOMER` (CIF `MOD_NO` = staging `SEQ_NO`) and
   the open `STTM_KYC_MASTER` row (created since `FLEXCUBE_SYNC_START_DATE` when it is set).
3. **Retries due**: our `N` rows with `RETRY_COUNT > 0`, last attempt older than `FLEXCUBE_SYNC_RETRY_DELAY_MS`, trigger
   still `P` and the CIF still at that `MOD_NO`.
4. **Rechecks due**: our `E` rows that failed validation and were never sent (`REQUEST` empty, `RESPONSE` stage
   `VALIDATION`), last checked more than `FLEXCUBE_SYNC_RECHECK_DELAY_MS` ago, trigger `E`, CIF still at that `MOD_NO`.
   The KYC is read and validated again, so data corrected in FLEXCUBE is sent without a new CIF revision.
   Only the highest `SEQ_NO` of the KYC is rechecked; older rows stay `E` as history.
5. Optional filter `FLEXCUBE_SYNC_CIF_ALLOWLIST`. Corporates only while the key-person type column is proven to exist.

For each CIF revision:

```
staging row N (new MSGID, RETRY_COUNT 0) -> claimed W -> KYC details read -> trigger U -> P
-> REIS (systemId = CIF) -> S with REQUEST / RESPONSE
   CLEAN -> REIS_FINAL_STATUS = CLEAN, REJECT -> BLOCKED at once; PENDING -> the /customerStatus callback finishes it
```

## Failures and retries

| Failure | Staging row | Trigger | Next |
| --- | --- | --- | --- |
| REIS not reached / token refused / timeout / 5xx / unreadable answer / crash during the call | `N`, `RETRY_COUNT + 1`, `RESPONSE` = code | `P` | sent again after the delay |
| ... and that was attempt `FLEXCUBE_SYNC_MAX_ATTEMPTS` | `E` | `E` | a person looks at it |
| REIS refused the data (HTTP 4xx) | `E` | `E` | corrected CIF comes back from FCUBS as `U` (new `MOD_NO`) |
| KYC cannot be built (missing details, invalid field, CIF mismatch), never sent | `E`, `RESPONSE` stage `VALIDATION` + `detail` | `E` | read again every `FLEXCUBE_SYNC_RECHECK_DELAY_MS`; sent once the data is valid |
| Database error before REIS | claim given back (`N`), not counted | unchanged | next pass |
| REIS answered but the result could not be stored | stays `W` | `P` | recovered as stale, sent again |
| A higher `SEQ_NO` already exists for the KYC / revision already finished | unchanged | `E` | a person looks at it |

A retry sends the same revision again with the same `systemId` (CIF). Retries of an uncertain delivery (timeout, 5xx)
can reach REIS twice; REIS treats a repeated `systemId` as the same customer. When the local case shows REIS already
answered (CLEAN / PENDING / REJECT / final), nothing is sent and the row is closed as `S`.

Three database failures in a row end the pass; the next pass starts again.

## Configuration

See [.env.example](../.env.example): `FLEXCUBE_POLL_ENABLED`, `FLEXCUBE_POLL_INTERVAL_MS` (default 10000, min 1000),
`FLEXCUBE_POLL_BATCH_SIZE`, `FLEXCUBE_SYNC_START_DATE` (optional cut-off), `FLEXCUBE_SYNC_MAX_ATTEMPTS` (default 5),
`FLEXCUBE_SYNC_RETRY_DELAY_MS` (default 60000), `FLEXCUBE_SYNC_RECHECK_DELAY_MS` (default 300000), `FLEXCUBE_SYNC_CIF_ALLOWLIST` (empty = all),
`FLEXCUBE_STAGING_STATUS_IN_PROGRESS` (default `W`), `FLEXCUBE_KEYPERSON_TYPE_COLUMN` (default `KYC_KEYPERSON_TYPE`).
The database user needs SELECT on the STTM tables, INSERT / UPDATE on the staging table and UPDATE on
`STTM_CUSTOMER_CUSTOM` (no DELETE).

## Logs

`flexcube.sync.started`, `flexcube.trigger.item` (`kycRefNo`, `seqNo`, `attempt`, `outcome`), `flexcube.trigger.run`
(`found`, `sent`, `retrying`, `failed`, `skipped`), `flexcube.trigger.failed` (`kycRefNo`, `step`, error code),
`flexcube.trigger.refused` (`kycRefNo`, `reason`), `flexcube.trigger.staleRecovered`, `flexcube.sync.failed`;
`kyc.submission.onboarded` / `failed` / `duplicate` also carry `kycRefNo` and `seqNo`. Never a name, payload, SQL or
bind value.

## SQL safety

Every statement uses bind variables; bind names are never Oracle reserved words (ORA-01745, UAT1 17/11/2026) and are
checked by `assertValidBinds` before Oracle is called. CLOB values are bound directly to the column (ORA-00932 with
COALESCE). `npm run check:oracle-sql` hands every statement (`src/tools/sql-catalog.ts`) to Oracle's parser only:
nothing is executed.

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

