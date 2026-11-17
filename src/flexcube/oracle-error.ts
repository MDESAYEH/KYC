const ORACLE_CODE = /(ORA|NJS|DPI)-\d{3,5}/;

/** The Oracle / node-oracledb error code (e.g. ORA-00942) of a database error, if it has one. */
export function oracleErrorCode(error: unknown): string | undefined {
  return error instanceof Error ? ORACLE_CODE.exec(error.message)?.[0] : undefined;
}

/**
 * Technical error code safe to log or store: the Oracle code when there is one, otherwise only
 * the error class name. NEVER the message, SQL, bind values or customer data.
 */
export function oraCode(error: unknown): string {
  return oracleErrorCode(error) ?? (error instanceof Error ? error.name : 'UNKNOWN_ERROR');
}
