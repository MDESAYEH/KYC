import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import { loadConfiguration } from '../src/config/configuration';
import { HealthController } from '../src/health/health.controller';
import { HealthService } from '../src/health/health.service';
import {
  DATABASE_HEALTH_CHECK,
  IDatabaseHealthCheck,
  TypeOrmDatabaseHealthCheck,
} from '../src/persistence/database-health';
import { FakeReisServer } from './support/fake-reis-server';
import { createTestDataSource } from './support/test-database';

const SECRET_PASSWORD = 'health-test-password-not-real';
const SECRET_USER = 'health-test-user-not-real';
const SECRET_TENANT = 'health-test-tenant';

describe('GET /health/live and /health/ready', () => {
  let ds: DataSource;
  let reis: FakeReisServer;
  let app: INestApplication | undefined;
  let base: string;

  const boot = async (
    env: Record<string, string | undefined> = {},
    database?: IDatabaseHealthCheck,
  ) => {
    const fullEnv = {
      NODE_ENV: 'test',
      DB_SQLITE_PATH: ':memory:',
      REIS_BASE_URL: reis.baseUrl,
      REIS_TENANT: SECRET_TENANT,
      REIS_USERNAME: SECRET_USER,
      REIS_PASSWORD: SECRET_PASSWORD,
      REIS_TIMEOUT_MS: '1000',
      ...env,
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          isGlobal: true,
          load: [() => loadConfiguration(fullEnv)],
        }),
      ],
      controllers: [HealthController],
      providers: [
        HealthService,
        {
          provide: DATABASE_HEALTH_CHECK,
          useValue: database ?? new TypeOrmDatabaseHealthCheck(ds),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  };
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
  };

  beforeEach(async () => {
    ds = await createTestDataSource();
    reis = new FakeReisServer();
    await reis.start();
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    await reis.stop();
    if (ds.isInitialized) await ds.destroy();
  });

  it('liveness works and needs no dependencies', async () => {
    await boot();
    await ds.destroy(); // even with the database gone the process is alive
    const res = await get('/health/live');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'ok' });
  });

  it('readiness succeeds when the database and configuration are available', async () => {
    await boot();
    const res = await get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'ok', checks: { database: 'up', configuration: 'ok' } });
  });

  it('readiness fails safely (503) when the database is unavailable', async () => {
    await boot();
    await ds.destroy();
    const res = await get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.json).toEqual({
      status: 'unavailable',
      checks: { database: 'down', configuration: 'ok' },
    });
  });

  it('readiness fails safely when the ping throws or hangs', async () => {
    await boot({}, { ping: () => Promise.reject(new Error('connection string leak: db-secret')) });
    const thrown = await get('/health/ready');
    expect(thrown.status).toBe(503);
    expect(thrown.text).not.toContain('db-secret');
    await app?.close();
    await boot({}, { ping: () => new Promise<boolean>(() => undefined) });
    const hung = await get('/health/ready');
    expect(hung.status).toBe(503);
    expect(hung.json).toMatchObject({ checks: { database: 'down' } });
  }, 15000);

  it('readiness reports invalid configuration without saying what is wrong', async () => {
    await boot({ REIS_PASSWORD: undefined, REIS_TIMEOUT_MS: '0' });
    const res = await get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.json).toEqual({
      status: 'unavailable',
      checks: { database: 'up', configuration: 'invalid' },
    });
    expect(res.text).not.toContain('REIS_');
  });

  it('responses never contain credentials, URLs, tokens, configuration values or customer data', async () => {
    await boot();
    const texts = [(await get('/health/live')).text, (await get('/health/ready')).text];
    await ds.destroy();
    texts.push((await get('/health/ready')).text);
    for (const text of texts) {
      for (const forbidden of [
        SECRET_PASSWORD,
        SECRET_USER,
        SECRET_TENANT,
        reis.baseUrl,
        '127.0.0.1',
        'http',
        'token',
        'sqlite',
        ':memory:',
      ]) {
        expect(text).not.toContain(forbidden);
      }
    }
    expect(Object.keys(JSON.parse(texts[1]) as object).sort()).toEqual(['checks', 'status']);
  });

  it('readiness never calls REIS (no authenticate traffic)', async () => {
    await boot();
    for (let i = 0; i < 5; i++) await get('/health/ready');
    expect(reis.requests).toHaveLength(0);
  });

  it('the database probe is real: it reflects the connection state', async () => {
    const probe = new TypeOrmDatabaseHealthCheck(ds);
    expect(await probe.ping()).toBe(true);
    await ds.destroy();
    expect(await probe.ping()).toBe(false);
  });
});
