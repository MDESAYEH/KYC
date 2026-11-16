import {
  IFlexcubeDateNormalizer,
  InvalidFlexcubeDateError,
  StrictIsoFlexcubeDateNormalizer,
} from './flexcube-date-normalizer';

describe('StrictIsoFlexcubeDateNormalizer (provisional)', () => {
  const n = new StrictIsoFlexcubeDateNormalizer();

  it('passes a valid YYYY-MM-DD through', () => {
    expect(n.normalize(' 1990-01-31 ')).toBe('1990-01-31');
  });

  it('rejects other formats and impossible dates', () => {
    expect(() => n.normalize('31-JAN-1990')).toThrow(InvalidFlexcubeDateError);
    expect(() => n.normalize('1990-02-30')).toThrow(InvalidFlexcubeDateError);
  });

  it('can be replaced by another implementation without touching callers', () => {
    const ddmmyyyy: IFlexcubeDateNormalizer = {
      normalize: (raw) => raw.split('/').reverse().join('-'),
    };
    expect(ddmmyyyy.normalize('31/01/1990')).toBe('1990-01-31');
  });
});
