import { Module } from '@nestjs/common';
import { CanonicalModule } from './canonical/canonical.module';
import { AppConfigModule } from './config/app-config.module';
import { FlexcubeModule } from './flexcube/flexcube.module';
import { FlexcubeSyncModule } from './flexcube-sync/flexcube-sync.module';
import { HealthModule } from './health/health.module';
import { KycModule } from './kyc/kyc.module';
import { MappingModule } from './mapping/mapping.module';
import { OperationsModule } from './operations/operations.module';
import { PersistenceModule } from './persistence/persistence.module';
import { ReisModule } from './reis/reis.module';
import { WebhookModule } from './webhook/webhook.module';

@Module({
  imports: [
    AppConfigModule,
    CanonicalModule,
    FlexcubeModule,
    ReisModule,
    MappingModule,
    PersistenceModule,
    WebhookModule,
    KycModule,
    FlexcubeSyncModule,
    OperationsModule,
    HealthModule,
  ],
})
export class AppModule {}
