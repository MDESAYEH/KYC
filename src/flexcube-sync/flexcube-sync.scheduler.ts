import { Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { oraCode } from '../flexcube/oracle-error';

/** One polling pass (TriggerSyncService). */
export interface PollingPass {
  runOnce(): Promise<unknown>;
}

/** Runs the polling pass every intervalMs (from the end of the previous pass): never two at the same time. */
export class FlexcubeSyncScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FlexcubeSyncScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running: Promise<void> | null = null;

  constructor(
    private readonly sync: PollingPass | null,
    private readonly intervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.sync) return;
    this.logger.log({ event: 'flexcube.sync.started', intervalMs: this.intervalMs });
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => {
        this.running = null;
        this.schedule();
      });
    }, this.intervalMs);
  }

  /** One pass; a failure is logged and the next pass still runs. */
  async tick(): Promise<void> {
    try {
      await this.sync?.runOnce();
    } catch (error) {
      this.logger.error({ event: 'flexcube.sync.failed', error: oraCode(error) });
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.running) await this.running;
  }
}
