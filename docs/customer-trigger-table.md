# Customer trigger table STTM_CUSTOMER_CUSTOM (replaces the webhook)

Agreed with Finexta (Abhilash V, 18/11/2026): FCUBS will not send a webhook. Instead the custom table
`STTM_CUSTOMER_CUSTOM (CUSTOMER_NO, KYC_REF_NO, READY_TO_SCAN)` is filled when a CIF is authorized
(`READY_TO_SCAN = 'U'`), set back to `'U'` after a modified CIF is authorized, and the Integration API sets it to
`'P'` once it has picked the record up. Details are read from the real FCUBS tables (mapping Excel). Finexta also
says the PENDING / timeout account restriction (no account until a confirmed CLEAN) "is already handled".

## What exists in the code (local, tested, NOT wired, nothing sent)

- `src/flexcube/source/customer-trigger.source.ts`: `findReady` (SELECT only, `READY_TO_SCAN = :readyStatus`, joined to the
  open `STTM_KYC_MASTER` row so the cut-off `FLEXCUBE_SYNC_START_DATE` and `MOD_NO` still apply, CIF kept as a string,
  `STAGING_ROWS` tells whether this exact revision was already staged) and `markPicked` (one conditional
  `UPDATE ... SET READY_TO_SCAN = 'P' WHERE CUSTOMER_NO/KYC_REF_NO match AND READY_TO_SCAN = 'U'`, refused unless
  `writeEnabled` is passed explicitly).
- Discovery part E (`--part access`) now also lists the table's columns and counts of `READY_TO_SCAN` values (counts only).

## Rules the implementation follows

1. `'P'` is written only AFTER the staging row of that revision is durable; a crash in between leaves `'U'`, and the next
   pass finds the existing staging row (idempotent) instead of losing the customer.
2. The CIF comes from the trigger row (`CUSTOMER_NO`) and is still compared with the reported value, never trusted blindly.
3. A re-triggered row whose revision is already staged (`STAGING_ROWS > 0`) is NOT resent automatically: a CIF modification
   without a new KYC revision needs an explicit amendment decision (below).

## Open questions for Finexta (block wiring)

1. Are `U` and `P` the only values? On a processing failure may we set another value (e.g. `E`) or must the row stay `U`?
2. A version or date column (e.g. KYC `MOD_NO`, last-authorized timestamp): without it a CIF modified while we process is lost
   and an amendment cannot be told from a duplicate; it also gives a cut-off.
3. Is the table backfilled with existing customers (`U`)? It must hold only new records.
4. A row for CIF `00005818` / KYC `001ZKYC26151004Q` for the UAT test (created before the table existed).
5. Grants for REIS_KYC: `SELECT` on `STTM_CUSTOMER` and `STTM_CUSTOMER_CUSTOM`, and `UPDATE` on `READY_TO_SCAN` only.
6. Written confirmation that account opening needs `REIS_FINAL_STATUS = 'CLEAN'` (blocked for PENDING, BLOCKED, NULL, timeout).

## Still to do once answered

Wire the source into the poller behind its own flag (off by default), keep the single-KYC send gate closed, add the
amendment rule for re-triggered revisions, then a synthetic end-to-end test.

## Answers of 19/11/2026 (Abhilash) and what changed in the code

1. Values: FCUBS writes only `U`; the API writes `P` when it picks a row and `E` when processing fails.
2. Version: `STTM_CUSTOMER.MOD_NO`, joined by `CUSTOMER_NO`, and it is the staging `SEQ_NO` ("you need to pass CUSTOMER_NO
   to REIS each time"). A CIF modified without a new KYC revision therefore gets a new `SEQ_NO` and no clash.
3. Account opening: only `REIS_FINAL_STATUS = 'CLEAN'` allows it.
4. The UAT test row `00005818` / `001ZKYC26151004Q` was inserted (U). Grants: SELECT / INSERT / UPDATE, synonym in place.

Code: `findReady` returns `seqNo` = CIF `MOD_NO` (and the KYC `MOD_NO` as evidence); `markPicked` and the new `markError`
are conditional on the trigger status AND on the CIF still being at that `MOD_NO`. The single-KYC trial follows the same
flow (see `docs/single-kyc-trial-runbook.md`, update 19/11/2026).

Still open: whether the account check reads the highest `SEQ_NO` of the KYC; wiring into the poller (after the trial, with
the CIF submission workflow that replaces the hold).
