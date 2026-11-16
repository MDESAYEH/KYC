import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Step 8: FLEXCUBE submission sequence (STTM_KYC_REIS_PAYLOAD_CUSTOM.SEQ_NO). Every amendment of
 * a KYC is a new submission with a higher SEQ_NO, sent to REIS again with the same systemId
 * (Reis 03/11/2026: treated as an update). The case keeps the latest SEQ_NO; the full history of
 * each submission (request / response) lives in the FLEXCUBE staging table.
 */
export class SubmissionSeqNo1790000000004 implements MigrationInterface {
  name = 'SubmissionSeqNo1790000000004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'kyc_case',
      new TableColumn({ name: 'seq_no', type: 'integer', isNullable: false, default: 1 }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('kyc_case', 'seq_no');
  }
}
