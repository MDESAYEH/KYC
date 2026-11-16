import {
  InvalidFieldValueError,
  MissingRequiredFieldError,
  SourceOfIncomeRuleNotConfiguredError,
} from '../canonical/transformation.errors';
import { KycRequestStatus as S } from '../common/kyc-status';
import { ReferenceMappingType, UnmappedReferenceValueError } from '../mapping/reference-mapping';
import {
  ReisAuthenticationError,
  ReisHttpStatusError,
  ReisMalformedResponseError,
  ReisNetworkError,
  ReisTimeoutError,
  ReisUnsupportedStatusError,
} from '../reis/reis.errors';
import { classifyPreReisFailure, classifyReisFailure } from './kyc-failure.classifier';

describe('classifyPreReisFailure (before REIS is contacted)', () => {
  it.each([
    [new MissingRequiredFieldError('X'), 'MISSING_REQUIRED_FIELD'],
    [new InvalidFieldValueError('X', 'bad'), 'INVALID_FIELD_VALUE'],
    [new SourceOfIncomeRuleNotConfiguredError(2), 'RULE_NOT_CONFIGURED'],
  ])('%s -> VALIDATION_FAILED', (error, code) => {
    expect(classifyPreReisFailure(error)).toMatchObject({
      stage: 'VALIDATION',
      code,
      persist: S.VALIDATION_FAILED,
      requestMayHaveReachedReis: false,
    });
  });

  it('classifies an unmapped value without echoing the value', () => {
    const c = classifyPreReisFailure(
      new UnmappedReferenceValueError(ReferenceMappingType.DOCUMENT_TYPE, 'secret free text'),
    );
    expect(c).toMatchObject({ code: 'UNMAPPED_REFERENCE', persist: S.VALIDATION_FAILED });
    expect(c?.message).toContain('DOCUMENT_TYPE');
    expect(c?.message).not.toContain('secret free text');
  });

  it('returns null for unexpected errors so bugs are not swallowed', () => {
    expect(classifyPreReisFailure(new Error('boom'))).toBeNull();
    expect(classifyPreReisFailure('x')).toBeNull();
  });
});

describe('classifyReisFailure', () => {
  describe('authenticate stage: no onboarding request can have been delivered', () => {
    it.each([
      [new ReisAuthenticationError('authenticate', 401), 'REIS_AUTH_REJECTED', S.FAILED_PERMANENT],
      [new ReisAuthenticationError('authenticate', 403), 'REIS_AUTH_REJECTED', S.FAILED_PERMANENT],
      [new ReisTimeoutError('authenticate', 1000), 'REIS_AUTH_TIMEOUT', S.FAILED_RETRYABLE],
      [
        new ReisNetworkError('authenticate', 'ECONNRESET', true),
        'REIS_AUTH_NETWORK_ERROR',
        S.FAILED_RETRYABLE,
      ],
      [new ReisHttpStatusError('authenticate', 503), 'REIS_AUTH_HTTP_ERROR', S.FAILED_RETRYABLE],
      [new ReisHttpStatusError('authenticate', 404), 'REIS_AUTH_HTTP_ERROR', S.FAILED_PERMANENT],
      [
        new ReisMalformedResponseError('authenticate', 'no token'),
        'REIS_AUTH_MALFORMED_RESPONSE',
        S.FAILED_PERMANENT,
      ],
    ])('%s', (error, code, persist) => {
      expect(classifyReisFailure(error)).toMatchObject({
        stage: 'REIS_AUTHENTICATE',
        code,
        persist,
        requestMayHaveReachedReis: false,
      });
    });
  });

  describe('onboarding stage', () => {
    it('timeout and connection reset are DELIVERY_UNCERTAIN', () => {
      expect(
        classifyReisFailure(new ReisTimeoutError('searchOnboardCustomer', 1000)),
      ).toMatchObject({
        stage: 'REIS_ONBOARDING',
        code: 'REIS_ONBOARDING_TIMEOUT',
        persist: S.DELIVERY_UNCERTAIN,
        requestMayHaveReachedReis: true,
      });
      expect(
        classifyReisFailure(new ReisNetworkError('searchOnboardCustomer', 'ECONNRESET', true)),
      ).toMatchObject({ persist: S.DELIVERY_UNCERTAIN, requestMayHaveReachedReis: true });
    });

    it('a network failure that never sent the request is FAILED_RETRYABLE (classification only)', () => {
      expect(
        classifyReisFailure(new ReisNetworkError('searchOnboardCustomer', 'ECONNREFUSED', false)),
      ).toMatchObject({
        persist: S.FAILED_RETRYABLE,
        requestMayHaveReachedReis: false,
        code: 'REIS_ONBOARDING_NETWORK_ERROR',
      });
    });

    it('401/403 and other 4xx are permanent rejections; 5xx is uncertain', () => {
      expect(
        classifyReisFailure(new ReisAuthenticationError('searchOnboardCustomer', 401)),
      ).toMatchObject({
        persist: S.FAILED_PERMANENT,
        code: 'REIS_ONBOARDING_AUTH_REJECTED',
      });
      expect(
        classifyReisFailure(new ReisHttpStatusError('searchOnboardCustomer', 400)),
      ).toMatchObject({
        persist: S.FAILED_PERMANENT,
        code: 'REIS_ONBOARDING_HTTP_ERROR',
      });
      expect(
        classifyReisFailure(new ReisHttpStatusError('searchOnboardCustomer', 500)),
      ).toMatchObject({
        persist: S.DELIVERY_UNCERTAIN,
        code: 'REIS_ONBOARDING_HTTP_5XX',
        requestMayHaveReachedReis: true,
      });
    });

    it('an unreadable 2xx or unsupported status is uncertain (REIS probably processed it)', () => {
      expect(
        classifyReisFailure(new ReisMalformedResponseError('searchOnboardCustomer', 'bad json')),
      ).toMatchObject({
        persist: S.DELIVERY_UNCERTAIN,
        code: 'REIS_ONBOARDING_MALFORMED_RESPONSE',
      });
      expect(
        classifyReisFailure(new ReisUnsupportedStatusError('searchOnboardCustomer', 'APPROVED')),
      ).toMatchObject({
        persist: S.DELIVERY_UNCERTAIN,
        code: 'REIS_ONBOARDING_UNSUPPORTED_STATUS',
      });
    });
  });

  it('never classifies anything as automatically retried', () => {
    const c = classifyReisFailure(new ReisTimeoutError('searchOnboardCustomer', 1));
    expect(c).not.toHaveProperty('retry');
    expect(c).not.toHaveProperty('retryAfterMs');
  });
});
