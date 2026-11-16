import { parseAuthResponse, parseJsonBody, parseOnboardingResponse } from './reis-response.parser';
import { ReisMalformedResponseError, ReisUnsupportedStatusError } from './reis.errors';
import { ReisOnboardingStatus } from './reis-status';

describe('parseJsonBody', () => {
  it('parses valid JSON', () => {
    expect(parseJsonBody('{"a":1}', 'authenticate')).toEqual({ a: 1 });
  });
  it.each(['', '   ', '{oops', '<html/>', 'undefined'])('rejects %p', (body) => {
    expect(() => parseJsonBody(body, 'authenticate', 'c1')).toThrow(ReisMalformedResponseError);
  });
  it('carries the operation and correlation id', () => {
    try {
      parseJsonBody('x', 'searchOnboardCustomer', 'corr-9');
      fail('expected throw');
    } catch (e) {
      expect(e).toMatchObject({ operation: 'searchOnboardCustomer', correlationId: 'corr-9' });
    }
  });
});

describe('parseAuthResponse', () => {
  it('returns the `token` field untouched', () => {
    expect(parseAuthResponse({ token: ' abc.def ', other: 1 })).toBe(' abc.def ');
  });
  it.each([
    {},
    { access_token: 'x' },
    { token: '' },
    { token: '  ' },
    { token: 1 },
    { token: null },
    [],
    'str',
    null,
    5,
  ])('rejects %p', (json) => {
    expect(() => parseAuthResponse(json)).toThrow(ReisMalformedResponseError);
  });
});

describe('parseOnboardingResponse', () => {
  it.each(Object.values(ReisOnboardingStatus))('accepts %s', (status) => {
    expect(parseOnboardingResponse({ status })).toEqual({ status });
  });

  it('keeps documented fields with their wire types and drops undocumented ones', () => {
    expect(
      parseOnboardingResponse({
        status: 'PENDING',
        riskCalculationId: 77,
        reisId: 'R-1',
        instruction: 'go',
        errorMessage: 'info',
        customerId: 1,
        surprise: true,
      }),
    ).toEqual({
      status: 'PENDING',
      riskCalculationId: 77,
      reisId: 'R-1',
      instruction: 'go',
      errorMessage: 'info',
    });
  });

  it('accepts null ids and texts', () => {
    expect(
      parseOnboardingResponse({
        status: 'CLEAN',
        riskCalculationId: null,
        reisId: null,
        instruction: null,
        errorMessage: null,
      }),
    ).toEqual({
      status: 'CLEAN',
      riskCalculationId: null,
      reisId: null,
      instruction: null,
      errorMessage: null,
    });
  });

  it.each(['CLEAN', 'PENDING', 'REJECT'])(
    'does not fail %s because errorMessage is non-empty',
    (status) => {
      const r = parseOnboardingResponse({ status, errorMessage: 'informational' });
      expect(r.status).toBe(status);
      expect(r.errorMessage).toBe('informational');
    },
  );

  it('returns REJECT with errorMessage and instruction as a normal result', () => {
    expect(
      parseOnboardingResponse({
        status: 'REJECT',
        errorMessage: 'reason',
        instruction: 'do x',
        reisId: 3,
      }),
    ).toEqual({ status: 'REJECT', errorMessage: 'reason', instruction: 'do x', reisId: 3 });
  });

  it.each(['clean', 'Pending', 'APPROVED', 'CUSTOMER', 'BLOCKED', ''])(
    'rejects unknown status %p',
    (status) => {
      expect(() => parseOnboardingResponse({ status })).toThrow(ReisUnsupportedStatusError);
    },
  );

  it('truncates a very long unsupported status value', () => {
    try {
      parseOnboardingResponse({ status: 'X'.repeat(500) });
      fail('expected throw');
    } catch (e) {
      expect((e as ReisUnsupportedStatusError).receivedStatus).toHaveLength(50);
    }
  });

  it.each([
    {},
    { errorMessage: 'only an error' },
    { status: null },
    { status: 1 },
    { status: ['CLEAN'] },
    { status: 'CLEAN', reisId: {} },
    { status: 'CLEAN', reisId: true },
    { status: 'CLEAN', riskCalculationId: [] },
    { status: 'CLEAN', riskCalculationId: Infinity },
    { status: 'CLEAN', instruction: 1 },
    { status: 'CLEAN', errorMessage: { text: 'x' } },
    [],
    'CLEAN',
    null,
    42,
  ])('rejects malformed response %p', (json) => {
    expect(() => parseOnboardingResponse(json, 'c')).toThrow(ReisMalformedResponseError);
  });
});
