# Status — 19/11/2026

## Done on UAT1

- **First KYC sent to REIS UAT and CLEAN** (single-KYC trial, 19/11/2026 14:43 Libya): CIF `00005818`,
  KYC `001ZKYC26151004Q`, SEQ_NO 1 (= `STTM_CUSTOMER.MOD_NO`). REIS customer id 247, risk LR. FLEXCUBE staging row
  `S` / `CLEAN`, trigger `STTM_CUSTOMER_CUSTOM` = `P`. Runbook: [single-kyc-trial-runbook.md](single-kyc-trial-runbook.md).
- Connectivity: firewall 10.250.100.28 → 10.250.40.1:443 open; REIS UAT certificate renewed by bank IT (valid to
  01/06/2028); bank CA in `/etc/kyc/aiib-ca.pem`, loaded with `NODE_EXTRA_CA_CERTS` (systemd drop-in
  `kyc.service.d/ca.conf`, and in front of every CLI).
- Webhook `POST /customerStatus` on port 3000, bearer token (`WEBHOOK_SECURITY_MODE=bearer`): tested from the server
  itself (401 without token, 404 UNKNOWN_CASE for an unknown systemId, audited). **Not yet tested from REIS.**
- Isolated real-Oracle tests: 16/16 PASS (Docker, Oracle 23 Free) — [isolated-oracle-tests.md](isolated-oracle-tests.md).
- Parse-only check on UAT1: `npm run check:oracle-sql` — every statement parsed, nothing executed.

## Agreed contracts

- **Trigger table** (Finexta, 19/11): FCUBS sets `READY_TO_SCAN = U` after a CIF is created or modified and authorized;
  the API sets `P` when it picks the row and `E` when processing fails. `SEQ_NO = STTM_CUSTOMER.MOD_NO`.
  [customer-trigger-table.md](customer-trigger-table.md).
- **Account authorization** (Finexta): FCUBS reads the staging row with the highest SEQ_NO of the customer's KYC; only
  `REIS_FINAL_STATUS = CLEAN` allows it. Vocabulary in use: `FLEXCUBE_FINAL_STATUS_VOCABULARY=clean-pending-blocked`.
- **REJECT → BLOCKED** (bank decision).
- **REIS identity**: `systemId` = CIF. `account_manager_email` must match the REIS user exactly (case-sensitive,
  Vneuron prerequisites). UAT value: `Test001` / `samer.elazabi@aiib.ly`.

## Still to do

1. Webhook from REIS: firewall 10.250.40.1 → 10.250.100.28:3000 (and the server's local firewall), then a test call
   from REIS with a dummy systemId (integration test planned Monday).
2. Automatic polling from the trigger table is implemented (`TriggerSyncService`, `CifKycWorkflow`, branch
   `claude/trigger-polling`). First run: `FLEXCUBE_POLL_ENABLED=true` with `FLEXCUBE_SYNC_CIF_ALLOWLIST` = one new
   test CIF with a correct account manager; widen afterwards. See [flexcube-sync.md](flexcube-sync.md).
3. Account manager data in FLEXCUBE (`STTM_KYC_RETAIL_CUSTOM`): many empty, swapped or untrimmed values; needs a list
   / validation in FLEXCUBE and the real account managers for production.
4. A second test customer that returns PENDING, to test the callback end to end.
5. Production: separate server (UAT1 shares the CEO dashboard host), HTTPS for the webhook, new tokens.

## Not in main

- `codex/resume-journal`: resume journal, Oracle receipt, authentication-failure classification. Work in progress,
  not for deployment; to be reviewed before reuse.
