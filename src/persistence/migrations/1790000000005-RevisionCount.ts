import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * B5: how many revisions (staging SEQ_NO) of this identity have ever been sent under the same REIS systemId.
 * The REIS callback carries no revision, so a late callback of revision N cannot be told from a callback of
 * revision N+1. A case whose count is 1 has exactly one possible origin; a higher count is ambiguous and its
 * callbacks are quarantined (see applyFinalStatus).
 *
 * Existing rows are back-filled CONSERVATIVELY with seq_no: every earlier modification is assumed to have been
 * sent, so a historical case that was amended is never treated as unambiguous.
 */
export class RevisionCount1790000000005 implements MigrationInterface {
  name = 'RevisionCount1790000000005';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'kyc_case',
      new TableColumn({ name: 'revision_count', type: 'integer', isNullable: false, default: 1 }),
    );
    await queryRunner.query('UPDATE kyc_case SET revision_count = seq_no WHERE seq_no > 1');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('kyc_case', 'revision_count');
  }
}
