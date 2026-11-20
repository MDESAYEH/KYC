/** A bounded diagnostic derived from an HTTP error response. It never contains the raw body. */
export interface ReisHttpErrorResponseDetails {
  contentType?: string;
  body: string;
  truncated: boolean;
}

const MAX_BODY_LENGTH = 500;
const MAX_VALUE_LENGTH = 200;
const DIAGNOSTIC_KEYS = [
  'code',
  'errorCode',
  'error',
  'message',
  'errorMessage',
  'error_description',
  'detail',
  'status',
  'title',
  'type',
] as const;
const SENSITIVE_KEY =
  /password|token|secret|authorization|cookie|customer|cif|account|iban|card|passport|national|email|phone|address|birth|name|amount|balance|income|salary/i;

const normalizeContentType = (contentType: string | undefined): string | undefined => {
  if (!contentType) return undefined;
  return contentType.split(';', 1)[0]?.trim().toLowerCase() || undefined;
};

const redactText = (value: string): string =>
  value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\b(?:\d[ -]?){7,}\d\b/g, '[REDACTED_NUMBER]')
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(password|token|secret|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');

const bounded = (value: string): Pick<ReisHttpErrorResponseDetails, 'body' | 'truncated'> => ({
  body: value.slice(0, MAX_BODY_LENGTH),
  truncated: value.length > MAX_BODY_LENGTH,
});

/**
 * Produces a log-safe error diagnostic. JSON is allow-listed to documented diagnostic keys;
 * unrecognized fields are omitted. Non-JSON text is redacted and bounded, never kept raw.
 */
export function summarizeReisHttpErrorResponse(
  body: string,
  contentType: string | undefined,
): ReisHttpErrorResponseDetails {
  const normalizedContentType = normalizeContentType(contentType);
  try {
    const json: unknown = JSON.parse(body);
    if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
      const record = json as Record<string, unknown>;
      let valueTruncated = false;
      const diagnostics = DIAGNOSTIC_KEYS.flatMap((key) => {
        const value = record[key];
        if (value === undefined || value === null || SENSITIVE_KEY.test(key)) return [];
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
          return [];
        const redacted = redactText(String(value));
        valueTruncated ||= redacted.length > MAX_VALUE_LENGTH;
        return [`${key}=${redacted.slice(0, MAX_VALUE_LENGTH)}`];
      });
      const summary = bounded(
        diagnostics.length > 0
          ? diagnostics.join('; ')
          : '[JSON response without recognized diagnostics]',
      );
      return {
        contentType: normalizedContentType,
        ...summary,
        truncated: summary.truncated || valueTruncated,
      };
    }
  } catch {
    // A non-JSON body is handled below; a diagnostic must never throw while reporting an error.
  }

  return { contentType: normalizedContentType, ...bounded(redactText(body)) };
}
