import { Logger } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { IWebhookSecurityStrategy } from './webhook.interfaces';

/** Webhook security cannot be configured safely: startup must fail. */
export class WebhookSecurityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSecurityConfigError';
  }
}

/** Explicit mode name for the development/test-only strategy. */
export const WEBHOOK_SECURITY_MODE_UNRESTRICTED_DEV = 'unrestricted-dev';

/**
 * Fail-safe default: rejects every callback. Used when no security mechanism is configured, so
 * the webhook can never be accidentally open.
 */
export class DenyAllWebhookSecurityStrategy implements IWebhookSecurityStrategy {
  authorize(): boolean {
    return false;
  }
}

/**
 * DEVELOPMENT / TEST ONLY: accepts every callback. It must be requested explicitly and is refused
 * at startup in production.
 */
export class UnrestrictedDevWebhookSecurityStrategy implements IWebhookSecurityStrategy {
  authorize(): boolean {
    return true;
  }
}

export const WEBHOOK_SECURITY_MODE_BEARER = 'bearer';
/** Minimum token length accepted at startup (a long random secret is expected). */
export const MIN_WEBHOOK_BEARER_TOKEN_LENGTH = 32;

/**
 * Reis V1.4 BEARER mode: Reis sends "Authorization: Bearer <token>". The token is compared in
 * constant time (both sides hashed first so lengths do not leak). The token is never logged.
 */
export class BearerWebhookSecurityStrategy implements IWebhookSecurityStrategy {
  private readonly expected: Buffer;

  constructor(token: string) {
    this.expected = createHash('sha256').update(token, 'utf8').digest();
  }

  authorize(request: { headers: Record<string, string | string[] | undefined> }): boolean {
    const header = request.headers['authorization'];
    if (typeof header !== 'string') return false;
    const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
    if (!match) return false;
    const given = createHash('sha256').update(match[1], 'utf8').digest();
    return timingSafeEqual(given, this.expected);
  }
}

/**
 * Chooses the inbound webhook security strategy from configuration (WEBHOOK_SECURITY_MODE).
 *
 * Agreed with Reis (V1.4): BEARER. Modes:
 *  - 'bearer'                  -> Authorization: Bearer <WEBHOOK_BEARER_TOKEN>; startup FAILS
 *                                 if the token is missing or shorter than 32 characters
 *  - not configured            -> deny-all (safe), warning logged
 *  - 'unrestricted-dev'        -> open, only outside production; in production startup FAILS
 *  - any other value           -> startup FAILS (never silently falls back to open)
 */
export function createWebhookSecurityStrategy(
  securityMode: string | undefined,
  nodeEnv: string,
  logger: Pick<Logger, 'warn'> = new Logger('WebhookSecurity'),
  bearerToken?: string,
): IWebhookSecurityStrategy {
  if (securityMode === WEBHOOK_SECURITY_MODE_BEARER) {
    if (!bearerToken || bearerToken.trim().length < MIN_WEBHOOK_BEARER_TOKEN_LENGTH) {
      throw new WebhookSecurityConfigError(
        `WEBHOOK_SECURITY_MODE=bearer requires WEBHOOK_BEARER_TOKEN of at least ${MIN_WEBHOOK_BEARER_TOKEN_LENGTH} characters.`,
      );
    }
    return new BearerWebhookSecurityStrategy(bearerToken.trim());
  }
  if (securityMode === undefined) {
    logger.warn(
      'Webhook security is not configured (WEBHOOK_SECURITY_MODE): /customerStatus will reject every call.',
    );
    return new DenyAllWebhookSecurityStrategy();
  }
  if (securityMode === WEBHOOK_SECURITY_MODE_UNRESTRICTED_DEV) {
    if (nodeEnv === 'production') {
      throw new WebhookSecurityConfigError(
        'WEBHOOK_SECURITY_MODE=unrestricted-dev is not allowed in production: an unrestricted webhook must never run there.',
      );
    }
    logger.warn('Webhook security is UNRESTRICTED (development/test mode only).');
    return new UnrestrictedDevWebhookSecurityStrategy();
  }
  throw new WebhookSecurityConfigError(
    `WEBHOOK_SECURITY_MODE "${securityMode}" is not supported (expected "bearer", or "unrestricted-dev" outside production).`,
  );
}
