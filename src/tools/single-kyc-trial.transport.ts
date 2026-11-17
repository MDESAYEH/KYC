import { HttpService } from '@nestjs/axios';
import { ReisConfig } from '../reis/reis.config';
import { ReisHttpTransport, ReisRawResponse } from '../reis/transport/reis-http.transport';

/** Captures the actual onboarding HTTP response only. Authentication tokens/headers never enter evidence. */
export class SingleTrialTransport extends ReisHttpTransport {
  wire?: ReisRawResponse;
  constructor(
    http: HttpService,
    config: ReisConfig,
    private readonly saveWire: (wire: ReisRawResponse) => Promise<void>,
  ) {
    super(http, config);
  }
  override async postJson(...args: Parameters<ReisHttpTransport['postJson']>) {
    const response = await super.postJson(...args);
    if (args[0] === 'searchOnboardCustomer') {
      this.wire = response;
      await this.saveWire(response);
    }
    return response;
  }
}
