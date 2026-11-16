import { Module } from '@nestjs/common';
import { FlexcubeModule } from '../flexcube/flexcube.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { ReisModule } from '../reis/reis.module';
import { KYC_WORKFLOW } from './kyc.interfaces';
import { KycWorkflow } from './kyc.workflow';

/** Workflow orchestration. Automatic retry is intentionally not wired (policy TBD). */
@Module({
  imports: [FlexcubeModule, ReisModule, PersistenceModule],
  providers: [{ provide: KYC_WORKFLOW, useClass: KycWorkflow }],
  exports: [KYC_WORKFLOW],
})
export class KycModule {}
