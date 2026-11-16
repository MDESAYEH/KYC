import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { MappingModule } from '../mapping/mapping.module';
import { CanonicalToReisTransformer } from './canonical-to-reis.transformer';
import { ReisAuthClient } from './reis-auth.client';
import { ReisOnboardingClient } from './reis-onboarding.client';
import { REIS_CONFIG, validateReisConfig } from './reis.config';
import {
  CANONICAL_TO_REIS_TRANSFORMER,
  REIS_AUTH_CLIENT,
  REIS_ONBOARDING_CLIENT,
} from './reis.interfaces';
import { ReisHttpTransport } from './transport/reis-http.transport';

/**
 * REIS HTTP clients. REIS configuration is validated when the application starts (the
 * REIS_CONFIG factory throws ReisConfigError listing variable names, never values).
 */
@Module({
  imports: [HttpModule, MappingModule],
  providers: [
    {
      provide: REIS_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        validateReisConfig(
          config.getOrThrow<AppConfig['reis']>('reis'),
          config.getOrThrow<string>('nodeEnv'),
        ),
    },
    ReisHttpTransport,
    { provide: REIS_AUTH_CLIENT, useClass: ReisAuthClient },
    { provide: REIS_ONBOARDING_CLIENT, useClass: ReisOnboardingClient },
    { provide: CANONICAL_TO_REIS_TRANSFORMER, useClass: CanonicalToReisTransformer },
  ],
  exports: [REIS_AUTH_CLIENT, REIS_ONBOARDING_CLIENT, CANONICAL_TO_REIS_TRANSFORMER],
})
export class ReisModule {}
