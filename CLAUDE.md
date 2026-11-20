# Working on this repository

Read `docs/STATUS.md` first.

## Boundaries (UAT1 bank server and data)

- Polling (`FLEXCUBE_POLL_ENABLED=true`) sends every CIF FCUBS sets to `U` (or only `FLEXCUBE_SYNC_CIF_ALLOWLIST`):
  change these only when the user asks.
- Never write `REIS_FINAL_STATUS` by hand, never `DELETE` staging rows, never change FLEXCUBE tables other than the
  staging table and `STTM_CUSTOMER_CUSTOM.READY_TO_SCAN` through the code.
- The UAT1 host also runs the bank's CEO dashboard: touch only `/opt/KYC` and `kyc.service`.
- Secrets live only in `.env` on the server; never print or commit them.

## Code

- Before delivery: `npx tsc --noEmit`, `npm run lint`, `npm run build`.
- Every SQL statement must be in `src/tools/sql-catalog.ts` so `npm run check:oracle-sql` parses it on UAT1.
- Oracle bind names must not be reserved words (ORA-01745); CLOB values are bound directly, never inside a SQL function.
- Logs may carry the KYC reference and SEQ_NO, codes and counts; never names, payloads or tokens.
