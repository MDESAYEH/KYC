# Deploying a fix to the UAT1 server (/opt/KYC) and rolling back

Scope: only `/opt/KYC` and the `kyc.service` unit. **`/opt/aiib-dashboard` is never touched** (no command below
reads or writes it). Nothing here changes the systemd unit, the port or the user: that needs its own plan and approval.
Polling (`FLEXCUBE_POLL_ENABLED`) stays **false** during the whole procedure and is switched on only by a person, on purpose.

## Why the order matters

`kyc.service` runs `npm run start:dev` (`nest start --watch`). The watcher **reloads the application as soon as files
change**, so a `git reset --hard` on a running service restarts it on a half-updated tree. On 17/11/2026 that is how the
new code started polling immediately. Therefore: polling off first, service stopped, then update.

## 0. Before (read only)

```bash
cd /opt/KYC
git status --short            # must be clean: do not overwrite another person's changes
git rev-parse --short HEAD    # note the CURRENT commit (the rollback target)
systemctl is-active kyc.service
grep -c '^FLEXCUBE_POLL_ENABLED=true' .env   # prints 0 when polling is off (the value is not shown)
ls -l .env                    # permissions only
```

## 1. Backup (so the rollback is complete)

```bash
cd /opt/KYC
STAMP=$(date +%Y%m%d-%H%M%S); mkdir -p /root/kyc-backup-$STAMP && chmod 700 /root/kyc-backup-$STAMP
cp -p .env /root/kyc-backup-$STAMP/env.bak && chmod 600 /root/kyc-backup-$STAMP/env.bak
cp -p var/kyc-local.sqlite /root/kyc-backup-$STAMP/ 2>/dev/null || echo "set DB_SQLITE_PATH backup by hand"
git rev-parse HEAD > /root/kyc-backup-$STAMP/commit.txt
```

Oracle is **not** changed by this procedure. Save the read-only report before and after: `npm run check:uat1`
(writes `uat1-check-report.json`; it contains counts only).

## 2. Stop, update, build (polling stays off)

```bash
cd /opt/KYC
sudo systemctl stop kyc.service
git fetch origin
git checkout --detach <the reviewed commit or tag>      # not main until the change was approved and merged
npm ci
npm run build
npm test                                                 # must pass; no .env is read by the tests
```

If `FLEXCUBE_POLL_ENABLED=true` is in `.env`, set it to `false` **before** the next step (edit the line by hand; do not
paste the file anywhere).

## 3. Start and verify (still polling off)

```bash
sudo systemctl start kyc.service
sleep 5
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/health/live     # 200
curl -s http://127.0.0.1:3000/health/ready                                       # database up, configuration ok
journalctl -u kyc.service -n 30 --no-pager | grep -c "flexcube.sync.started"      # 0: no polling
```

Note: `/health/ready` checks the local SQLite database and the configuration only, **not Oracle**. Use `npm run check:uat1`
for Oracle.

## 4. Read-only checks before anyone enables polling

```bash
npm run check:uat1               # constraints, triggers, row classification, key-person column (SELECT only)
npm run check:oracle-sql         # PARSE ONLY: Oracle parses every statement, nothing is executed
npm run reconcile:staging        # DRY RUN: counts only, writes nothing
```

`check:oracle-sql` is the Oracle evidence for the ORA-01745 fix on the real UAT1 objects (synonyms, columns,
privileges): it uses `connection.getStatementInfo()` only. No UPDATE / ROLLBACK is ever run on the bank database to
"test" a statement. The N -> W transition and the CHECK constraint behaviour are tested on an ISOLATED Oracle schema
(`test/oracle-staging.sql.integration.spec.ts`, skipped unless explicitly enabled), never on UAT1.

Decisions that need a person (see the PR): the in-progress status the CHECK constraint accepts
(`FLEXCUBE_STAGING_STATUS_IN_PROGRESS`), the cut-off (`FLEXCUBE_SYNC_START_DATE`), whether to restore the rows closed as `E`
by the incident (`docs/flexcube-sync.md`), and the key-person type column (Finexta). Only then, with approval, set
`FLEXCUBE_POLL_ENABLED=true` and restart; watch `flexcube.sync.run` and `flexcube.sync.circuitOpened` in the journal.

## 6. Canary: test ONE KYC (e.g. Tareq's `001ZKYC26151003Y`) without exposing the other rows

Every step needs an explicit approval. Polling stays off until step 4.

1. Dry run for that KYC only (SELECT only):
   ```bash
   npm run reconcile:staging -- --kyc 001ZKYC26151003Y
   ```
   Expected: `scope: one-kyc`, `candidates: 1`, `eligible: 1`. Anything else: stop.
2. Restore that one row (E -> N), backup first, every condition re-checked by the UPDATE:
   ```bash
   KYC_RECONCILE_CONFIRM=RESTORE_NEVER_SENT_ROWS npm run reconcile:staging -- \
     --kyc 001ZKYC26151003Y --apply --backup-file /root/kyc-reconcile-<STAMP>.jsonl
   ```
   Expected: `restored: 1`. The backup holds every original value (MSGID, RESPONSE, RETRY_COUNT, RES_DATE...).
3. In `.env`: `FLEXCUBE_SYNC_ONLY_KYC_REF_NOS=001ZKYC26151003Y` (and keep `FLEXCUBE_SYNC_UNCERTAIN_ACK` empty).
4. Set `FLEXCUBE_POLL_ENABLED=true`, restart. The journal must show `flexcube.sync.canaryMode` with `kycCount: 1`.
   A pass now takes ONLY that KYC, from pending and from recovery; the other 57 rows stay `E`, the Finexta row stays
   untouched, and a second check in the service skips any other KYC.
5. Watch one or two passes, then set `FLEXCUBE_POLL_ENABLED=false` and restart. Check the row:
   `PROCESS_STATUS = S` with REQUEST / RESPONSE, and for CLEAN / REJECT `REIS_FINAL_STATUS` APPROVED / BLOCKED.
6. If anything is wrong: polling off, then roll the row back (only while it is still N, never after a send):
   ```bash
   npm run reconcile:staging -- --rollback /root/kyc-reconcile-<STAMP>.jsonl            # dry run
   KYC_RECONCILE_CONFIRM=ROLLBACK_RESTORED_ROWS npm run reconcile:staging -- \
     --rollback /root/kyc-reconcile-<STAMP>.jsonl --apply
   ```

**Send guard.** If the request may have reached REIS without a stored result (timeout, error after the call, result not
saved), the row is closed as `E` with `"delivery":"UNCERTAIN"` (or left in progress) and the service sends NOTHING more,
also after a restart (`flexcube.sync.sendingHalted`). Check with Vneuron whether REIS received it; once reconciled, list it
in `FLEXCUBE_SYNC_UNCERTAIN_ACK=KYC_REF_NO:SEQ_NO` and restart. The row itself is never resent automatically.

Only after a successful canary: empty `FLEXCUBE_SYNC_ONLY_KYC_REF_NOS`, decide about the other rows
(`reconcile:staging -- --all`, same backup / confirmation rules), and enable polling for everyone.

## 5. Rollback (back to the previous commit)

```bash
cd /opt/KYC
sudo systemctl stop kyc.service
git checkout --detach $(cat /root/kyc-backup-<STAMP>/commit.txt)
npm ci && npm run build
cp -p /root/kyc-backup-<STAMP>/env.bak .env && chmod 600 .env      # only if .env was edited
cp -p /root/kyc-backup-<STAMP>/kyc-local.sqlite var/kyc-local.sqlite   # only if the local database was damaged
sudo systemctl start kyc.service
```

Keep `FLEXCUBE_POLL_ENABLED=false` after a rollback until the cause is understood: the code before this fix fails every
claim with ORA-01745 and turns rows into `E`.

## What this procedure never does

- never edits `/opt/aiib-dashboard`, the systemd unit, the port, the user or the firewall;
- never writes to Oracle (the reconciliation tool is a dry run unless a person adds a scope `--kyc` / `--all`, `--apply`,
  a backup file and the confirmation word; `check:oracle-sql` only parses);
- never prints `.env`, credentials, tokens or customer data.
