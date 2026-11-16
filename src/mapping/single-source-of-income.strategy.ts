import { Inject, Injectable } from '@nestjs/common';
import {
  MissingRequiredFieldError,
  SourceOfIncomeRuleNotConfiguredError,
} from '../canonical/transformation.errors';
import {
  IReferenceMappingService,
  ISourceOfIncomeStrategy,
  REFERENCE_MAPPING_SERVICE,
} from './mapping.interfaces';
import { ReferenceMappingType } from './reference-mapping';

/**
 * Deliberate placeholder for the Source-of-Income rule, which the Bank has NOT decided.
 *  - exactly one checkbox selected: its FLEXCUBE value is translated through the SOURCE_OF_INCOME
 *    reference mapping (a plain per-value mapping, PROVISIONAL);
 *  - none selected: required input missing -> MissingRequiredFieldError;
 *  - two or more: SourceOfIncomeRuleNotConfiguredError. Nothing is combined, ordered, or picked.
 * Replace this binding when the Bank defines the aggregation rule.
 */
@Injectable()
export class SingleSelectionSourceOfIncomeStrategy implements ISourceOfIncomeStrategy {
  constructor(
    @Inject(REFERENCE_MAPPING_SERVICE) private readonly mappings: IReferenceMappingService,
  ) {}

  async toReisValue(selectedSources: string[]): Promise<string> {
    if (selectedSources.length === 0) {
      throw new MissingRequiredFieldError('source_income_individual');
    }
    if (selectedSources.length > 1) {
      throw new SourceOfIncomeRuleNotConfiguredError(selectedSources.length);
    }
    return this.mappings.resolve(ReferenceMappingType.SOURCE_OF_INCOME, selectedSources[0]);
  }
}
