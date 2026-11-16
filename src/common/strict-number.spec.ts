import { plainToInstance } from 'class-transformer';
import { IsNumber, validate } from 'class-validator';
import { parseStrictNumber, StrictNumber } from './strict-number';

class Sample {
  @StrictNumber() @IsNumber({ allowNaN: false, allowInfinity: false }) amount: number;
}

describe('parseStrictNumber', () => {
  it.each([
    ['1500.50', 1500.5],
    [' 42 ', 42],
    ['-3', -3],
    ['.5', 0.5],
    ['0', 0],
    [7, 7],
    [0, 0],
  ])('accepts %p', (input, expected) => {
    expect(parseStrictNumber(input)).toBe(expected);
  });

  it.each([
    '',
    ' ',
    '\t\n',
    null,
    undefined,
    NaN,
    Infinity,
    -Infinity,
    'abc',
    '12abc',
    '1e3',
    '0x10',
    '1,500',
    '1.',
    true,
    false,
    [],
    {},
    '9'.repeat(400),
  ])('rejects %p (never becomes 0)', (input) => {
    expect(parseStrictNumber(input)).toBeUndefined();
  });
});

describe('@StrictNumber + @IsNumber', () => {
  const check = (amount: unknown) => validate(plainToInstance(Sample, { amount }));

  it('converts a numeric string', async () => {
    const s = plainToInstance(Sample, { amount: '1500.50' });
    expect(s.amount).toBe(1500.5);
    expect(await validate(s)).toHaveLength(0);
  });

  it.each(['', '   ', null, NaN, 'abc'])('rejects %p instead of coercing to 0', async (v) => {
    const s = plainToInstance(Sample, { amount: v });
    expect(s.amount).not.toBe(0);
    expect((await validate(s)).length).toBeGreaterThan(0);
  });

  it('rejects a missing value', async () => {
    expect((await validate(plainToInstance(Sample, {}))).length).toBeGreaterThan(0);
  });

  it('still accepts a real zero', async () => {
    expect(await check(0)).toHaveLength(0);
    expect(await check('0')).toHaveLength(0);
  });
});
