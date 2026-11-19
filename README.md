> **Status (19/11/2026):** see [docs/STATUS.md](docs/STATUS.md). The first KYC was sent to REIS UAT through the single-trial tool and came back CLEAN. Automatic polling is still disabled (CIF submission hold) until it is wired to the trigger table.

# KYC Integration API (FLEXCUBE <-> REIS)

Bank integration layer between **Oracle FLEXCUBE** and the **REIS** KYC service (KYC scope only).
NestJS 11 / TypeScript 5.9, TypeORM, oracledb (Thin mode), Jest.

## How it works

```
FLEXCUBE (STTM_KYC_* tables)                         REIS
        |  read-only SELECT                            ^
        v                                              | onboarding (formId 1-4, relations nested)
  poller (every 1-5 min) --> validate + map --> REIS client
        |                                              |
        |  staging table STTM_KYC_REIS_PAYLOAD_CUSTOM  |  POST /customerStatus (webhook, bearer)
        +<---------------- result / final status ------+
```

1. The poller reads open KYCs saved in FLEXCUBE since `FLEXCUBE_SYNC_START_DATE` that have no
   staging row for their current `MOD_NO`.
2. It validates and maps them (Latin-only names, mandatory fields, reference mappings) and calls
   REIS. Corporate customers carry their key persons as `relations` in the same call.
3. The result is written to the staging table (`REIS_FINAL_STATUS` = `APPROVED` / `BLOCKED`).
   PENDING decisions arrive later on `POST /customerStatus`.

FLEXCUBE never calls this service. Details: [docs/flexcube-sync.md](docs/flexcube-sync.md),
[docs/workflow.md](docs/workflow.md), [docs/transformation.md](docs/transformation.md).

## Requirements

- Node.js >= 20 and npm
- Network access to REIS and to the FLEXCUBE database (no Oracle Client needed: Thin mode)

## Setup

```bash
npm ci
```

```bash
cp .env.example .env
```

Fill in `.env` (it is git-ignored; **never commit it**):

| Group | Variables |
| --- | --- |
| REIS | `REIS_BASE_URL` (https in production), `REIS_TENANT`, `REIS_USERNAME`, `REIS_PASSWORD`, `REIS_TIMEOUT_MS`, optional `REIS_SYSTEM_NAME` (default `Flexcube`) |
| Webhook | `WEBHOOK_SECURITY_MODE=bearer`, `WEBHOOK_BEARER_TOKEN` (>= 32 chars, share with REIS over a secure channel) |
| FLEXCUBE DB | `FLEXCUBE_DB_USER`, `FLEXCUBE_DB_PASSWORD`, `FLEXCUBE_DB_CONNECT_STRING` (`host:port/SERVICE`), optional `FLEXCUBE_DB_SCHEMA`, `FLEXCUBE_STAGING_TABLE` |
| Polling | `FLEXCUBE_POLL_ENABLED=true`, `FLEXCUBE_POLL_INTERVAL_MS` (60000-300000), `FLEXCUBE_POLL_BATCH_SIZE` (1-200), **`FLEXCUBE_SYNC_START_DATE`** (mandatory when polling is on, e.g. `2026-11-16` or `2026-11-16T08:00:00`) |
| Local DB | `DB_TYPE=sqlite`, `DB_SQLITE_PATH` (local dev/test only) |

Generate a webhook token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Prepare the integration layer's own database and the agreed reference lists:

```bash
npm run migration:run
npm run mappings:seed
```

## Run

| Purpose | Command |
| --- | --- |
| Development (watch) | `npm run start:dev` |
| Production | `npm run build` then `npm run start:prod` |
| Tests | `npm test` |
| Lint / format | `npm run lint` / `npm run format` |
| Type check | `npx tsc --noEmit` |

Polling is **off** unless `FLEXCUBE_POLL_ENABLED=true`. With polling enabled the service refuses to
start without the FLEXCUBE database settings and a valid `FLEXCUBE_SYNC_START_DATE`.

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /health/live`, `GET /health/ready` | Liveness / readiness |
| `POST /customerStatus` | REIS final-status callback. Header `Authorization: Bearer <WEBHOOK_BEARER_TOKEN>`. Accepts `status` or `Status` (both with different values = rejected). |

## First run on UAT1

Read-only diagnostic (connection, tables and columns, staging privileges, pending KYCs, dry run
through validation and mapping; REIS is not called, nothing is written, no customer data in the
report):

```bash
npm run check:uat1
```

Polling stays disabled for now. See [docs/setup.md](docs/setup.md) and [docs/STATUS.md](docs/STATUS.md).

## Operations

- UAT1 deployment, backup and rollback: [docs/deployment-uat1.md](docs/deployment-uat1.md).
- Safety of the staging rows, circuit breaker, logs and send guard: [docs/flexcube-sync.md](docs/flexcube-sync.md).
- Trigger table (STTM_CUSTOMER_CUSTOM, SEQ_NO = CIF MOD_NO): [docs/customer-trigger-table.md](docs/customer-trigger-table.md).
- Single-KYC trial and its reset (`npm run trial:one`, `npm run trial:reset`): [docs/single-kyc-trial-runbook.md](docs/single-kyc-trial-runbook.md).

## Security notes

- Credentials come only from the environment / `.env`; TLS certificate validation is never disabled.
- FLEXCUBE SQL is read-only except `INSERT` / `UPDATE` on the staging table (no `DELETE`); bind variables only.
- Logs, errors and reports name fields, never customer values.
- Webhook default is deny-all; `unrestricted-dev` is refused in production.

## Documentation

All documents are in [docs/](docs/): [workflow](docs/workflow.md), [FLEXCUBE sync](docs/flexcube-sync.md),
[transformation](docs/transformation.md), [REIS transport](docs/reis-transport.md),
[webhook](docs/customer-status-webhook.md), [persistence](docs/persistence.md),
[operations](docs/operations.md), [callback revision binding](docs/callback-revision-binding.md),
[isolated Oracle tests](docs/isolated-oracle-tests.md), [current status](docs/STATUS.md).
