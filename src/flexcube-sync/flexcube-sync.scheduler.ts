import { Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { oraCode } from '../flexcube/oracle-error';
import { FlexcubeSyncService, SyncCycleError } from './flexcube-sync.service';

/** Runs FlexcubeSyncService every intervalMs, never two passes at the same time. */
export class FlexcubeSyncScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FlexcubeSyncScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running: Promise<void> | null = null;

  constructor(
    private readonly sync: FlexcubeSyncService | null,
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
      this.logger.error(
        error instanceof SyncCycleError
          ? {
              event: 'flexcube.sync.failed',
              runId: error.runId,
              phase: error.phase,
              durationMs: error.durationMs,
              error: error.code,
            }
          : { event: 'flexcube.sync.failed', error: oraCode(error) },
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.running) await this.running;
  }
}
