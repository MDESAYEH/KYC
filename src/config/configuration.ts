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
    /** Poll the FLEXCUBE trigger table (FLEXCUBE_POLL_ENABLED=true). Off by default. */
    pollEnabled: boolean;
    /** Pause between two passes (FLEXCUBE_POLL_INTERVAL_MS, minimum 1000, default 10000). */
    pollIntervalMs: number;
    /** Maximum KYCs taken per pass. */
    pollBatchSize: number;
    /**
     * Cut-off (FLEXCUBE_SYNC_START_DATE, ISO date/timestamp) compared with STTM_KYC_MASTER.MAKER_DT_STAMP.
     * Mandatory when polling is enabled (validated at startup).
     */
    syncStartDate: string | undefined;
    /** Staging PROCESS_STATUS of a claimed row (FLEXCUBE_STAGING_STATUS_IN_PROGRESS, default W). */
    stagingStatusInProgress: string;
    /** Column of STTM_KYC_CORP_KEYPERSONS holding the party type I / C (FLEXCUBE_KEYPERSON_TYPE_COLUMN). */
    keypersonTypeColumn: string;
    /** Attempts per CIF revision before it is set to E (FLEXCUBE_SYNC_MAX_ATTEMPTS, default 5). */
    syncMaxAttempts: number;
    /** Wait before another attempt (FLEXCUBE_SYNC_RETRY_DELAY_MS, default 60000). */
    syncRetryDelayMs: number;
    /** Only these CIFs are sent (FLEXCUBE_SYNC_CIF_ALLOWLIST, comma separated). Empty = every CIF. */
    syncCifAllowlist: string[];
  };
  /** Production DB is TBD. sqlite (local dev/test only) is the only supported type for now. */
  database: { type: string; sqlitePath: string | undefined };
}

const num = (v: string | undefined): number | undefined =>
  v !== undefined && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined;
const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(v)));
const atLeast = (v: number, min: number): number => Math.max(min, Math.round(v));
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
    },
    flexcube: {
      dbUser: str(env.FLEXCUBE_DB_USER),
      dbPassword: str(env.FLEXCUBE_DB_PASSWORD),
      dbConnectString: str(env.FLEXCUBE_DB_CONNECT_STRING),
      dbSchema: str(env.FLEXCUBE_DB_SCHEMA),
      stagingTable: str(env.FLEXCUBE_STAGING_TABLE) ?? 'STTM_KYC_REIS_PAYLOAD_CUSTOM',
      pollEnabled: env.FLEXCUBE_POLL_ENABLED === 'true',
      pollIntervalMs: atLeast(num(env.FLEXCUBE_POLL_INTERVAL_MS) ?? 10_000, 1_000),
      pollBatchSize: clamp(num(env.FLEXCUBE_POLL_BATCH_SIZE) ?? 20, 1, 200),
      syncStartDate: str(env.FLEXCUBE_SYNC_START_DATE),
      stagingStatusInProgress: str(env.FLEXCUBE_STAGING_STATUS_IN_PROGRESS) ?? 'W',
      keypersonTypeColumn: str(env.FLEXCUBE_KEYPERSON_TYPE_COLUMN) ?? 'KYC_KEYPERSON_TYPE',
      syncMaxAttempts: atLeast(num(env.FLEXCUBE_SYNC_MAX_ATTEMPTS) ?? 5, 1),
      syncRetryDelayMs: atLeast(num(env.FLEXCUBE_SYNC_RETRY_DELAY_MS) ?? 60_000, 1_000),
      syncCifAllowlist: (env.FLEXCUBE_SYNC_CIF_ALLOWLIST ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    },
    database: {
      type: env.DB_TYPE ?? 'sqlite',
      // Local default only outside production; production must configure explicitly.
      sqlitePath:
        str(env.DB_SQLITE_PATH) ??
        ((env.NODE_ENV ?? 'development') === 'production' ? undefined : './var/kyc-local.sqlite'),
    },
  };
}
