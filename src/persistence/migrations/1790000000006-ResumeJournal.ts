import { MigrationInterface, QueryRunner } from 'typeorm';
import { RESUME_STATEMENTS } from '../../resume/resume-journal';

/** Local SQLite only. Oracle receipt DDL is a separately reviewed deployment artifact. */
export class ResumeJournal1790000000006 implements MigrationInterface {
  name = 'ResumeJournal1790000000006';
  async up(runner: QueryRunner): Promise<void> {
    for (const sql of RESUME_STATEMENTS) await runner.query(sql);
  }
  async down(): Promise<void> {
    throw Error('RESUME_JOURNAL_ROLLBACK_REFUSED_PRESERVE_RESERVATIONS_AND_EVIDENCE');
  }
}
