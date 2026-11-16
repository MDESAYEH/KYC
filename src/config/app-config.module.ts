import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { loadConfiguration } from './configuration';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [loadConfiguration],
      // Jest sets NODE_ENV=test: tests must not pick up a developer's local .env
      // (e.g. real FLEXCUBE_DB_* values would wire the Oracle updater against UAT).
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
  ],
  exports: [ConfigModule],
})
export class AppConfigModule {}
