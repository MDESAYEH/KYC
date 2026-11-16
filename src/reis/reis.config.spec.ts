import { inspect } from 'node:util';
import { loadConfiguration } from '../config/configuration';
import { validateReisConfig } from './reis.config';
import { ReisConfigError } from './reis.errors';

const valid = {
  REIS_BASE_URL: 'https://reis.example.test/api',
  REIS_TENANT: 'tenant-a',
  REIS_USERNAME: 'synthetic-user',
  REIS_PASSWORD: 'synthetic-secret',
  REIS_TIMEOUT_MS: '5000',
};
const reis = (env: Record<string, string | undefined> = valid) => loadConfiguration(env).reis;

const problemsFor = (env: Record<string, string | undefined>, nodeEnv = 'test'): string[] => {
  try {
    validateReisConfig(reis(env), nodeEnv);
  } catch (e) {
    expect(e).toBeInstanceOf(ReisConfigError);
    return (e as ReisConfigError).problems;
  }
  return [];
};

describe('validateReisConfig', () => {
  it('accepts a complete configuration and strips trailing slashes from the base URL', () => {
    const c = validateReisConfig(
      reis({ ...valid, REIS_BASE_URL: 'https://reis.example.test/api//' }),
      'production',
    );
    expect(c).toMatchObject({
      baseUrl: 'https://reis.example.test/api',
      tenant: 'tenant-a',
      userName: 'synthetic-user',
      timeoutMs: 5000,
    });
    expect(c.password).toBe('synthetic-secret');
  });

  it('keeps the password out of JSON and util.inspect output', () => {
    const c = validateReisConfig(reis(), 'test');
    expect(JSON.stringify(c)).not.toContain('synthetic-secret');
    expect(inspect(c)).not.toContain('synthetic-secret');
  });

  it('is immutable', () => {
    const c = validateReisConfig(reis(), 'test');
    expect(Object.isFrozen(c)).toBe(true);
  });

  it.each([
    ['REIS_BASE_URL', 'REIS_BASE_URL is required'],
    ['REIS_TENANT', 'REIS_TENANT is required'],
    ['REIS_USERNAME', 'REIS_USERNAME is required'],
    ['REIS_PASSWORD', 'REIS_PASSWORD is required'],
    ['REIS_TIMEOUT_MS', 'REIS_TIMEOUT_MS is required'],
  ])('requires %s', (name, message) => {
    expect(problemsFor({ ...valid, [name]: undefined })).toEqual([message]);
    expect(problemsFor({ ...valid, [name]: '   ' })).toEqual([message]);
  });

  it('reports every missing variable at once', () => {
    expect(problemsFor({})).toHaveLength(5);
  });

  it.each(['not a url', 'ftp://reis.example.test', 'reis.example.test'])(
    'rejects base URL %p',
    (url) => {
      expect(problemsFor({ ...valid, REIS_BASE_URL: url })).toHaveLength(1);
    },
  );

  it('rejects credentials embedded in the base URL', () => {
    expect(problemsFor({ ...valid, REIS_BASE_URL: 'https://u:p@reis.example.test' })).toEqual([
      'REIS_BASE_URL must not contain credentials',
    ]);
  });

  it('requires https in production but tolerates http elsewhere (local fakes)', () => {
    const http = { ...valid, REIS_BASE_URL: 'http://127.0.0.1:9999' };
    expect(problemsFor(http, 'production')).toEqual(['REIS_BASE_URL must use https in production']);
    expect(problemsFor(http, 'development')).toEqual([]);
    expect(problemsFor(http, 'test')).toEqual([]);
  });

  it.each(['0', '-5', '1.5'])('rejects timeout %p', (t) => {
    expect(problemsFor({ ...valid, REIS_TIMEOUT_MS: t })).toEqual([
      'REIS_TIMEOUT_MS must be a positive integer (milliseconds)',
    ]);
  });

  it('rejects a non-numeric timeout as missing', () => {
    expect(problemsFor({ ...valid, REIS_TIMEOUT_MS: 'abc' })).toEqual([
      'REIS_TIMEOUT_MS is required',
    ]);
  });

  it('never puts configuration values into error messages', () => {
    let message = '';
    try {
      validateReisConfig(
        reis({ ...valid, REIS_BASE_URL: 'http://u:p@host.example.test', REIS_TIMEOUT_MS: '-1' }),
        'production',
      );
    } catch (e) {
      message = (e as Error).message;
    }
    for (const v of ['synthetic-secret', 'synthetic-user', 'tenant-a', 'host.example.test']) {
      expect(message).not.toContain(v);
    }
  });
});
