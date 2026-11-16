import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Stores the REIS onboarding response text (`instruction`, `errorMessage`) on the KYC case.
 * The values may be sensitive: they are persisted on purpose but must never be logged or placed
 * in exception messages. Nullable; sized for typical VARCHAR limits (truncated at 4000 chars).
 */
export class AddReisResponseText1790000000001 implements MigrationInterface {
  name = 'AddReisResponseText1790000000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('kyc_case', [
      new TableColumn({
        name: 'reis_instruction',
        type: 'varchar',
        length: '4000',
        isNullable: true,
      }),
      new TableColumn({
        name: 'reis_error_message',
        type: 'varchar',
        length: '4000',
        isNullable: true,
      }),
    ]);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumns('kyc_case', ['reis_instruction', 'reis_error_message']);
  }
}
