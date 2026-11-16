import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import { IncomingMessage } from 'node:http';
import { CustomerStatusResult, CustomerStatusService } from './customer-status.service';

/**
 * HTTP status per outcome.
 *  - 200 for successful processing is CONFIRMED (including a safe identical duplicate).
 *  - 200 for UPDATE_FAILED is PROVISIONAL BANK-SIDE BEHAVIOUR, not a REIS contract: the REIS
 *    decision was already durably stored, REIS' callback retry/error-code behaviour is unknown,
 *    and we must not depend on undocumented REIS retries. The failed FLEXCUBE update stays visible
 *    (flexcube_update_status = FAILED) for operator recovery.
 *  - Every non-200 code below is PROVISIONAL. REIS' retry behaviour and retry-trigger status codes
 *    are not known, so nothing here claims that any code will or will not cause REIS to retry.
 */
export const HTTP_STATUS_FOR_RESULT: Record<CustomerStatusResult, number> = {
  APPLIED: 200,
  DUPLICATE: 200,
  UPDATE_FAILED: 200,
  INVALID: 400,
  SECURITY_REJECTED: 401,
  UNKNOWN_CASE: 404,
  CONFLICT: 409,
  INCONSISTENT_STATE: 409,
  RECONCILIATION_REQUIRED: 409,
  CUSTOMER_ID_MISMATCH: 409,
};

/**
 * POST /customerStatus (REIS -> bank). The body is validated by the service (not by a global pipe)
 * so that invalid callbacks are audited. The response carries only the typed result and the
 * internal audit event id: never customer data, REIS free text or secrets.
 */
@Controller()
export class CustomerStatusController {
  constructor(private readonly service: CustomerStatusService) {}

  @Post('customerStatus')
  async customerStatus(
    @Body() body: unknown,
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: { status(code: number): unknown },
  ): Promise<{ result: CustomerStatusResult; eventId: string }> {
    const outcome = await this.service.handle({
      headers: req.headers,
      remoteAddress: req.socket?.remoteAddress,
      body,
    });
    res.status(HTTP_STATUS_FOR_RESULT[outcome.result]);
    return { result: outcome.result, eventId: outcome.eventId };
  }
}
