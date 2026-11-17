import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { FLEXCUBE_STATUS_UPDATER } from '../src/flexcube/flexcube.interfaces';
import { MockFlexcubeStatusUpdater } from '../src/flexcube/mock-flexcube-status-updater';
import { KYC_WORKFLOW } from '../src/kyc/kyc.interfaces';
import { CifSubmissionHoldWorkflow } from '../src/kyc/cif-submission-hold.workflow';
import { ReisConfigError } from '../src/reis/reis.errors';
import { REIS_AUTH_CLIENT, REIS_ONBOARDING_CLIENT } from '../src/reis/reis.interfaces';
import { ReisAuthClient } from '../src/reis/reis-auth.client';
import { ReisOnboardingClient } from '../src/reis/reis-onboarding.client';

/** Safe, test-only values: synthetic, point at nothing real. */
const TEST_ENV: Record<string, string> = {
  DB_SQLITE_PATH: ':memory:',
  REIS_BASE_URL: 'http://127.0.0.1:1',
  REIS_TENANT: 'test-tenant',
  REIS_USERNAME: 'test-user',
  REIS_PASSWORD: 'test-password-not-real',
  REIS_TIMEOUT_MS: '1000',
};
const MANAGED = Object.keys(TEST_ENV);

describe('AppModule wiring and startup configuration', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of MANAGED) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of MANAGED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('boots with valid test configuration and provides the mock updater and REIS clients', async () => {
    Object.assign(process.env, TEST_ENV);
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(mod.get(FLEXCUBE_STATUS_UPDATER, { strict: false })).toBeInstanceOf(
      MockFlexcubeStatusUpdater,
    );
    expect(mod.get(REIS_AUTH_CLIENT, { strict: false })).toBeInstanceOf(ReisAuthClient);
    expect(mod.get(REIS_ONBOARDING_CLIENT, { strict: false })).toBeInstanceOf(ReisOnboardingClient);
    expect(mod.get(KYC_WORKFLOW, { strict: false })).toBeInstanceOf(CifSubmissionHoldWorkflow);
    await mod.close();
  });

  it('fails at startup when REIS configuration is missing, naming variables but no values', async () => {
    Object.assign(process.env, TEST_ENV);
    for (const k of MANAGED.filter((k) => k.startsWith('REIS_'))) delete process.env[k];
    const err = await Test.createTestingModule({ imports: [AppModule] })
      .compile()
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ReisConfigError);
    const problems = (err as ReisConfigError).problems.join(' | ');
    for (const name of [
      'REIS_BASE_URL',
      'REIS_TENANT',
      'REIS_USERNAME',
      'REIS_PASSWORD',
      'REIS_TIMEOUT_MS',
    ]) {
      expect(problems).toContain(name);
    }
  });

  it('fails at startup when a single REIS value is invalid', async () => {
    Object.assign(process.env, TEST_ENV, { REIS_TIMEOUT_MS: '0' });
    const err = await Test.createTestingModule({ imports: [AppModule] })
      .compile()
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ReisConfigError);
    expect((err as ReisConfigError).problems).toEqual([
      'REIS_TIMEOUT_MS must be a positive integer (milliseconds)',
    ]);
    expect((err as Error).message).not.toContain('test-password-not-real');
  });
});
