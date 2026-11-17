import { oraCode, oracleErrorCode } from './oracle-error';

describe('oracle-error helper', () => {
  it('extracts only the Oracle / driver code', () => {
    expect(oraCode(new Error('ORA-12541: TNS:no listener'))).toBe('ORA-12541');
    expect(oraCode(new Error('NJS-503: connection to host x failed'))).toBe('NJS-503');
    expect(oraCode(new Error('DPI-1080: connection was closed'))).toBe('DPI-1080');
  });

  it('falls back to the error class name, never the message', () => {
    expect(oraCode(new TypeError('secret value 123'))).toBe('TypeError');
    expect(oraCode('plain string')).toBe('UNKNOWN_ERROR');
    expect(oraCode(undefined)).toBe('UNKNOWN_ERROR');
  });

  it('oracleErrorCode is undefined for non-database errors', () => {
    expect(oracleErrorCode(new Error('boom'))).toBeUndefined();
    expect(oracleErrorCode(null)).toBeUndefined();
    expect(oracleErrorCode(new Error('x ORA-00904 y'))).toBe('ORA-00904');
  });
});
