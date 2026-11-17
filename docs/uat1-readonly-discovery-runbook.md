# UAT1 read-only discovery, status contract and path to ONE trial send — FOR REVIEW, NOTHING RUN

Target: KYC_REF_NO `001ZKYC26151003Y`, MOD_NO `2`. Nothing in this file was executed against Oracle or REIS.
Everything below needs only a **SELECT-only** session (dictionary views + one grouped COUNT). No DDL, no DML, no REIS call.
All statements are in `docs/uat1-readonly-discovery.sql`, generated from `src/tools/cif-source-discovery.ts` and
`src/tools/status-contract-discovery.ts`; a test (`status-contract-discovery.spec.ts`) fails if file and code drift, if a statement
is not a SELECT, or if a bind name is an Oracle reserved word.

## 1. CIF source discovery (Part A of the SQL file)

Run with bind-aware tooling (SQL Developer / SQLcl / the bank's approved client; **never** concatenate values). Order:

1. `A:columns` with `:ownerName = NULL`, `:tableName = NULL`, `:nameFragment = 'CIF'`, `:maxRows = 100`; repeat with `'CUSTOMER'`,
   then `'KYC'`. Result: owner, table, column, type, length, nullable, comment. Candidates only.
2. For each promising `(owner, table)` pair repeat `A:keys`, `A:foreignKeys`, `A:synonyms` with that exact pair: which columns are
   the key, which table `STTM_KYC_MASTER.KYC_REF_NO` is linked to, and whether the object is a synonym/DB link.
3. Write down for Finexta: candidate table, column, data type (NUMBER loses leading zeros, so `00005804` needs a VARCHAR2 or a
   documented formatting rule), the join to `KYC_REF_NO`, and the cardinality they claim.

**What leaves the database:** object names, column names, types, comments, constraint names. **No customer value** (no CIF, no name, no
KYC reference). An empty result proves nothing (privileges, synonyms, views). A name match is not a business confirmation.

Only **after Finexta confirms** a table/column/join in writing: they (or we, reviewed by them) write ONE read-only SELECT with
`:kycRefNo` and `:seqNo` binds returning a single `CIF_VALUE` string. That file is the `--cif-sql` input of `trial:one`; its SHA-256 is bound into the
approval. The reported CIF `00005804` is only compared with the result, never used as a source.

## 2. Does `REIS_FINAL_STATUS` really accept CLEAN / PENDING / BLOCKED? (Part B)

Run with `:ownerName = '<staging table owner>'` (`REIS_KYC` on UAT1 per the earlier check; confirm with `check:uat1`),
`:tableName = 'STTM_KYC_REIS_PAYLOAD_CUSTOM'`, `:maxRows = 200`:

| Query | What it tells us |
| --- | --- |
| `B:statusColumn` | type / length / default of `REIS_FINAL_STATUS` and `PROCESS_STATUS` |
| `B:checkConstraints` | every CHECK (enabled? validated? which values?) — decisive for CLEAN / PENDING / BLOCKED and for the claim status `W` |
| `B:triggers` | triggers that can reject or rewrite a value even if the CHECK allows it |
| `B:triggerCodeMentioningTheColumns` | the trigger lines that validate the two columns |
| `B:consumers`, `B:consumerCodeMentioningTheStatus` | the objects and lines where FLEXCUBE logic READS `REIS_FINAL_STATUS` (what does it do with CLEAN, PENDING, BLOCKED, NULL?) |
| `B:tableDdl` | the exact DDL (needs `SELECT_CATALOG_ROLE`; ORA-31603 = not granted) to replay in an isolated schema |
| `B:statusDistribution` | counts of values already stored (e.g. Finexta's test row), no identifiers |

**Evidence ladder — "accepted" means all three, not one:**

1. **Database accepts it:** the CHECK text and trigger lines from the queries above allow `CLEAN`, `PENDING`, `BLOCKED` (and `W` for PROCESS_STATUS).
2. **Proved on Oracle:** replay `B:tableDdl` in an authorized disposable schema and run the isolated suites (section 3) plus an
   `UPDATE ... SET REIS_FINAL_STATUS = 'PENDING' / 'CLEAN' / 'BLOCKED'` on the replica: the three statements must succeed and a value
   outside the list must fail with ORA-02290. (Replaying a copy proves the constraint, not FLEXCUBE's behavior.)
3. **FLEXCUBE reads it as intended:** Finexta's written confirmation, backed by `B:consumerCodeMentioningTheStatus`, that account
   activation is blocked on `PENDING`, `BLOCKED` **and `NULL`**, and allowed on `CLEAN` only; then Tareq's check on the FLEXCUBE screen
   after the single trial. A SELECT of the column never proves consumer behavior.

Until all three hold the default vocabulary stays `APPROVED/BLOCKED` and nothing is written in the new words.

## 3. Skipped Oracle tests: exactly which, what they need, what must pass

Current local run: 1068 passed / **7 skipped** / 0 failed. The 7 skipped are the real-Oracle tests:

| File | Tests (skipped) | Gate (shell variables, never `.env`) |
| --- | --- | --- |
| `test/oracle-staging.sql.integration.spec.ts` (4) | (1) reproduces **ORA-01745** with `:from` on real Oracle; (2) insert → claim → complete S; (3) complete E, fail, release, stuck query; (4) CHECK violation gives ORA-02290 on the claim | `KYC_ORACLE_TEST_USER`, `_PASSWORD`, `_CONNECT`, `KYC_ORACLE_TEST_CONFIRM=CREATE_AND_DROP_A_TEST_TABLE` |
| `test/single-kyc-trial.oracle.spec.ts` (3) | (1) exact-revision claim once with Oracle-safe binds; (2) stores request + raw response + PENDING without touching another SEQ_NO; (3) a changed MOD_NO prevents the claim, no E | `KYC_SINGLE_ORACLE_TEST_USER`, `_PASSWORD`, `_CONNECT`, `KYC_SINGLE_ORACLE_TEST_CONFIRM=CREATE_AND_DROP_ISOLATED_TRIAL_TABLES` |

Requirements: a **disposable schema owned by the person running it**, never UAT1 data and never the bank staging/master tables (the
suites create randomly named tables and drop them); Oracle version equal to the bank's; fixture DDL **compared with the real DDL from
`B:tableDdl`** (columns such as REQUEST/RESPONSE as CLOB are assumed). Run: `npx jest --runInBand test/oracle-staging.sql.integration.spec.ts test/single-kyc-trial.oracle.spec.ts`.
**Must be 7 passed, 0 skipped, 0 failed** before any deployment of the trial; plus bank-side metadata review (constraints/triggers) from section 2.
One known unknown: the discovery SELECTs use `(:ownerName IS NULL OR ...)`; confirm the Oracle client binds a NULL there.

## 4. Callback → revision binding (REIS sends no seqNo)

Proved by `test/callback-revision-binding.integration.spec.ts` (7 tests, real SQLite repositories + real webhook service + real
updater against an in-memory Oracle double):

`callback.systemId (= CIF)` → `kyc_case.reis_system_id` (**unique**) → that case's persisted `seqNo` (= 2, written when revision 2 was sent)
→ `UPDATE … SEQ_NO = 2`, **never `MAX(SEQ_NO)`**. Revision 1 (closed `E`) is untouched; an unknown identity, or the old KYC reference once
the case lives under the CIF, changes nothing; a repeat is `DUPLICATE`; a contrary late one is `CONFLICT` (stored decision kept).

Two things the tests expose, not hide:

- **Hazard H1 (vocabulary):** the trial writes `PENDING`; with the default vocabulary the callback cannot replace it (`UPDATE_FAILED`, row stays
  PENDING). The trial may only be sent together with `FLEXCUBE_FINAL_STATUS_VOCABULARY=clean-pending-blocked`.
- **Residual limit R1 (needs REIS):** the case is keyed by identity. If revision 3 of the same CIF is sent while a late *duplicate*
  callback of revision 2 can still arrive, that callback is applied to revision 3. Mitigation inside our control: the trial sends ONE revision
  and the workflow refuses an amendment while the previous one awaits its callback; the real fix is a revision token in the callback (question Q-V3).

The callback for the trial identities (old KYC reference and CIF) stays **quarantined** until Finexta confirms the vocabulary and section 3 passes.

## 5. PENDING → final replacement and every REIS outcome

Replacing `PENDING` is safe only because the UPDATE is: exact `SEQ_NO`, only from `NULL` / the same value / `PENDING`, never over `CLEAN` or `BLOCKED`
(tests in `staging-flexcube-status-updater.spec.ts`), and only in the opt-in vocabulary.

| REIS result | `PROCESS_STATUS` | `REIS_FINAL_STATUS` | Notes |
| --- | --- | --- | --- |
| onboarding `CLEAN` | `S` | `CLEAN` | final at once; REIS sends no callback for it |
| onboarding `PENDING` | `S` | `PENDING` | account must stay blocked; callback decides |
| callback `CUSTOMER` | `S` | `PENDING → CLEAN` | exact revision, once |
| callback `BLOCKED` | `S` | `PENDING → BLOCKED` | exact revision, once |
| onboarding `REJECT` | `S` | `BLOCKED` **only if approved**, else NULL | `rejectToBlockedApproved` in the approval file |
| timeout / malformed / non-2xx / lost response | `E` (uncertain) | **NULL** | never mapped to PENDING; **no resend**; manual reconciliation with REIS |
| response received but recording failed | stays `W` | unchanged | reported as stuck; never resent, never overwritten |

Open point for Finexta: NULL must block activation exactly like PENDING (Q-F3).

## 6. Final requests (copy as is)

### To Finexta (Abhilash)

Context: single UAT1 test, KYC_REF_NO `001ZKYC26151003Y`, MOD_NO 2. We cannot send until these are answered in writing.

- **F1 (CIF).** In which schema, table and column is the customer CIF stored? Give the exact join from `STTM_KYC_MASTER.KYC_REF_NO` (and MOD_NO if needed), the
  data type, and whether leading zeros are stored or added by formatting. Is the CIF created and committed **before** the KYC is saved/authorized, for both branch and OBDX
  channels? If it is created only after REIS approval, what is your proposal? Please confirm that CIF `00005804` is the CIF of this KYC.
- **F2 (status contract).** Send the DDL, CHECK constraints and triggers of `STTM_KYC_REIS_PAYLOAD_CUSTOM`. Does `REIS_FINAL_STATUS` accept exactly `CLEAN`, `PENDING`, `BLOCKED`,
  or still `APPROVED`? Which FLEXCUBE object reads it (name of the procedure/view/screen rule)?
- **F3 (enforcement).** For each of `CLEAN`, `PENDING`, `BLOCKED` and `NULL`: what does FLEXCUBE do to account opening/activation and to operations on an
  already active account? Is a `NULL` treated as blocked? Which row is read when a CIF has several revisions (latest `SEQ_NO`, or the one matching the authorized `MOD_NO`)?
- **F4 (claim).** Which values may `PROCESS_STATUS` hold? Is `W` accepted? (The first attempt failed with ORA-01745, caused by our bind names, but we need the constraint to confirm.)
- **F5 (corporate).** Which column of `STTM_KYC_CORP_KEYPERSONS` holds individual/company (I/C)? `KYC_KEYPERSON_TYPE` does not exist; do the values of `OWNERSHIP_TYPE` map to I/C, and how?
- **F6 (data).** Confirm Occupation, Account Purpose and Total Income are now mandatory on save in the FLEXCUBE screen (Tareq had to correct one directly in the database).

### To Vneuron (REIS)

Context: UAT, one customer, first send ever for this identity.

- **V1 (identity).** Is `systemId` unique per customer within our tenant/`systemName`? Do `001ZKYC26151003Y` or `00005804` already exist in UAT (checked **without** calling
  the state-changing onboarding endpoint)? Is there a read-only lookup by `systemId`?
- **V2 (CIF as systemId).** Do you accept the CIF as `systemId`? If the same CIF is sent again with changed KYC data, is it an update of the same customer or a new one? How do we avoid a
  duplicate for customers previously sent under the KYC reference (alias/migration)?
- **V3 (callback revision).** Does the callback carry, or can it carry, a revision/request identifier (our MOD_NO) or your request id returned in the onboarding response?
  If not, what guarantees that a late or duplicate callback is not delivered for an older revision of the same `systemId`?
- **V4 (statuses).** Exact meaning of the onboarding statuses `CLEAN`, `PENDING`, `REJECT` and of the callback statuses `CUSTOMER`, `BLOCKED`: which are final, can a final status change later, and how is a later
  change (e.g. an active customer becoming BLOCKED) notified? Is `REJECT` equivalent to `BLOCKED` for the bank?
- **V5 (timeout).** If our request times out, is a repeat of the same request idempotent? What is the typical and the maximum response time we should expect (we assumed 5–15 s)?
- **V6 (callback delivery).** Retry schedule and timeout of the callback, and confirmation of the `Authorization: Bearer` contract and of the field name `Status` vs `status`.

## 7. Plan to ONE send, with gates (stop at the first red gate)

1. **Local (done):** full suite, callback binding proof, status updater tests, quarantine tests. *Gate: green.*
2. **SELECT-only discovery (Bank IT, 1 h):** run Part A and Part B, return the outputs (no customer data) → section 1 and 2 conclusions.
3. **Finexta answers F1–F4 in writing** → write and review the CIF SELECT; decide the vocabulary; Finexta states the consumer behavior.
4. **Isolated Oracle (authorized schema):** replay the DDL and run the 7 skipped tests → 7 passed. *Gate: 0 skipped, 0 failed.*
5. **Vneuron answers V1–V4**; REIS operations confirm both identities are absent. *Gate: written reference.*
6. **Close the code gates deliberately (a reviewed change, not a deletion):** set `FLEXCUBE_FINAL_STATUS_VOCABULARY=clean-pending-blocked`, lift the callback
   quarantine for the trial identity only, replace the `EXACT_REVISION_CALLBACK_ROUTE_NOT_IMPLEMENTED` guard by the verified route, add the integration test for the real route.
7. **Operational prerequisites:** polling off, other senders stopped, `npm run backup:sqlite` verified, protected evidence folder, `check:uat1` and `reconcile:staging` (dry run) saved.
8. **Preflight** (`trial:one --mode preflight`) → review the plan hash → blank approval filled by a named approver (valid 1 hour).
9. **One send** (`--mode send`, confirmation word). Expected: staging row SEQ_NO 2 `S`, `REIS_FINAL_STATUS` = `CLEAN` or `PENDING`; no other row changes; the 58 `E` rows and the revision-1 row unchanged
   (check with `--mode verify` and `check:uat1`).
10. **Tareq verifies on the FLEXCUBE screen** the behavior for the returned status (account opening blocked on PENDING). If PENDING: wait for the callback and verify `PENDING → CLEAN/BLOCKED` on SEQ_NO 2.
11. **If anything is uncertain: stop. No resend, no requeue.** Reconcile with REIS first.

## 8. Final review of `docs/uat1-readonly-discovery.sql` (12 statements)

Checked by reading and by tests (`status-contract-discovery.spec.ts`, `readonly-discovery.spec.ts`):

- every statement starts with `SELECT`; none contains INSERT / UPDATE / DELETE / MERGE / DDL / GRANT / COMMIT / LOCK / `FOR UPDATE` / `INTO` / `;` inside a statement;
- no statement reads a business table, except `B:statusDistribution`: a grouped `COUNT(*)` of the status column of the staging table (no identifier);
- everything else reads dictionary views (`ALL_TAB_COLUMNS`, `ALL_CONSTRAINTS`, `ALL_CONS_COLUMNS`, `ALL_TRIGGERS`, `ALL_SOURCE`, `ALL_DEPENDENCIES`, `ALL_SYNONYMS`, `ALL_COL_COMMENTS`): only what the user may already see; an empty result is not proof of absence;
- the only PL/SQL call is `DBMS_METADATA.GET_DDL` (documented read-only; needs `SELECT_CATALOG_ROLE`, otherwise ORA-31603; it only builds a temporary LOB for the session). Skip it if the bank prefers: the DDL can come from Finexta;
- `DB_LINK` is selected only as a column of `ALL_SYNONYMS`; no link is followed. All but two statements have `FETCH FIRST :maxRows`; the two without return one row;
- the `ALL_SOURCE ... LIKE` statements scan dictionary text: run them outside peak hours; they do not lock anything;
- bind names (`ownerName`, `tableName`, `nameFragment`, `maxRows`) are not reserved words (tested against the full reserved list); the runner refuses any non-SELECT before it reaches Oracle (tested with 17 forbidden forms);
- to confirm on the first run: the client must bind a NULL for `(:ownerName IS NULL OR ...)` (the runner passes null).

## 9. How to run them on the server with what is already installed (READ-ONLY)

Nothing is installed; no setting, `.env`, systemd unit, `dist/` or `src/` of the running service is changed. The runner is the application's own
Oracle executor (the same driver and `FLEXCUBE_DB_*` values `check:uat1` already uses; values are never printed).

Because `kyc.service` runs `nest start --watch`, the files must **not** be written into `/opt/KYC/src` (it would restart the service). Use a separate folder:

```bash
# READ-ONLY, new folder only
mkdir -p /root/kyc-discovery && cd /root/kyc-discovery
#   unpack the reviewed bundle here (src/, docs/, package.json, tsconfig*.json, nest-cli.json)
ln -s /opt/KYC/node_modules node_modules       # reuse installed packages (no install)
ln -s /opt/KYC/.env .env                       # reuse the existing settings by link (no copy, never printed)
npx tsc -p tsconfig.build.json                 # compiles into /root/kyc-discovery/dist only

mkdir -p /root/kyc-discovery-out && chmod 700 /root/kyc-discovery-out
node dist/tools/run-readonly-discovery.js --part cif    --report /root/kyc-discovery-out/cif-columns.json
node dist/tools/run-readonly-discovery.js --part status --report /root/kyc-discovery-out/status-contract.json
# after Finexta names ONE exact CIF candidate OWNER.TABLE (keys, foreign keys, synonyms of that candidate only):
node dist/tools/run-readonly-discovery.js --part cif --candidate OWNER.TABLE --report /root/kyc-discovery-out/cif-candidate.json
```

The console shows only query names, row counts and Oracle codes; the reports hold metadata and code lines (no customer data). Send the files through the
bank's protected channel. If `sqlplus` / SQLcl already exists, the SQL file can be run directly instead (bind variables, autocommit off, SELECT-only account).
How the bundle reaches the server is a decision for the owner: the changes are not committed or pushed, so a `git pull` would not bring them.

### Separation of commands for the next step

| Kind | Commands | When |
| --- | --- | --- |
| **READ** (allowed now) | the three `run-readonly-discovery.js` commands above; `node dist/tools/check-flexcube-uat.js`; `node dist/tools/reconcile-staging.js` (dry run, no `--apply`); `run-single-kyc-trial.js --mode preflight ... --report NEW` (once the approved CIF SELECT file exists) and `--mode verify` | now / after Finexta's SQL |
| **WRITE — NOT NOW** | `run-single-kyc-trial.js --mode send` (refused by design until the gates are lifted); `reconcile-staging.js --apply`; `npm run staging:requeue`; any `.env` edit; service restart; deployment | only after section 10 is complete and a named person approves |

## 10. Conditions that must hold before the gates may be lifted

Each is checked by `evaluateTrialGates` and shown by `--mode preflight` as `unmetGates`.

| Condition | Gate code | What proves it (local test / external evidence) |
| --- | --- | --- |
| Vocabulary is `clean-pending-blocked` | `VOCABULARY_NOT_CLEAN_PENDING_BLOCKED` | `staging-flexcube-status-updater.spec.ts`; Finexta confirmation (F2, F3) |
| Polling off, other senders stopped | `POLLING_ENABLED`, `SENDERS_NOT_STOPPED` | preflight refuses polling; written confirmation from Bank IT |
| Fresh named approval (at most 1 h) tied to this plan, CIF SELECT and claim SQL by SHA-256 | `APPROVAL_*`, `EVIDENCE_HASH_MISMATCH` | `single-kyc-trial.gates.spec.ts` (each missing or changed field is reported alone) |
| Finexta status contract (constraints, triggers, consumer) | `FINEXTA_STATUS_CONTRACT_REFERENCE_MISSING` | section 2 evidence ladder, F2 to F4 |
| Claim SQL proved on an authorized isolated Oracle | `ORACLE_CLAIM_TEST_REFERENCE_MISSING` | the 7 skipped tests become 7 passed (section 3) |
| CIF source/join verified and available before submission | `CIF_SOURCE_NOT_VERIFIED`, `CIF_NOT_AVAILABLE_BEFORE_SUBMISSION` | discovery output + F1 |
| Old KYC identity and CIF absent in REIS | `REIS_IDENTITIES_NOT_CHECKED` | V1 answer |
| Callback routing to the exact revision accepted | `CALLBACK_ROUTING_REFERENCE_MISSING` | `callback-revision-binding.integration.spec.ts` + V3 answer (or the residual risk accepted in writing by the bank) |
| Backups verified | `BACKUPS_NOT_VERIFIED` | `npm run backup:sqlite` output (hash, integrity) |
| REJECT mapping decided (either way) | `REJECT_MAPPING_NOT_DECIDED` | Bank/Compliance decision |

An empty `unmetGates` means only that **a reviewed code change may then lift** the two gates (the CLI refusal and the callback quarantine); it lifts nothing by itself
(`single-kyc-trial.gates.spec.ts` asserts both are still in the code).

## 11. Late / repeated callback: what is done locally and what only REIS can settle

- **Done:** the callback is bound to the exact revision through our own persisted case (`callback-revision-binding.integration.spec.ts`); a repeat is a `DUPLICATE`
  and cannot change the stored decision; an older identity cannot match; revision N+1 is not sent while N awaits its callback (workflow).
  New, **opt-in (default off, not wired)**: `reopenForAmendment(..., { quietPeriodMs })` holds revision N+1 for a period after N's final decision so late repeats drain
  first (`amendment-quiet-period.integration.spec.ts`). It is wired when the CIF workflow replaces the hold; REIS retries a callback until it receives a 200, so the period should cover REIS's last retry.
- **Cannot be settled without REIS:** a repeat of revision N's decision that arrives while revision N+1 of the same identity is pending is indistinguishable from the decision for N+1
  (no revision field, same `systemId`). Only a revision/request id in the callback (Q-V3), or REIS confirming it never repeats a callback after a 200, removes the ambiguity.
  The single trial sends one revision, so this does not affect it.

## 12. Deliverables we need back (an answer such as "yes, it works" is not accepted)

### From Finexta (written, with the artifact)

| # | Artifact | Accepted only if it contains |
| --- | --- | --- |
| F1 | A reviewed read-only `SELECT` (bind variables `:kycRefNo`, `:seqNo`, one row, one string column `CIF_VALUE`) + a one-paragraph description | schema, table, column, data type, join to `STTM_KYC_MASTER`, cardinality, how leading zeros are kept, and the sentence "the CIF exists and is committed before the KYC is saved/authorized" (or the alternative lifecycle); explicit statement that `00005804` belongs to `001ZKYC26151003Y` |
| F2 | The output of `status-contract.json` (or the DDL, CHECK constraints and triggers of `STTM_KYC_REIS_PAYLOAD_CUSTOM`) | the exact list of values accepted by `REIS_FINAL_STATUS` and `PROCESS_STATUS`, names of the constraints and triggers |
| F3 | A table: for each of `CLEAN`, `PENDING`, `BLOCKED`, `NULL` → effect on account opening, activation and operations of an already active account; plus the name of the object that reads the column | one row per value; which `SEQ_NO` is read when several exist |
| F4 | Confirmation that `W` is accepted as the in-progress `PROCESS_STATUS` (or the value to use) | the constraint text |
| F5 | The column that holds I/C in `STTM_KYC_CORP_KEYPERSONS` and the value mapping | column name and the list of values with their meaning |
| F6 | Confirmation that Occupation, Account Purpose and Total Income are mandatory on save | screen/rule reference |

### From Vneuron (written)

| # | Answer | Accepted only if it contains |
| --- | --- | --- |
| V1 | Result of a check of `systemId` = `001ZKYC26151003Y` and `00005804` in UAT **without** calling the state-changing endpoint | date, who checked, how, result for each identity |
| V2 | Rule for `systemId` = CIF | accepted yes/no; same CIF again = update or new customer; how a customer previously sent under the KYC reference is linked or migrated |
| V3 | How a callback identifies the request | the name of the field (revision id / request id returned by onboarding) **or** the statement that none exists and that a callback is never repeated after a 200 |
| V4 | Status table | onboarding `CLEAN`/`PENDING`/`REJECT` and callback `CUSTOMER`/`BLOCKED`: final or not, can it change later, how a later change is notified, is `REJECT` equal to `BLOCKED` |
| V5 | Timeout/idempotency | is a repeated identical request safe; expected and maximum response time |
| V6 | Callback delivery | retry schedule, timeout, the exact status field name (`Status` vs `status`), authentication |
