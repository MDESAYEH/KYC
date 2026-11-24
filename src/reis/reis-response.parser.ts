import { ReisOnboardingResponse } from './dto/reis-onboarding.response';
import { ReisMalformedResponseError, ReisUnsupportedStatusError } from './reis.errors';
import { ReisOnboardingStatus } from './reis-status';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStatus = (v: unknown): v is ReisOnboardingStatus =>
  typeof v === 'string' && (Object.values(ReisOnboardingStatus) as string[]).includes(v);

/** Parses a response body as JSON; anything else is a malformed response. */
export function parseJsonBody(
  text: string,
  operation: 'authenticate' | 'searchOnboardCustomer',
  correlationId?: string,
): unknown {
  if (text.trim() === '') {
    throw new ReisMalformedResponseError(operation, 'empty body', correlationId);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ReisMalformedResponseError(operation, 'body is not valid JSON', correlationId);
  }
}

/** Validates the authenticate response and returns the token (field `token`). */
export function parseAuthResponse(json: unknown, correlationId?: string): string {
  if (!isObject(json)) {
    throw new ReisMalformedResponseError('authenticate', 'expected a JSON object', correlationId);
  }
  const token = json.token;
  if (typeof token !== 'string' || token.trim() === '') {
    throw new ReisMalformedResponseError(
      'authenticate',
      'missing or blank "token" field',
      correlationId,
    );
  }
  return token;
}

function optionalId(
  json: Json,
  field: 'riskCalculationId' | 'reisId',
  correlationId?: string,
): string | number | null | undefined {
  const v = json[field];
  if (v === undefined || v === null || typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  throw new ReisMalformedResponseError(
    'searchOnboardCustomer',
    `"${field}" must be a string, number or null`,
    correlationId,
  );
}

function optionalText(
  json: Json,
  field: 'instruction' | 'errorMessage',
  correlationId?: string,
): string | null | undefined {
  const v = json[field];
  if (v === undefined || v === null || typeof v === 'string') return v;
  // REIS sometimes emits a numeric instruction code. Normalize it because the
  // downstream contract persists response text only.
  if (field === 'instruction' && typeof v === 'number' && Number.isFinite(v)) {
    return String(v);
  }
  throw new ReisMalformedResponseError(
    'searchOnboardCustomer',
    field === 'instruction'
      ? '"instruction" must be a string, number or null'
      : '"errorMessage" must be a string or null',
    correlationId,
  );
}

/**
 * Validates the searchOnboardCustomer response.
 * - Not an object / wrong field types -> ReisMalformedResponseError.
 * - A recognized status (CLEAN / PENDING / REJECT) is ALWAYS a normal result; `instruction` and
 *   `errorMessage` are preserved as response data and never turn it into a failure by themselves
 *   (REJECT is a valid business outcome).
 * - Missing status -> ReisMalformedResponseError; unknown status -> ReisUnsupportedStatusError.
 * - ReisApplicationError is not raised here: its trigger awaits a confirmed REIS contract.
 */
export function parseOnboardingResponse(
  json: unknown,
  correlationId?: string,
): ReisOnboardingResponse {
  const op = 'searchOnboardCustomer';
  if (!isObject(json)) {
    throw new ReisMalformedResponseError(op, 'expected a JSON object', correlationId);
  }
  const riskCalculationId = optionalId(json, 'riskCalculationId', correlationId);
  const reisId = optionalId(json, 'reisId', correlationId);
  const instruction = optionalText(json, 'instruction', correlationId);
  const errorMessage = optionalText(json, 'errorMessage', correlationId);

  if (json.status === undefined || json.status === null) {
    throw new ReisMalformedResponseError(op, 'missing "status" field', correlationId);
  }
  if (typeof json.status !== 'string') {
    throw new ReisMalformedResponseError(op, '"status" must be a string', correlationId);
  }
  if (!isStatus(json.status)) {
    throw new ReisUnsupportedStatusError(op, json.status, correlationId);
  }

  return {
    status: json.status,
    ...(riskCalculationId !== undefined ? { riskCalculationId } : {}),
    ...(reisId !== undefined ? { reisId } : {}),
    ...(instruction !== undefined ? { instruction } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}
