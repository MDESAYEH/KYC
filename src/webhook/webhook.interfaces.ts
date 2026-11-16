/**
 * Webhook authentication is NOT finalized (open item 8). Strategies (api key, mTLS, IP
 * allowlist, ...) implement this; none is assumed. Selected by configuration.
 */
export interface IWebhookSecurityStrategy {
  /** Return true if the request is allowed. Receives minimal request facts only. */
  authorize(request: {
    headers: Record<string, string | string[] | undefined>;
    remoteAddress?: string;
  }): Promise<boolean> | boolean;
}
export const WEBHOOK_SECURITY_STRATEGY = Symbol('IWebhookSecurityStrategy');
