import { Inject, Injectable, Logger } from '@nestjs/common';
import { parseAuthResponse, parseJsonBody } from './reis-response.parser';
import { REIS_PATHS } from './reis.constants';
import { REIS_CONFIG, ReisConfig } from './reis.config';
import { ReisAuthenticationError, ReisHttpStatusError } from './reis.errors';
import { IReisAuthClient } from './reis.interfaces';
import { ReisCallContext, ReisHttpTransport } from './transport/reis-http.transport';

/**
 * POST {base}/xauth/authenticate/ with user_name/password from configuration; returns the
 * `token` field. A new token is requested on every call: there is deliberately no cache.
 * The token and credentials are never logged, persisted, or placed in error objects.
 */
@Injectable()
export class ReisAuthClient implements IReisAuthClient {
  private readonly logger = new Logger(ReisAuthClient.name);

  constructor(
    private readonly transport: ReisHttpTransport,
    @Inject(REIS_CONFIG) private readonly config: ReisConfig,
  ) {}

  async authenticate(context: ReisCallContext = {}): Promise<string> {
    const { correlationId } = context;
    const res = await this.transport.postJson(
      'authenticate',
      REIS_PATHS.authenticate,
      { user_name: this.config.userName, password: this.config.password },
      {},
      context,
    );

    if (res.status === 401 || res.status === 403) {
      throw new ReisAuthenticationError('authenticate', res.status, correlationId);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ReisHttpStatusError('authenticate', res.status, correlationId);
    }

    const token = parseAuthResponse(
      parseJsonBody(res.body, 'authenticate', correlationId),
      correlationId,
    );
    this.logger.log({ event: 'reis.authenticate.succeeded', correlationId });
    return token;
  }
}
