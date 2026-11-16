import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { IncomingMessage } from 'node:http';
import { CustomerStatusService } from './customer-status.service';

interface ResponseLike {
  status(code: number): { json(body: unknown): unknown };
}
type RequestLike = IncomingMessage & { originalUrl?: string; route?: unknown };

/** Safe, short detail codes for requests rejected by the HTTP layer. Never parser text. */
function detailCodeForStatus(status: number): string {
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 400) return 'MALFORMED_JSON';
  return 'UNREADABLE_BODY';
}

/**
 * Recognises a rejection raised by the HTTP layer (Express body parser) before any route handler
 * ran. Two shapes reach the filter: Nest turns a parser SyntaxError into a 400 HttpException, while
 * other parser errors (too large, unsupported charset/encoding) arrive as raw http-errors objects
 * with a `type` such as 'entity.too.large'. In both cases no route has matched yet, so Express has
 * not set `request.route`.
 */
function httpLayerRejection(
  exception: unknown,
  request: RequestLike,
): { code: string; status: number } | null {
  if (request.route !== undefined) return null;
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return status >= 400 && status < 500 ? { code: detailCodeForStatus(status), status } : null;
  }
  const e = exception as { type?: unknown; status?: unknown; statusCode?: unknown } | null;
  if (typeof e?.type === 'string' && /^(entity|encoding|charset|request)\./.test(e.type)) {
    const raw = typeof e.status === 'number' ? e.status : e.statusCode;
    const status = typeof raw === 'number' && raw >= 400 && raw < 500 ? raw : 400;
    return { code: detailCodeForStatus(status), status };
  }
  return null;
}

/**
 * Audits POST /customerStatus attempts that Express' JSON body parser rejects BEFORE the controller
 * runs (syntactically invalid JSON, oversized or undecodable bodies). The parser's own validation
 * is not weakened: the request is still rejected with the same 4xx. Only safe metadata is recorded
 * (event id, timestamps, INVALID + a detail code); the raw body and the parser's error text (which
 * can quote the body) are never stored or echoed. Everything else falls through to Nest's default
 * exception handling.
 *
 * Must be registered with app.useGlobalFilters (see configureApp): APP_FILTER providers do not see
 * errors raised by the body parser.
 */
@Catch()
export class CustomerStatusMalformedRequestFilter extends BaseExceptionFilter {
  constructor(private readonly service: CustomerStatusService) {
    super();
  }

  override async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestLike>();
    const path = (request?.originalUrl ?? request?.url ?? '').split('?')[0];
    const rejection =
      request?.method === 'POST' && path === '/customerStatus'
        ? httpLayerRejection(exception, request)
        : null;
    if (!rejection) {
      super.catch(exception, host);
      return;
    }
    const response = http.getResponse<ResponseLike>();
    const outcome = await this.service.auditMalformedRequest(
      { headers: request.headers, remoteAddress: request.socket?.remoteAddress },
      rejection.code,
    );
    const status = outcome.result === 'SECURITY_REJECTED' ? 401 : rejection.status;
    response.status(status).json({ result: outcome.result, eventId: outcome.eventId });
  }
}
