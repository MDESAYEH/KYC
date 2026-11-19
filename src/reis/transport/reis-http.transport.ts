import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { REIS_HEADERS } from '../reis.constants';
import { REIS_CONFIG, ReisConfig } from '../reis.config';
import { summarizeReisHttpErrorResponse } from '../reis-error-response';
import { ReisClientError, ReisNetworkError, ReisOperation, ReisTimeoutError } from '../reis.errors';

export interface ReisCallContext {
  /** Optional caller-supplied id, echoed in logs and errors. Never a customer identifier by contract. */
  correlationId?: string;
}

export interface ReisRawResponse {
  status: number;
  /** Unparsed body text. */
  body: string;
  /** Normalized Content-Type response header, when supplied by REIS. */
  contentType?: string;
}

/** Failures that happen before any request can reach REIS (nothing was sent/processed). */
const NEVER_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * The only place that talks HTTP to REIS. Isolated from domain/application code.
 *
 * Security properties:
 *  - TLS certificate validation stays at the Node/Axios default (ON); no custom agent and no
 *    option that weakens certificate checks.
 *  - Redirects are not followed (a redirect would re-send x-auth-token to another location).
 *  - No automatic retries.
 *  - Request bodies, headers, and raw Axios errors are never logged or attached to errors.
 */
@Injectable()
export class ReisHttpTransport {
  private readonly logger = new Logger('ReisHttp');

  constructor(
    private readonly http: HttpService,
    @Inject(REIS_CONFIG) private readonly config: ReisConfig,
  ) {}

  async postJson(
    operation: ReisOperation,
    path: string,
    body: unknown,
    extraHeaders: Record<string, string>,
    context: ReisCallContext = {},
  ): Promise<ReisRawResponse> {
    const started = Date.now();
    try {
      const res = await this.http.axiosRef.request<string>({
        method: 'POST',
        url: `${this.config.baseUrl}${path}`,
        data: JSON.stringify(body),
        headers: {
          'Content-Type': 'application/json',
          [REIS_HEADERS.tenant]: this.config.tenant,
          ...extraHeaders,
        },
        timeout: this.config.timeoutMs,
        maxRedirects: 0,
        responseType: 'text',
        transformResponse: [(data: unknown) => data],
        validateStatus: () => true,
      });
      const responseBody = typeof res.data === 'string' ? res.data : '';
      const header = res.headers?.['content-type'];
      const contentType = typeof header === 'string' ? header : undefined;
      this.logger.log({
        event: 'reis.http.response',
        operation,
        httpStatus: res.status,
        durationMs: Date.now() - started,
        correlationId: context.correlationId,
      });
      if (res.status < 200 || res.status >= 300) {
        this.logErrorResponse(
          operation,
          res.status,
          context.correlationId,
          summarizeReisHttpErrorResponse(responseBody, contentType),
        );
      }
      return { status: res.status, body: responseBody, contentType };
    } catch (err) {
      const error = this.classify(operation, err, context.correlationId);
      this.logger.warn({
        event: 'reis.http.failed',
        operation,
        category: error.category,
        errorCode: error instanceof ReisNetworkError ? error.errorCode : undefined,
        durationMs: Date.now() - started,
        correlationId: context.correlationId,
      });
      throw error;
    }
  }

  /** Observability is strictly best-effort: a logging failure never masks the REIS failure. */
  private logErrorResponse(
    operation: ReisOperation,
    httpStatus: number,
    correlationId: string | undefined,
    details: ReturnType<typeof summarizeReisHttpErrorResponse>,
  ): void {
    try {
      this.logger.warn({
        event: 'reis.http.errorResponse',
        operation,
        httpStatus,
        correlationId,
        responseContentType: details.contentType,
        responseBody: details.body,
        responseBodyTruncated: details.truncated,
      });
    } catch {
      // Intentionally empty: diagnostics must not affect classification or error propagation.
    }
  }

  private classify(
    operation: ReisOperation,
    err: unknown,
    correlationId?: string,
  ): ReisClientError {
    const code = (err as { code?: unknown } | null)?.code;
    const errorCode = typeof code === 'string' ? code : 'UNKNOWN';
    if (errorCode === 'ECONNABORTED' || errorCode === 'ETIMEDOUT') {
      return new ReisTimeoutError(operation, this.config.timeoutMs, correlationId);
    }
    return new ReisNetworkError(
      operation,
      errorCode,
      !NEVER_SENT_CODES.has(errorCode),
      correlationId,
    );
  }
}
