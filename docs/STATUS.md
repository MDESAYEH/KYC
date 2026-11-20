# Status — 20/11/2026

## Done on UAT1

- **First KYC sent to REIS UAT and CLEAN** (19/11/2026): CIF `00005818`, KYC `001ZKYC26151004Q`, SEQ_NO 1
  (= `STTM_CUSTOMER.MOD_NO`), REIS customer id 247. Staging row `S` / `CLEAN`, trigger `P`.
- Connectivity: 10.250.100.28 -> 10.250.40.1:443 open; REIS UAT certificate renewed; bank CA in
  `/etc/kyc/aiib-ca.pem` (`NODE_EXTRA_CA_CERTS`).
- Webhook `POST /customerStatus` on port 3000 with a bearer token, tested from the server itself. **Not yet from REIS.**

## In the code (20/11/2026)

- Automatic sending from the trigger table, always on as a systemd service: every CIF FCUBS sets to `U` is sent,
  the result is written back. Interval from `.env` (default 10 s). Failed sends are retried
  (`FLEXCUBE_SYNC_MAX_ATTEMPTS`, `FLEXCUBE_SYNC_RETRY_DELAY_MS`). See [flexcube-sync.md](flexcube-sync.md).
- Single-KYC trial tools, the legacy KYC_MASTER poller, the operations CLI and all tests were removed.

## Agreed contracts

- **Trigger table** (Finexta, 19/11): FCUBS sets `U`; the API sets `P` / `E`. `SEQ_NO = STTM_CUSTOMER.MOD_NO`.
- **Account authorization**: FCUBS reads the highest SEQ_NO of the KYC; only `REIS_FINAL_STATUS = CLEAN` allows it.
- **REJECT -> BLOCKED** (bank decision).
- **REIS identity**: `systemId` = CIF. `account_manager_email` must match the REIS user exactly (case-sensitive).
  UAT value: `Test001` / `samer.elazabi@aiib.ly`.

## Still to do

1. Webhook from REIS: firewall 10.250.40.1 -> 10.250.100.28:3000 (and the server's local firewall), then a test call.
2. Before enabling all CIFs: 4 old `U` rows in `STTM_CUSTOMER_CUSTOM` (Finexta test customers with bad account-manager
   data) would be sent; set them aside with Finexta or use `FLEXCUBE_SYNC_CIF_ALLOWLIST`.
3. Account manager data in FLEXCUBE (`STTM_KYC_RETAIL_CUSTOM`): many empty, swapped or untrimmed values.
4. A test customer that returns PENDING, to test the callback end to end.
5. Production: separate server, HTTPS for the webhook, new tokens.
