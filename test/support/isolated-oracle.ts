/**
 * Safety guard for the REAL-Oracle tests (B3 / B5). They create and drop their own randomly named tables, so they
 * may run ONLY against a disposable Oracle (e.g. the local container in docker/oracle-isolated) and NEVER against
 * bank UAT1 / PROD. Nothing is read from .env; everything comes from the shell, and a connection that looks like the
 * application's own FLEXCUBE connection is refused before any statement runs.
 *
 *   <PREFIX>_USER / _PASSWORD / _CONNECT  the disposable schema (host:port/SERVICE)
 *   <PREFIX>_CONFIRM                      the exact confirmation phrase of that spec
 *
 * Layers (a hostname check alone is NOT enough: an SSH tunnel makes a bank database look like localhost):
 *   1. exact confirmation phrase + all values from the shell, never from .env;
 *   2. loopback hosts only. There is deliberately NO environment override that widens this list (an inherited
 *      variable must never be able to admit a bank host); a sandbox on another host needs a reviewed code change;
 *   3. refuse bank / system users and the application's own FLEXCUBE_DB_* connection and user when set in the shell;
 *   4. assertDisposableDatabase(): AFTER connecting and BEFORE creating anything, refuse any database that contains
 *      FLEXCUBE objects (STTM_* / FLTM_* / CSTM_*) or whose service / database name looks like UAT / PROD / FCUBS.
 *      This is the layer that stops a tunnel to the bank, whatever the host and the variables say.
 */
export interface IsolatedOracleConfig {
  user: string;
  password: string;
  connectString: string;
}

const ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];
const BANK_USERS = ['REIS_KYC', 'OBPPRD', 'FCUBS', 'SYS', 'SYSTEM'];

/** Host of an EZConnect string "host[:port][/service]" (or "//host..."), lower case; null if unparsable. */
export function connectHost(connect: string): string | null {
  const m = /^(?:\/\/)?(\[[^\]]+\]|[^:/\s]+)/.exec(connect.trim());
  return m ? m[1].replace(/^\[|\]$/g, '').toLowerCase() : null;
}

/**
 * Returns the configuration when the spec is explicitly enabled AND every safety check passes; null when it is simply
 * not enabled (the spec is skipped). Throws when it IS enabled but unsafe, so a mistake is loud, never silent.
 */
export function isolatedOracleConfig(
  prefix: string,
  confirmPhrase: string,
  env: NodeJS.ProcessEnv = process.env,
): IsolatedOracleConfig | null {
  const user = env[`${prefix}_USER`];
  const password = env[`${prefix}_PASSWORD`];
  const connectString = env[`${prefix}_CONNECT`];
  if (env[`${prefix}_CONFIRM`] !== confirmPhrase || !user || !password || !connectString)
    return null;

  const host = connectHost(connectString);
  if (host === null || !ALLOWED_HOSTS.includes(host)) {
    throw new Error(
      `Refused: the Oracle host is not on the disposable-host allow list (${prefix}_CONNECT)`,
    );
  }
  if (BANK_USERS.includes(user.toUpperCase())) {
    throw new Error(
      'Refused: the Oracle user is a bank / system account, not a disposable test schema',
    );
  }
  const app = env.FLEXCUBE_DB_CONNECT_STRING;
  if (app && app.trim().toLowerCase() === connectString.trim().toLowerCase()) {
    throw new Error('Refused: the test connection equals the application FLEXCUBE connection');
  }
  if (env.FLEXCUBE_DB_USER && env.FLEXCUBE_DB_USER.toUpperCase() === user.toUpperCase()) {
    throw new Error('Refused: the test user equals the application FLEXCUBE user');
  }
  return { user, password, connectString };
}

const BANK_NAME = /UAT|PROD|PRD|FCUBS|FLEX|OBP|BANK/i;

/**
 * Layer 4. Fail-closed: if the checks themselves cannot run, the database is NOT accepted. Reads only metadata
 * (counts and names of the session), never data.
 */
export async function assertDisposableDatabase(db: {
  query(
    sql: string,
    binds: Record<string, string | number | null>,
  ): Promise<Record<string, unknown>[]>;
}): Promise<void> {
  let objects: number;
  let ctx: Record<string, unknown>;
  try {
    const rows = await db.query(
      "SELECT COUNT(*) AS N FROM ALL_OBJECTS WHERE OBJECT_NAME LIKE 'STTM\\_%' ESCAPE '\\' OR OBJECT_NAME LIKE 'FLTM\\_%' ESCAPE '\\' OR OBJECT_NAME LIKE 'CSTM\\_%' ESCAPE '\\'",
      {},
    );
    objects = Number(rows[0]?.N);
    ctx = (
      await db.query(
        "SELECT SYS_CONTEXT('USERENV', 'DB_NAME') AS DB, SYS_CONTEXT('USERENV', 'SERVICE_NAME') AS SVC, SYS_CONTEXT('USERENV', 'CURRENT_USER') AS CUR FROM DUAL",
        {},
      )
    )[0];
  } catch {
    throw new Error('Refused: the disposable-database checks could not run');
  }
  if (!Number.isFinite(objects) || objects > 0) {
    throw new Error(
      'Refused: this database contains FLEXCUBE objects, it is not a disposable test database',
    );
  }
  const names = [ctx?.DB, ctx?.SVC].map((v) => String(v ?? ''));
  if (
    names.some((n) => BANK_NAME.test(n)) ||
    BANK_USERS.includes(String(ctx?.CUR ?? '').toUpperCase())
  ) {
    throw new Error('Refused: the database or service name looks like a bank environment');
  }
}
