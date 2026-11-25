import { Transform } from 'class-transformer';

const PLAIN_DECIMAL = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;
const THOUSANDS_DECIMAL = /^[+-]?(\d{1,3}(,\d{3})+)(\.\d+)?$/;

/**
 * Parses a finite number from a number, a plain decimal string ("1500.50", " 42 "), or a
 * standard thousands-formatted decimal ("1,500.50"). Returns undefined for everything else -
 * blank/whitespace strings, null, undefined, NaN, Infinity, booleans, exponent notation,
 * malformed grouping and non-numeric text - so nothing silently becomes 0.
 */
export function parseStrictNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!PLAIN_DECIMAL.test(trimmed) && !THOUSANDS_DECIMAL.test(trimmed)) return undefined;
  const n = Number(trimmed.replaceAll(',', ''));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * class-transformer decorator: converts valid numeric input to a number and leaves any other
 * value untouched, so a following @IsNumber() rejects it instead of it becoming 0.
 */
export function StrictNumber(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) => parseStrictNumber(value) ?? value);
}
