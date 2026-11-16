import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { FlexcubeModule } from '../flexcube/flexcube.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { CustomerStatusMalformedRequestFilter } from './customer-status-malformed.filter';
import { CustomerStatusController } from './customer-status.controller';
import { CustomerStatusService } from './customer-status.service';
import { createWebhookSecurityStrategy } from './webhook-security';
import { WEBHOOK_SECURITY_STRATEGY } from './webhook.interfaces';

/**
 * REIS -> bank POST /customerStatus. The security strategy is chosen by configuration and fails
 * safe: unconfigured = deny all, unrestricted dev mode is refused in production, bearer = Reis
 * "Authorization: Bearer <token>" (V1.4), unknown modes stop startup. The FLEXCUBE update uses IFlexcubeStatusUpdater
 * (currently the mock). A filter (see app.setup.ts) audits malformed /customerStatus attempts that the HTTP layer
 * rejects before the controller.
 */
@Module({
  imports: [PersistenceModule, FlexcubeModule],
  controllers: [CustomerStatusController],
  providers: [
    {
      provide: WEBHOOK_SECURITY_STRATEGY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createWebhookSecurityStrategy(
          config.getOrThrow<AppConfig['webhook']>('webhook').securityMode,
          config.getOrThrow<string>('nodeEnv'),
          undefined,
          config.getOrThrow<AppConfig['webhook']>('webhook').bearerToken,
        ),
    },
    CustomerStatusService,
    // Registered globally by configureApp() (app.setup.ts): only global filters see body-parser errors.
    CustomerStatusMalformedRequestFilter,
  ],
  exports: [CustomerStatusMalformedRequestFilter],
})
export class WebhookModule {}
