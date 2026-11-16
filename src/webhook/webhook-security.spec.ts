import {
  BearerWebhookSecurityStrategy,
  createWebhookSecurityStrategy,
  DenyAllWebhookSecurityStrategy,
  UnrestrictedDevWebhookSecurityStrategy,
  WEBHOOK_SECURITY_MODE_UNRESTRICTED_DEV,
  WebhookSecurityConfigError,
} from './webhook-security';

const logger = () => ({ warn: jest.fn() });

describe('createWebhookSecurityStrategy', () => {
  it('denies every call when nothing is configured, in every environment, and warns', () => {
    for (const env of ['development', 'test', 'production']) {
      const log = logger();
      const strategy = createWebhookSecurityStrategy(undefined, env, log);
      expect(strategy).toBeInstanceOf(DenyAllWebhookSecurityStrategy);
      expect(strategy.authorize({ headers: {} })).toBe(false);
      expect(log.warn).toHaveBeenCalled();
    }
  });

  it('only provides the unrestricted strategy when explicitly requested outside production', () => {
    for (const env of ['development', 'test']) {
      const strategy = createWebhookSecurityStrategy(
        WEBHOOK_SECURITY_MODE_UNRESTRICTED_DEV,
        env,
        logger(),
      );
      expect(strategy).toBeInstanceOf(UnrestrictedDevWebhookSecurityStrategy);
      expect(strategy.authorize({ headers: {} })).toBe(true);
    }
  });

  it('production can never run an unrestricted webhook: startup fails', () => {
    expect(() => createWebhookSecurityStrategy('unrestricted-dev', 'production', logger())).toThrow(
      WebhookSecurityConfigError,
    );
  });

  it.each(['api-key', 'mtls', 'ip-allowlist', 'oauth', 'gateway', 'none', 'UNRESTRICTED-DEV', ''])(
    'fails startup for the unsupported mode %p instead of silently opening the webhook',
    (mode) => {
      for (const env of ['development', 'production']) {
        expect(() => createWebhookSecurityStrategy(mode, env, logger())).toThrow(
          WebhookSecurityConfigError,
        );
      }
    },
  );

  it('the deny-all strategy rejects regardless of headers or address', () => {
    const deny = new DenyAllWebhookSecurityStrategy();
    expect(deny.authorize()).toBe(false);
  });
});

describe('Bearer webhook security (agreed with Reis, V1.4)', () => {
  const token = 'a'.repeat(20) + 'B'.repeat(20); // synthetic, test only
  const bearer = () => createWebhookSecurityStrategy('bearer', 'production', logger(), token);

  it('is available in production and returns the bearer strategy', () => {
    expect(bearer()).toBeInstanceOf(BearerWebhookSecurityStrategy);
  });

  it('accepts exactly "Authorization: Bearer <token>" (scheme case-insensitive)', () => {
    const s = bearer();
    expect(s.authorize({ headers: { authorization: `Bearer ${token}` } })).toBe(true);
    expect(s.authorize({ headers: { authorization: `bearer ${token}` } })).toBe(true);
  });

  it.each([
    [{}],
    [{ authorization: token }],
    [{ authorization: `Basic ${token}` }],
    [{ authorization: `Bearer ${token}x` }],
    [{ authorization: `Bearer ${token.slice(1)}` }],
    [{ authorization: 'Bearer ' }],
    [{ authorization: [`Bearer ${token}`] }],
    [{ 'x-auth-token': token }],
  ])('rejects %p', (headers) => {
    expect(bearer().authorize({ headers })).toBe(false);
  });

  it.each([undefined, '', 'short-token'])(
    'fails startup when the token is missing or too short (%p)',
    (bad) => {
      expect(() => createWebhookSecurityStrategy('bearer', 'production', logger(), bad)).toThrow(
        WebhookSecurityConfigError,
      );
    },
  );

  it('never puts the token in the startup error message', () => {
    try {
      createWebhookSecurityStrategy('bearer', 'production', logger(), 'secret-but-short');
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('secret-but-short');
    }
  });
});
