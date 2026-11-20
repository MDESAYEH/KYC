# KYC Integration API (FLEXCUBE <-> REIS)

Bank integration layer between **Oracle FLEXCUBE** and the **REIS** KYC service (KYC scope only).
NestJS 11 / TypeScript 5.9, TypeORM (SQLite), oracledb (Thin mode). Current state: [docs/STATUS.md](docs/STATUS.md).

## How it works

```
FCUBS: CIF created / modified + authorized
   -> STTM_CUSTOMER_CUSTOM.READY_TO_SCAN = U
                    |
   poller (every FLEXCUBE_POLL_INTERVAL_MS) reads U rows + KYC details (read-only)
                    |
   staging row N -> W, trigger U -> P -> REIS onboarding (systemId = CIF)
                    |
   staging S + REIS_FINAL_STATUS (CLEAN / BLOCKED)      REIS PENDING -> later POST /customerStatus
   failure: retried (N, RETRY_COUNT + 1) up to FLEXCUBE_SYNC_MAX_ATTEMPTS, then staging E + trigger E
```

FLEXCUBE never calls this service. FCUBS allows account opening only when `REIS_FINAL_STATUS = CLEAN` on the row with
the highest `SEQ_NO` of the KYC. Details: [docs/flexcube-sync.md](docs/flexcube-sync.md).

## Setup

```bash
npm ci
cp .env.example .env          # fill it in; never commit it
npm run migration:run         # local database
npm run mappings:seed         # agreed reference lists (safe to run again)
npm run build
```

Every variable is described in [.env.example](.env.example).

## Run

| Purpose | Command |
| --- | --- |
| Server (always on) | systemd unit [deploy/kyc.service](deploy/kyc.service) (`node dist/main.js`, `Restart=always`) |
| Local development | `npm run start:dev` |
| Lint / format / type check | `npm run lint` / `npm run format` / `npx tsc --noEmit` |
| Oracle parse-only check of every SQL statement | `npm run check:oracle-sql` |
| Consistent copy of the local SQLite database | `npm run backup:sqlite -- <target file>` |

Deployment on UAT1: [docs/deployment-uat1.md](docs/deployment-uat1.md).

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /health/live`, `GET /health/ready` | Liveness / readiness |
| `POST /customerStatus` | REIS final-status callback, `Authorization: Bearer <WEBHOOK_BEARER_TOKEN>` ([docs](docs/customer-status-webhook.md)) |

## Layout

| Folder | Content |
| --- | --- |
| `src/flexcube-sync` | poller: scheduler and `TriggerSyncService` (retry, staging, trigger) |
| `src/flexcube` | FLEXCUBE SQL: trigger table, KYC details, staging repository, final-status updater, mapper |
| `src/kyc` | `KycWorkflow` (one submission) and failure classification |
| `src/reis` | REIS transformer, auth / onboarding clients, transport |
| `src/webhook` | `POST /customerStatus` |
| `src/persistence`, `src/mapping` | local database (cases, callback audit, reference mappings) |
| `src/tools` | `check:oracle-sql`, `backup:sqlite` |

## Security

- Credentials only in `.env`; TLS certificate validation is never disabled.
- FLEXCUBE SQL: SELECT, plus INSERT / UPDATE on the staging table and UPDATE of `READY_TO_SCAN`; never DELETE; binds only.
- Logs carry the KYC reference, codes and counts; never names, payloads or tokens.
- The webhook denies everything unless `WEBHOOK_SECURITY_MODE=bearer` and a token are set.
