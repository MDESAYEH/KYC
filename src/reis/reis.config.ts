import { AppConfig } from '../config/configuration';
import { ReisConfigError } from './reis.errors';

export const REIS_CONFIG = Symbol('ReisConfig');

/** Validated REIS connection settings. `password` is non-enumerable so it cannot leak via JSON/log. */
export interface ReisConfig {
  /** Without trailing slash. */
  readonly baseUrl: string;
  readonly tenant: string;
  readonly userName: string;
  readonly password: string;
  readonly timeoutMs: number;
  /** REIS systemName for every request (confirmed value "Flexcube"; configurable). */
  readonly systemName: string;
}

/**
 * Validates REIS settings at startup. Problems name environment variables only, never values.
 * https is mandatory in production; http is tolerated elsewhere (local fake servers) because
 * TLS certificate validation is never disabled either way.
 */
export function validateReisConfig(reis: AppConfig['reis'], nodeEnv: string): ReisConfig {
  const problems: string[] = [];

  let baseUrl = '';
  if (!reis.baseUrl) {
    problems.push('REIS_BASE_URL is required');
  } else {
    try {
      const url = new URL(reis.baseUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        problems.push('REIS_BASE_URL must be an http(s) URL');
      } else if (nodeEnv === 'production' && url.protocol !== 'https:') {
        problems.push('REIS_BASE_URL must use https in production');
      } else if (url.username || url.password) {
        problems.push('REIS_BASE_URL must not contain credentials');
      } else {
        baseUrl = reis.baseUrl.replace(/\/+$/, '');
      }
    } catch {
      problems.push('REIS_BASE_URL is not a valid URL');
    }
  }
  if (!reis.tenant) problems.push('REIS_TENANT is required');
  if (!reis.systemName) problems.push('REIS_SYSTEM_NAME must not be blank');
  if (!reis.userName) problems.push('REIS_USERNAME is required');
  if (!reis.password) problems.push('REIS_PASSWORD is required');
  if (reis.timeoutMs === undefined) {
    problems.push('REIS_TIMEOUT_MS is required');
  } else if (!Number.isInteger(reis.timeoutMs) || reis.timeoutMs <= 0) {
    problems.push('REIS_TIMEOUT_MS must be a positive integer (milliseconds)');
  }

  if (problems.length > 0) throw new ReisConfigError(problems);

  const config = {
    baseUrl,
    tenant: reis.tenant as string,
    userName: reis.userName as string,
    timeoutMs: reis.timeoutMs as number,
    systemName: reis.systemName,
  } as ReisConfig;
  Object.defineProperty(config, 'password', {
    value: reis.password,
    enumerable: false,
    writable: false,
  });
  return Object.freeze(config);
}
