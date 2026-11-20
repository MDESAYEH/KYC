# Customer trigger table STTM_CUSTOMER_CUSTOM (replaces the webhook)

Agreed with Finexta (Abhilash V, 18/11/2026): FCUBS will not send a webhook. Instead the custom table
`STTM_CUSTOMER_CUSTOM (CUSTOMER_NO, KYC_REF_NO, READY_TO_SCAN)` is filled when a CIF is authorized
(`READY_TO_SCAN = 'U'`), set back to `'U'` after a modified CIF is authorized, and the Integration API sets it to
`'P'` once it has picked the record up. Details are read from the real FCUBS tables (mapping Excel). Finexta also
says the PENDING / timeout account restriction (no account until a confirmed CLEAN) "is already handled".

## Answers of 19/11/2026 (Abhilash) and what changed in the code

1. Values: FCUBS writes only `U`; the API writes `P` when it picks a row and `E` when processing fails.
2. Version: `STTM_CUSTOMER.MOD_NO`, joined by `CUSTOMER_NO`, and it is the staging `SEQ_NO` ("you need to pass CUSTOMER_NO
   to REIS each time"). A CIF modified without a new KYC revision therefore gets a new `SEQ_NO` and no clash.
3. Account opening: only `REIS_FINAL_STATUS = 'CLEAN'` allows it.
4. The UAT test row `00005818` / `001ZKYC26151004Q` was inserted (U). Grants: SELECT / INSERT / UPDATE, synonym in place.

Code (`src/flexcube/source/customer-trigger.source.ts`): `findReady` returns `seqNo` = CIF `MOD_NO`; `markPicked` and
`markError` are conditional on the trigger status AND on the CIF still being at that `MOD_NO`. The poller is described in
[flexcube-sync.md](flexcube-sync.md). FLEXCUBE's account check reads the highest `SEQ_NO` of the KYC (Abhilash, 19/11/2026).
