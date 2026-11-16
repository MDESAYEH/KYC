import { loadConfiguration } from './configuration';

describe('loadConfiguration', () => {
  it('has no defaults for URLs, credentials or tenant', () => {
    const c = loadConfiguration({});
    expect(c.reis).toEqual({
      baseUrl: undefined,
      tenant: undefined,
      userName: undefined,
      password: undefined,
      timeoutMs: undefined,
      systemName: 'Flexcube',
    });
    expect(c.webhook.securityMode).toBeUndefined();
    expect(c.webhook.ipAllowlist).toEqual([]);
  });

  it('reads values from the environment', () => {
    const c = loadConfiguration({
      PORT: '8080',
      REIS_TENANT: 't1',
      WEBHOOK_IP_ALLOWLIST: '10.0.0.1, 10.0.0.2',
      RETRY_MAX_ATTEMPTS: '5',
    });
    expect(c.port).toBe(8080);
    expect(c.reis.tenant).toBe('t1');
    expect(c.webhook.ipAllowlist).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(c.retry.maxAttempts).toBe(5);
  });

  it('treats blank and non-numeric values as unset', () => {
    const c = loadConfiguration({ REIS_BASE_URL: '  ', RETRY_BASE_DELAY_MS: 'abc' });
    expect(c.reis.baseUrl).toBeUndefined();
    expect(c.retry.baseDelayMs).toBeUndefined();
  });
});
