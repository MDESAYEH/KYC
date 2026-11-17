import { DataSource } from 'typeorm';
import { LocalEvidence } from './staging-reconciliation';

/**
 * Evidence from the integration layer's OWN database (read-only SELECTs): has a case ever been
 * created for the KYC (the workflow persists it before calling REIS), did REIS ever call back for
 * it, and is the database used at all. If a query fails the error propagates: no evidence, no restore.
 */
export class SqliteLocalEvidence implements LocalEvidence {
  constructor(private readonly ds: DataSource) {}

  private async count(sql: string, params: unknown[]): Promise<number> {
    const rows = (await this.ds.query(sql, params)) as { n: number | string }[];
    return Number(rows[0]?.n ?? 0);
  }

  async hasCase(kycRefNo: string): Promise<boolean> {
    return (
      (await this.count(
        'SELECT COUNT(*) AS n FROM kyc_case WHERE kyc_ref_no = ? OR reis_system_id = ?',
        [kycRefNo, kycRefNo],
      )) > 0
    );
  }

  async hasWebhookEvent(kycRefNo: string): Promise<boolean> {
    return (
      (await this.count('SELECT COUNT(*) AS n FROM webhook_event WHERE system_id = ?', [
        kycRefNo,
      ])) > 0
    );
  }

  async summary(): Promise<{ caseCount: number; oldestCaseAt: string | null }> {
    const rows = (await this.ds.query(
      'SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM kyc_case',
    )) as { n: number | string; oldest: string | null }[];
    return {
      caseCount: Number(rows[0]?.n ?? 0),
      oldestCaseAt: rows[0]?.oldest ? String(rows[0].oldest) : null,
    };
  }
}
