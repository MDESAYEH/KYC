import { Inject, Injectable, Logger } from '@nestjs/common';
import { ReisOnboardingRequest, ReisOnboardingResponse } from './dto';
import { parseJsonBody, parseOnboardingResponse } from './reis-response.parser';
import { REIS_HEADERS, REIS_PATHS } from './reis.constants';
import { ReisAuthenticationError, ReisHttpStatusError } from './reis.errors';
import { IReisAuthClient, IReisOnboardingClient, REIS_AUTH_CLIENT } from './reis.interfaces';
import { ReisCallContext, ReisHttpTransport } from './transport/reis-http.transport';

/**
 * onboard() = authenticate() -> receive token -> POST searchOnboardCustomer with x-auth-token.
 *
 * - A fresh token is obtained for EVERY onboard call (no caching, no reuse).
 * - The payload is an already-valid REIS request (relations nested inside it) and is sent as
 *   received: no transformation, no stripping, nested structures untouched. Relations are NEVER
 *   sent as separate calls.
 * - No retries here: re-sending an onboarding request could duplicate business operations,
 *   and the retry policy is still TBD.
 * - Does not touch persistence; the future workflow coordinates clients and repository.
 * - Logs only operation, HTTP status, duration, onboarding status and presence flags - never the
 *   payload, token, or personal data.
 */
@Injectable()
export class ReisOnboardingClient implements IReisOnboardingClient {
  private readonly logger = new Logger(ReisOnboardingClient.name);

  constructor(
    @Inject(REIS_AUTH_CLIENT) private readonly auth: IReisAuthClient,
    private readonly transport: ReisHttpTransport,
  ) {}

  async onboard(
    payload: ReisOnboardingRequest,
    context: ReisCallContext = {},
  ): Promise<ReisOnboardingResponse> {
    const { correlationId } = context;
    const token = await this.auth.authenticate(context);

    const res = await this.transport.postJson(
      'searchOnboardCustomer',
      REIS_PATHS.searchOnboardCustomer,
      payload,
      { [REIS_HEADERS.token]: token },
      context,
    );

    if (res.status === 401 || res.status === 403) {
      throw new ReisAuthenticationError('searchOnboardCustomer', res.status, correlationId);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ReisHttpStatusError('searchOnboardCustomer', res.status, correlationId);
    }

    const response = parseOnboardingResponse(
      parseJsonBody(res.body, 'searchOnboardCustomer', correlationId),
      correlationId,
    );
    this.logger.log({
      event: 'reis.onboarding.completed',
      correlationId,
      formId: payload.formId,
      onboardingStatus: response.status,
      hasReisId: response.reisId != null,
      hasRiskCalculationId: response.riskCalculationId != null,
      hasInstruction: response.instruction != null,
      hasErrorMessage: response.errorMessage != null,
    });
    return response;
  }
}
