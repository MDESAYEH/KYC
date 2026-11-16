import { MigrationInterface, QueryRunner, Table, TableColumn, TableIndex } from 'typeorm';

/**
 * Step 6: (1) track the FLEXCUBE update separately from the REIS final status, and (2) add the
 * /customerStatus callback audit table (no payloads, no secrets). Local SQLite schema; the
 * production database is still TBD.
 */
export class FlexcubeUpdateStateAndWebhookAudit1790000000002 implements MigrationInterface {
  name = 'FlexcubeUpdateStateAndWebhookAudit1790000000002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('kyc_case', [
      new TableColumn({
        name: 'flexcube_update_status',
        type: 'varchar',
        length: '20',
        isNullable: false,
        default: "'NOT_ATTEMPTED'",
      }),
      new TableColumn({
        name: 'flexcube_update_error_code',
        type: 'varchar',
        length: '100',
        isNullable: true,
      }),
      new TableColumn({
        name: 'flexcube_update_error_message',
        type: 'varchar',
        length: '1000',
        isNullable: true,
      }),
      new TableColumn({ name: 'flexcube_updated_at', type: 'datetime', isNullable: true }),
    ]);

    await queryRunner.createTable(
      new Table({
        name: 'webhook_event',
        columns: [
          { name: 'event_id', type: 'varchar', length: '36', isPrimary: true },
          { name: 'received_at', type: 'datetime', isNullable: false },
          { name: 'system_id', type: 'varchar', length: '100', isNullable: true },
          { name: 'incoming_status', type: 'varchar', length: '50', isNullable: true },
          { name: 'incoming_customer_id', type: 'integer', isNullable: true },
          { name: 'system_name', type: 'varchar', length: '100', isNullable: true },
          { name: 'service_type', type: 'varchar', length: '100', isNullable: true },
          { name: 'processing_result', type: 'varchar', length: '30', isNullable: false },
          { name: 'detail_code', type: 'varchar', length: '100', isNullable: true },
          { name: 'kyc_case_internal_id', type: 'varchar', length: '36', isNullable: true },
          { name: 'processed_at', type: 'datetime', isNullable: true },
        ],
      }),
    );
    await queryRunner.createIndex(
      'webhook_event',
      new TableIndex({ name: 'ix_webhook_event_system_id', columnNames: ['system_id'] }),
    );
    await queryRunner.createIndex(
      'webhook_event',
      new TableIndex({ name: 'ix_webhook_event_case', columnNames: ['kyc_case_internal_id'] }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('webhook_event');
    await queryRunner.dropColumns('kyc_case', [
      'flexcube_update_status',
      'flexcube_update_error_code',
      'flexcube_update_error_message',
      'flexcube_updated_at',
    ]);
  }
}
