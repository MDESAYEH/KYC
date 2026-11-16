# Setup and first run (UAT1)

Run these in the project folder (PowerShell or CMD on Windows):

1. `npm install` - installs the dependencies (including the Oracle driver `oracledb`, Thin mode:
   no Oracle Client installation is needed).
2. Copy `.env.example` to `.env` and fill it in (never commit `.env`):
   - REIS: `REIS_BASE_URL`, `REIS_TENANT`, `REIS_USERNAME`, `REIS_PASSWORD`, `REIS_TIMEOUT_MS`.
   - Webhook: `WEBHOOK_SECURITY_MODE=bearer` and a generated `WEBHOOK_BEARER_TOKEN`
     (share it with Reis over a separate secure channel, not by plain email).
   - FLEXCUBE database: `FLEXCUBE_DB_USER`, `FLEXCUBE_DB_PASSWORD`, `FLEXCUBE_DB_CONNECT_STRING`
     (`host:port/SERVICE`).
   - Polling: `FLEXCUBE_POLL_ENABLED=true` once the STTM queries are verified on UAT1.
3. `npm run migration:run` - creates / upgrades the local database of the integration layer.
4. `npm run mappings:seed` - loads the agreed reference lists (Appendix V1.4, 414 codes).
   Safe to run again; run it again whenever the appendix changes. A code switched off by an
   administrator stays off; `npm run mappings:seed -- --reactivate` switches every agreed code on.
5. `npm test` - should report every test passing.
   UAT1 check (READ-ONLY, writes nothing, does not call Reis): `npm run check:uat1`.
   It verifies the connection, access to the 9 KYC tables and the staging table, the expected
   columns, the staging privileges (INSERT / UPDATE yes, DELETE no), counts the saved KYCs waiting
   for Reis and dry-runs the first five through validation and mapping. Result in the console and
   in `uat1-check-report.json` (no customer data). If the tables belong to another schema and the
   user has no synonyms, set `FLEXCUBE_DB_SCHEMA` (e.g. FCUBS).
6. `npm run build` then `npm run start:prod`.

Health: `GET /health/live` and `GET /health/ready`.
Webhook for Reis: `POST https://<integration host>/customerStatus` with
`Authorization: Bearer <WEBHOOK_BEARER_TOKEN>`.

Before enabling polling on UAT1, check the provisional SQL in
`src/flexcube/source/flexcube-kyc.queries.ts` against the real tables (see `docs/flexcube-sync.md`).
