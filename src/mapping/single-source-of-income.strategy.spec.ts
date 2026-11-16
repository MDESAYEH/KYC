import { seededMappings } from '../../test/support/in-memory-reference-mappings';
import {
  MissingRequiredFieldError,
  SourceOfIncomeRuleNotConfiguredError,
} from '../canonical/transformation.errors';
import { UnmappedReferenceValueError } from './reference-mapping';
import { SingleSelectionSourceOfIncomeStrategy } from './single-source-of-income.strategy';

describe('SingleSelectionSourceOfIncomeStrategy (placeholder for the TBD Bank rule)', () => {
  const build = async () =>
    new SingleSelectionSourceOfIncomeStrategy((await seededMappings()).service);

  it('maps exactly one selected source through the SOURCE_OF_INCOME mapping', async () => {
    expect(await (await build()).toReisValue(['T-SALARY'])).toBe('R-SALARY');
  });

  it('does not guess when several sources are selected', async () => {
    const strategy = await build();
    for (const combo of [
      ['T-SALARY', 'T-RENTAL'],
      ['T-RENTAL', 'T-SALARY'],
      ['T-SALARY', 'T-SALARY', 'T-RENTAL'],
    ]) {
      const err = await strategy.toReisValue(combo).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceOfIncomeRuleNotConfiguredError);
      expect(err).toMatchObject({ kind: 'RULE_NOT_CONFIGURED', selectedCount: combo.length });
    }
  });

  it('fails when nothing is selected', async () => {
    await expect((await build()).toReisValue([])).rejects.toBeInstanceOf(MissingRequiredFieldError);
  });

  it('fails when the single source has no approved mapping', async () => {
    await expect((await build()).toReisValue(['T-UNKNOWN'])).rejects.toBeInstanceOf(
      UnmappedReferenceValueError,
    );
  });
});
