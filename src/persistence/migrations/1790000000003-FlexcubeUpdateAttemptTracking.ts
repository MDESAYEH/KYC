import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Step 7: technical bookkeeping for FLEXCUBE update attempts (first automatic attempt after the
 * REIS callback and any operator-triggered recovery). Counters and timestamps only - no payloads,
 * tokens or credentials. Local SQLite schema; the production database is still TBD.
 */
export class FlexcubeUpdateAttemptTracking1790000000003 implements MigrationInterface {
  name = 'FlexcubeUpdateAttemptTracking1790000000003';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('kyc_case', [
      new TableColumn({
        name: 'flexcube_update_attempt_count',
        type: 'integer',
        isNullable: false,
        default: 0,
      }),
      new TableColumn({ name: 'flexcube_last_attempt_at', type: 'datetime', isNullable: true }),
    ]);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumns('kyc_case', [
      'flexcube_update_attempt_count',
      'flexcube_last_attempt_at',
    ]);
  }
}
