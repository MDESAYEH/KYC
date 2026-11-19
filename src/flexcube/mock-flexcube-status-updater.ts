import { Injectable, Logger } from '@nestjs/common';
import { FlexcubeStatusUpdate } from './dto/flexcube-status-update';
import { IFlexcubeStatusUpdater } from './flexcube.interfaces';

/** TEMPORARY stand-in. Records updates in memory; logs the status only (never a KYC reference). */
@Injectable()
export class MockFlexcubeStatusUpdater implements IFlexcubeStatusUpdater {
  private readonly logger = new Logger(MockFlexcubeStatusUpdater.name);
  readonly received: FlexcubeStatusUpdate[] = [];

  async updateStatus(update: FlexcubeStatusUpdate): Promise<void> {
    this.received.push(update);
    this.logger.log(`MOCK FLEXCUBE update status=${update.finalStatus}`);
  }
}
