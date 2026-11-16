import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Initial local (SQLite) schema. The production database is still TBD; when it is chosen, add
 * a migration set for that engine rather than editing this one. Schema is never synchronized.
 */
export class InitialSchema1790000000000 implements MigrationInterface {
  name = 'InitialSchema1790000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'kyc_case',
        columns: [
          { name: 'internal_id', type: 'varchar', length: '36', isPrimary: true },
          { name: 'kyc_ref_no', type: 'varchar', length: '100', isNullable: false },
          { name: 'customer_no', type: 'varchar', length: '100', isNullable: true },
          { name: 'reis_system_id', type: 'varchar', length: '100', isNullable: false },
          { name: 'reis_customer_id', type: 'integer', isNullable: true },
          { name: 'risk_calculation_id', type: 'varchar', length: '100', isNullable: true },
          { name: 'reis_id', type: 'varchar', length: '100', isNullable: true },
          { name: 'customer_type', type: 'varchar', length: '20', isNullable: false },
          { name: 'internal_request_status', type: 'varchar', length: '40', isNullable: false },
          { name: 'reis_onboarding_status', type: 'varchar', length: '20', isNullable: true },
          { name: 'final_status', type: 'varchar', length: '20', isNullable: true },
          { name: 'final_status_at', type: 'datetime', isNullable: true },
          { name: 'final_status_received_count', type: 'integer', default: 0, isNullable: false },
          { name: 'conflicting_final_status', type: 'varchar', length: '20', isNullable: true },
          { name: 'retry_count', type: 'integer', default: 0, isNullable: false },
          { name: 'last_error_code', type: 'varchar', length: '100', isNullable: true },
          { name: 'last_error_message', type: 'varchar', length: '1000', isNullable: true },
          { name: 'created_at', type: 'datetime', default: "datetime('now')", isNullable: false },
          { name: 'updated_at', type: 'datetime', default: "datetime('now')", isNullable: false },
        ],
      }),
    );
    await queryRunner.createIndex(
      'kyc_case',
      new TableIndex({
        name: 'ux_kyc_case_kyc_ref_no',
        columnNames: ['kyc_ref_no'],
        isUnique: true,
      }),
    );
    await queryRunner.createIndex(
      'kyc_case',
      new TableIndex({
        name: 'ux_kyc_case_reis_system_id',
        columnNames: ['reis_system_id'],
        isUnique: true,
      }),
    );
    await queryRunner.createIndex(
      'kyc_case',
      new TableIndex({ name: 'ix_kyc_case_customer_no', columnNames: ['customer_no'] }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'reference_mapping',
        columns: [
          {
            name: 'id',
            type: 'integer',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'mapping_type', type: 'varchar', length: '50', isNullable: false },
          { name: 'flexcube_value', type: 'varchar', length: '200', isNullable: false },
          { name: 'reis_value', type: 'varchar', length: '200', isNullable: false },
          { name: 'description', type: 'varchar', length: '500', isNullable: true },
          { name: 'active', type: 'boolean', default: 1, isNullable: false },
          { name: 'created_at', type: 'datetime', default: "datetime('now')", isNullable: false },
          { name: 'updated_at', type: 'datetime', default: "datetime('now')", isNullable: false },
        ],
      }),
    );
    await queryRunner.createIndex(
      'reference_mapping',
      new TableIndex({
        name: 'ux_reference_mapping_type_value',
        columnNames: ['mapping_type', 'flexcube_value'],
        isUnique: true,
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('reference_mapping');
    await queryRunner.dropTable('kyc_case');
  }
}
