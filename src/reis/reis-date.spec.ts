import { findInvalidReisDates, isReisDate } from './reis-date';

describe('REIS date format (YYYY-MM-DD)', () => {
  it.each(['1990-01-31', '2024-02-29'])('accepts %s', (v) => {
    expect(isReisDate(v)).toBe(true);
  });

  it.each(['31/01/1990', '1990-1-5', '1990-13-01', '2023-02-31', '2023-02-29', '', '19900131'])(
    'rejects %p',
    (v) => {
      expect(isReisDate(v)).toBe(false);
    },
  );

  it('rejects non-strings', () => {
    expect(isReisDate(19900131)).toBe(false);
    expect(isReisDate(null)).toBe(false);
  });

  it('lists invalid date fields in an outbound payload and ignores absent ones', () => {
    expect(
      findInvalidReisDates({ cus_birth_date: '1990-01-31', issue_date: '01/02/2020' }),
    ).toEqual(['issue_date']);
    expect(findInvalidReisDates({ cus_birth_date: '1990-01-31' })).toEqual([]);
    expect(findInvalidReisDates({ cus_birth_date: 'x', valid_until: 'y' })).toEqual([
      'cus_birth_date',
      'valid_until',
    ]);
  });
});
