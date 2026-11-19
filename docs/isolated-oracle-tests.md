# Isolated real-Oracle tests (B3 and B5)

Prepared 18/11/2026. **Run 19/11/2026 on Docker (Oracle 23 Free, WSL2): 16/16 PASS** after the ORA-00932 fix in
`StagingSubmissionRepository.complete()` (CLOB bound inside COALESCE). Skipped by default (no Oracle in CI). A passing run proves OUR SQL on a real Oracle; it does not prove the bank contract (B4) or anything
on UAT1. Nothing here touches UAT1, REIS, `.env` or the 58 historical rows.

## Safety (enforced by code, tested in `test/support/isolated-oracle.spec.ts`)

- Off unless an exact confirmation phrase AND user / password / connect string are set **in the shell** (never from `.env`).
- A test that is enabled but unsafe **throws** instead of running: host not loopback (`localhost`, `127.0.0.1`, `::1`; **no
  environment override exists**, an inherited variable cannot admit another host), a bank / system user (`REIS_KYC`, `OBPPRD`,
  `FCUBS`, `SYS`, `SYSTEM`), or a connection / user equal to the application's `FLEXCUBE_DB_*` when set in the shell.
- **SSH tunnels and port forwards** make a bank database look like `localhost`, and `.env` values are never read, so the checks
  above are not enough. After connecting and BEFORE creating anything, `assertDisposableDatabase` refuses a database that holds
  FLEXCUBE objects (`STTM_*`, `FLTM_*`, `CSTM_*`) or whose database / service / current user name looks like UAT, PROD, FCUBS, OBP or
  a bank user, and refuses when those checks cannot run (fail-closed). Never open a tunnel to UAT1 / PROD for these tests.
- Every spec creates randomly named tables (`KTR_*`, `KST_*`, `KYC_TEST_STG_*`), never an `STTM_*` table, and drops them.

## Option A: local disposable Oracle (needs Docker)

```bash
docker compose -f docker/oracle-isolated/compose.yml up -d
```

Then, in the same shell (values are the throw-away ones from `compose.yml`):

```bash
export KYC_ORACLE_TEST_USER=KYC_TEST KYC_ORACLE_TEST_PASSWORD=disposable-test-only KYC_ORACLE_TEST_CONNECT=localhost:1521/FREEPDB1
export KYC_SINGLE_ORACLE_TEST_USER=$KYC_ORACLE_TEST_USER KYC_SINGLE_ORACLE_TEST_PASSWORD=$KYC_ORACLE_TEST_PASSWORD KYC_SINGLE_ORACLE_TEST_CONNECT=$KYC_ORACLE_TEST_CONNECT
export KYC_STATUS_ORACLE_TEST_USER=$KYC_ORACLE_TEST_USER KYC_STATUS_ORACLE_TEST_PASSWORD=$KYC_ORACLE_TEST_PASSWORD KYC_STATUS_ORACLE_TEST_CONNECT=$KYC_ORACLE_TEST_CONNECT
export KYC_ORACLE_TEST_CONFIRM=CREATE_AND_DROP_A_TEST_TABLE
export KYC_SINGLE_ORACLE_TEST_CONFIRM=CREATE_AND_DROP_ISOLATED_TRIAL_TABLES
export KYC_STATUS_ORACLE_TEST_CONFIRM=CREATE_AND_DROP_ISOLATED_STATUS_TABLE
npx jest --runInBand test/oracle-staging.sql.integration.spec.ts test/single-kyc-trial.oracle.spec.ts test/status-update.oracle.spec.ts
```

## Option B: a disposable database supplied by bank IT

Only a sandbox that is NOT UAT1 / PROD. It needs a reviewed code change to the host rule (there is no environment override), and
it must pass `assertDisposableDatabase`. Do not use `REIS_KYC`.

## What each spec proves

| Spec                                     | Blocker          | Proves on real Oracle                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oracle-staging.sql.integration.spec.ts` | B3               | ORA-01745 root cause, insert -> claim (`N -> W`) -> complete (`S`/`E`), release, stuck queries, CHECK violation code, parse-only `describe` of the catalog                                                                                                                              |
| `single-kyc-trial.oracle.spec.ts`        | B3               | The trial's exact-revision claim once only, request/raw response/PENDING stored without touching another `SEQ_NO`, a changed `MOD_NO` prevents the claim without inventing a decision                                                                                                   |
| `status-update.oracle.spec.ts`           | B5 (Oracle half) | The callback's final UPDATE changes exactly the intended revision, replaces PENDING only in `clean-pending-blocked`, never overwrites a final decision, idempotent, nothing for a missing revision / other KYC, and **refuses** an update without `seqNo` (no latest-revision fallback) |

## What stays outside these tests (B5 other half, already covered without Oracle)

Callback -> revision binding (`test/callback-revision-binding.integration.spec.ts`, SQLite): a callback without `seqNo` updates
the revision stored in the case, duplicates / conflicts / unknown identity, quarantine of the trial identities. The residual
risk (a late duplicate of revision N applied to a pending revision N+1) needs a revision token from REIS (B2/B5 question to
Vneuron). B3 / B5 are closed only when these runs pass and the output is kept as evidence.
