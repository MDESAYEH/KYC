/**
 * Typed, env-based configuration. No secrets, URLs or credentials have defaults in code.
 * Values are read from process.env (populated by the deployment's secret store / .env).
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  reis: {
    baseUrl: string | undefined;
    tenant: string | undefined;
    userName: string | undefined;
    password: string | undefined;
    timeoutMs: number | undefined;
    /** REIS systemName sent on every request. Confirmed value: "Flexcube". */
    systemName: string;
  };
  webhook: {
    /** 'bearer' (agreed with Reis, V1.4) | 'unrestricted-dev' (dev/test only). Unset = deny all. */
    securityMode: string | undefined;
    /** Token Reis sends as "Authorization: Bearer <token>" (WEBHOOK_BEARER_TOKEN). Secret. */
    bearerToken: string | undefined;
    apiKey: string | undefined;
    ipAllowlist: string[];
  };
  /**
   * FLEXCUBE Oracle database (UAT1 / PROD). Used to write the staging table
   * STTM_KYC_REIS_PAYLOAD_CUSTOM. Unset outside production = mock updater (dev/test only).
   */
  flexcube: {
    dbUser: string | undefined;
    dbPassword: string | undefined;
    dbConnectString: string | undefined;
    /** Optional owner schema of the FLEXCUBE tables (FLEXCUBE_DB_SCHEMA), e.g. FCUBS. */
    dbSchema: string | undefined;
    stagingTable: string;
    /** Poll FLEXCUBE for saved KYCs (FLEXCUBE_POLL_ENABLED=true). Off by default. */
    pollEnabled: boolean;
    /** Agreed 1-5 minutes; default 2 minutes. */
    pollIntervalMs: number;
    /** Maximum KYCs taken per pass. */
    pollBatchSize: number;
    /**
     * Cut-off (FLEXCUBE_SYNC_START_DATE, ISO date/timestamp) compared with
     * STTM_KYC_MASTER.MAKER_DT_STAMP. Mandatory when polling is enabled (validated at startup).
     */
    syncStartDate: string | undefined;
    /** Staging PROCESS_STATUS of a claimed row (FLEXCUBE_STAGING_STATUS_IN_PROGRESS, default W). */
    stagingStatusInProgress: string;
    /** Column of STTM_KYC_CORP_KEYPERSONS holding the party type I / C (FLEXCUBE_KEYPERSON_TYPE_COLUMN). */
    keypersonTypeColumn: string;
    /**
     * Canary (FLEXCUBE_SYNC_ONLY_KYC_REF_NOS, comma separated, max 5): when set, a pass only ever
     * takes these KYCs (pending and recovery). Empty = normal operation. Off by default.
     */
    syncOnlyKycRefNos: string[];
    /**
     * Send-guard acknowledgements (FLEXCUBE_SYNC_UNCERTAIN_ACK, comma separated KYC_REF_NO:SEQ_NO):
     * rows whose uncertain delivery was reconciled by an operator and may no longer block sending.
     */
    syncUncertainAck: string[];
  };
  /** Production DB is TBD. sqlite (local dev/test only) is the only supported type for now. */
  database: { type: string; sqlitePath: string | undefined };
  retry: { maxAttempts: number | undefined; baseDelayMs: number | undefined };
}

const num = (v: string | undefined): number | undefined =>
  v !== undefined && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined;
const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(v)));
const str = (v: string | undefined): string | undefined =>
  v !== undefined && v.trim() !== '' ? v : undefined;

export function loadConfiguration(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: num(env.PORT) ?? 3000,
    reis: {
      baseUrl: str(env.REIS_BASE_URL),
      tenant: str(env.REIS_TENANT),
      userName: str(env.REIS_USERNAME),
      password: str(env.REIS_PASSWORD),
      timeoutMs: num(env.REIS_TIMEOUT_MS),
      systemName: str(env.REIS_SYSTEM_NAME) ?? 'Flexcube',
    },
    webhook: {
      securityMode: str(env.WEBHOOK_SECURITY_MODE),
      bearerToken: str(env.WEBHOOK_BEARER_TOKEN),
      apiKey: str(env.WEBHOOK_API_KEY),
      ipAllowlist: (env.WEBHOOK_IP_ALLOWLIST ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    flexcube: {
      dbUser: str(env.FLEXCUBE_DB_USER),
      dbPassword: str(env.FLEXCUBE_DB_PASSWORD),
      dbConnectString: str(env.FLEXCUBE_DB_CONNECT_STRING),
      dbSchema: str(env.FLEXCUBE_DB_SCHEMA),
      stagingTable: str(env.FLEXCUBE_STAGING_TABLE) ?? 'STTM_KYC_REIS_PAYLOAD_CUSTOM',
      pollEnabled: env.FLEXCUBE_POLL_ENABLED === 'true',
      pollIntervalMs: clamp(num(env.FLEXCUBE_POLL_INTERVAL_MS) ?? 120_000, 60_000, 300_000),
      pollBatchSize: clamp(num(env.FLEXCUBE_POLL_BATCH_SIZE) ?? 20, 1, 200),
      syncStartDate: str(env.FLEXCUBE_SYNC_START_DATE),
      stagingStatusInProgress: str(env.FLEXCUBE_STAGING_STATUS_IN_PROGRESS) ?? 'W',
      keypersonTypeColumn: str(env.FLEXCUBE_KEYPERSON_TYPE_COLUMN) ?? 'KYC_KEYPERSON_TYPE',
      syncOnlyKycRefNos: list(env.FLEXCUBE_SYNC_ONLY_KYC_REF_NOS),
      syncUncertainAck: list(env.FLEXCUBE_SYNC_UNCERTAIN_ACK),
    },
    database: {
      type: env.DB_TYPE ?? 'sqlite',
      // Local default only outside production; production must configure explicitly.
      sqlitePath:
        str(env.DB_SQLITE_PATH) ??
        ((env.NODE_ENV ?? 'development') === 'production' ? undefined : './var/kyc-local.sqlite'),
    },
    retry: { maxAttempts: num(env.RETRY_MAX_ATTEMPTS), baseDelayMs: num(env.RETRY_BASE_DELAY_MS) },
  };
}

/** Config keys that must never appear in logs or persistence. */
export const SENSITIVE_CONFIG_PATHS = [
  'reis.password',
  'webhook.apiKey',
  'webhook.bearerToken',
  'flexcube.dbPassword',
] as const;
