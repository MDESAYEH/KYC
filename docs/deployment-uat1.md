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
git rev-parse HEAD > /root/kyc-backup-$STAMP/commit.txt
echo $STAMP > /root/kyc-backup-latest.txt
```

**The SQLite file is backed up in step 2, with the tool, not with `cp`.** Copying a database file that is open can lose
committed transactions (they may still be in the `-wal` file) or capture a half-written page. `npm run backup:sqlite` uses
SQLite's online backup API: a consistent snapshot while the service keeps running, verified with `integrity_check`, never
overwriting an existing file, with its size and SHA-256 printed. (The tool is part of the reviewed commit, so it exists only
after step 2 has built it; the SQLite file itself is not changed by the update.)

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
STAMP=$(cat /root/kyc-backup-latest.txt)
npm run backup:sqlite -- /root/kyc-backup-$STAMP/kyc-local.sqlite   # consistent snapshot; note the SHA-256 it prints
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
```

Decisions that need a person (see the PR): the in-progress status the CHECK constraint accepts
(`FLEXCUBE_STAGING_STATUS_IN_PROGRESS`), the cut-off (`FLEXCUBE_SYNC_START_DATE`), whether to restore the rows closed as `E`
by the incident (needs the attestation, backup and rollback plan in `docs/flexcube-sync.md`), and the key-person type column (Finexta). Only then, with approval, set
`FLEXCUBE_POLL_ENABLED=true` and restart; watch `flexcube.sync.run` and `flexcube.sync.circuitOpened` in the journal.

## 5. Rollback (back to the previous commit)

The database restore below is conditional: do it only after confirming database damage. Restoring an old snapshot can
lose newer local case/callback evidence while Oracle and REIS keep their state. Keep polling off and reconcile those
systems before any later enablement. Replace the sample SQLite path with the configured DB_SQLITE_PATH.

```bash
cd /opt/KYC
sudo systemctl stop kyc.service
git checkout --detach $(cat /root/kyc-backup-<STAMP>/commit.txt)
npm ci && npm run build
cp -p /root/kyc-backup-<STAMP>/env.bak .env && chmod 600 .env      # only if .env was edited
# only if the local database was damaged (service stopped): move the damaged file and its -wal / -shm aside, never delete them
DAMAGED=/root/kyc-backup-<STAMP>/damaged-$(date +%s)
mkdir -m 700 "$DAMAGED"
for FILE in var/kyc-local.sqlite var/kyc-local.sqlite-wal var/kyc-local.sqlite-shm; do
  if [ -e "$FILE" ]; then mv -- "$FILE" "$DAMAGED/"; fi
done
cp -p /root/kyc-backup-<STAMP>/kyc-local.sqlite var/kyc-local.sqlite
chmod 600 var/kyc-local.sqlite
# Confirm FLEXCUBE_POLL_ENABLED=false in the restored .env BEFORE starting the old code.
sqlite3 var/kyc-local.sqlite "PRAGMA integrity_check;" 2>/dev/null || node -e "console.log(new (require('better-sqlite3'))('var/kyc-local.sqlite').pragma('integrity_check', {simple:true}))"
sudo systemctl start kyc.service
```

Keep `FLEXCUBE_POLL_ENABLED=false` after a rollback until the cause is understood: the code before this fix fails every
claim with ORA-01745 and turns rows into `E`.

## What this procedure never does

- never edits `/opt/aiib-dashboard`, the systemd unit, the port, the user or the firewall;
- never writes to Oracle (the reconciliation tool is a dry run unless a person adds `--apply`, a backup file and the
  confirmation word);
- never prints `.env`, credentials, tokens or customer data.
