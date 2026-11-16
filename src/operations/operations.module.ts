import { Module } from '@nestjs/common';
import { FlexcubeModule } from '../flexcube/flexcube.module';
import { PersistenceModule } from '../persistence/persistence.module';
import {
  FLEXCUBE_UPDATE_RECOVERY_SERVICE,
  FlexcubeUpdateRecoveryService,
} from './flexcube-update-recovery.service';
import { OPERATIONAL_QUERY_SERVICE, OperationalQueryService } from './operational-query.service';

/**
 * Operator-facing application services: FLEXCUBE update recovery and monitoring queries. There is
 * deliberately NO controller here: no public admin endpoint, no scheduler, no automatic retry.
 */
@Module({
  imports: [PersistenceModule, FlexcubeModule],
  providers: [
    { provide: FLEXCUBE_UPDATE_RECOVERY_SERVICE, useClass: FlexcubeUpdateRecoveryService },
    { provide: OPERATIONAL_QUERY_SERVICE, useClass: OperationalQueryService },
  ],
  exports: [FLEXCUBE_UPDATE_RECOVERY_SERVICE, OPERATIONAL_QUERY_SERVICE],
})
export class OperationsModule {}
