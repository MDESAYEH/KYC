# Deploying on the UAT1 server (/opt/KYC)

Scope: only `/opt/KYC` and the `kyc.service` unit. The CEO dashboard on the same host (`/opt/aiib-dashboard`, its
next-server and squid) is never touched.

## Update

```bash
cd /opt/KYC
git status --short                                   # must be clean
git rev-parse --short HEAD > /root/kyc-previous-commit.txt
STAMP=$(date +%Y%m%d-%H%M%S); mkdir -m 700 /root/kyc-backup-$STAMP
cp -p .env /root/kyc-backup-$STAMP/env.bak
sudo systemctl stop kyc.service
npm run backup:sqlite -- /root/kyc-backup-$STAMP/kyc-local.sqlite
git pull --ff-only origin main
npm ci
npm run build
npm run migration:run
```

## Run as a service (always on, restarted on failure)

```bash
sudo cp deploy/kyc.service /etc/systemd/system/kyc.service
sudo systemctl daemon-reload
sudo systemctl enable --now kyc.service
```

The unit runs `node dist/main.js` (not the watcher) with `Restart=always` and `NODE_EXTRA_CA_CERTS=/etc/kyc/aiib-ca.pem`.
An older drop-in `/etc/systemd/system/kyc.service.d/ca.conf` setting the same variable can stay.

## .env for automatic sending

```
FLEXCUBE_POLL_ENABLED=true
FLEXCUBE_POLL_INTERVAL_MS=10000
FLEXCUBE_SYNC_START_DATE=            # optional cut-off; empty = every U row
FLEXCUBE_SYNC_MAX_ATTEMPTS=5
FLEXCUBE_SYNC_RETRY_DELAY_MS=60000
FLEXCUBE_SYNC_CIF_ALLOWLIST=            # empty = every CIF FCUBS sets to U
```

Removed settings (ignored if still present): `FLEXCUBE_SYNC_ALL_CIFS`, `FLEXCUBE_SYNC_UNCERTAIN_ACK`,
`FLEXCUBE_FINAL_STATUS_VOCABULARY` (the words are always CLEAN / BLOCKED), `RETRY_MAX_ATTEMPTS`, `RETRY_BASE_DELAY_MS`.

## Check

```bash
systemctl is-active kyc.service
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/health/live          # 200
journalctl -u kyc.service -n 50 --no-pager | grep -E "flexcube\.(sync|trigger)"
npm run check:oracle-sql                                                             # parse only
```

## Rollback

```bash
cd /opt/KYC
sudo systemctl stop kyc.service
git checkout --detach $(cat /root/kyc-previous-commit.txt)
npm ci && npm run build
cp -p /root/kyc-backup-<STAMP>/env.bak .env && chmod 600 .env
sudo systemctl start kyc.service
```

The previous commit ran with `npm run start:dev`; restore the old unit file if it was replaced. Restore the SQLite copy
only after confirming the local database is damaged (service stopped; move the damaged file and its `-wal` / `-shm`
aside, never delete them).
