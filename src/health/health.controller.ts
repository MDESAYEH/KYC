import { Controller, Get, Res } from '@nestjs/common';
import { HealthService, ReadinessReport } from './health.service';

/**
 * GET /health/live  - process liveness (always 200 while the process can answer).
 * GET /health/ready - dependency readiness: 200 when ready, 503 otherwise.
 * Responses carry only coarse status words: no configuration, URLs, credentials or customer data.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return this.health.live();
  }

  @Get('ready')
  async ready(
    @Res({ passthrough: true }) res: { status(code: number): unknown },
  ): Promise<ReadinessReport> {
    const report = await this.health.ready();
    res.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
