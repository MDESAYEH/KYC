import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module';
import { REFERENCE_MAPPING_SERVICE, SOURCE_OF_INCOME_STRATEGY } from './mapping.interfaces';
import { ReferenceMappingService } from './reference-mapping.service';
import { SingleSelectionSourceOfIncomeStrategy } from './single-source-of-income.strategy';

/** Reference/code mapping service backed by the configurable mapping table. */
@Module({
  imports: [PersistenceModule],
  providers: [
    { provide: REFERENCE_MAPPING_SERVICE, useClass: ReferenceMappingService },
    // Placeholder: the multi-checkbox Source-of-Income rule is TBD.
    { provide: SOURCE_OF_INCOME_STRATEGY, useClass: SingleSelectionSourceOfIncomeStrategy },
  ],
  exports: [REFERENCE_MAPPING_SERVICE, SOURCE_OF_INCOME_STRATEGY],
})
export class MappingModule {}
