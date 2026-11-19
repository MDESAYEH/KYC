# Working on this repository

Read `docs/STATUS.md` first: it is the current state (19/11/2026). Older handoff notes were removed.

## Boundaries (UAT1 bank server and data)

- Never enable polling (`FLEXCUBE_POLL_ENABLED=true`) until the poller is wired to the trigger table and that change
  is reviewed and approved by the user.
- Never send a KYC to REIS outside `npm run trial:one` with a fresh preflight and approval file, and never resend after
  an uncertain delivery. Reset only with `npm run trial:reset` and a written REIS confirmation.
- Never write `REIS_FINAL_STATUS` by hand, never `DELETE` staging rows, never change FLEXCUBE tables other than the
  staging table and `STTM_CUSTOMER_CUSTOM.READY_TO_SCAN` through the code.
- The UAT1 host also runs the bank's CEO dashboard: touch only `/opt/KYC` and `kyc.service`.
- Secrets live only in `.env` on the server; never print or commit them.

## Code

- Tests must pass before delivery (`npm test`, `npm run lint`, `npx tsc --noEmit`). Real-Oracle tests are opt-in
  (`docs/isolated-oracle-tests.md`).
- Every SQL statement must be in `src/tools/sql-catalog.ts` so `npm run check:oracle-sql` parses it on UAT1.
- Oracle bind names must not be reserved words (ORA-01745); CLOB values are bound directly, never inside a SQL function.
