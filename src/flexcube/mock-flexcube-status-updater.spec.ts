import { ReisFinalStatus } from '../reis/reis-status';
import { MockFlexcubeStatusUpdater } from './mock-flexcube-status-updater';

describe('MockFlexcubeStatusUpdater', () => {
  it('records updates without throwing', async () => {
    const u = new MockFlexcubeStatusUpdater();
    await u.updateStatus({
      kycRefNo: 'K1',
      customerNo: null,
      finalStatus: ReisFinalStatus.CUSTOMER,
      idempotencyKey: 'k',
    });
    expect(u.received).toHaveLength(1);
    expect(u.received[0].customerNo).toBeNull();
  });
});
