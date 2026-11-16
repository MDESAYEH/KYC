import {
  IFlexcubeSqlExecutor,
  SqlBinds,
  SqlRow,
} from '../../src/flexcube/staging/flexcube-staging';

export interface FakeStagingRow {
  KYC_REF_NO: string;
  SEQ_NO: number;
  REIS_FINAL_STATUS: string | null;
}

/**
 * In-memory stand-in for STTM_KYC_REIS_PAYLOAD_CUSTOM honouring the REIS_FINAL_STATUS UPDATE of
 * StagingFlexcubeStatusUpdater (latest SEQ_NO, never overwrite a different status).
 * `down = true` simulates the FLEXCUBE database being unreachable.
 */
export class FakeStagingDb implements IFlexcubeSqlExecutor {
  rows: FakeStagingRow[] = [];
  finalStatusWrites = 0;
  down = false;

  addSubmission(kycRefNo: string, seqNo = 1): void {
    this.rows.push({ KYC_REF_NO: kycRefNo, SEQ_NO: seqNo, REIS_FINAL_STATUS: null });
  }

  finalStatusOf(kycRefNo: string): string | null | undefined {
    const mine = this.rows.filter((r) => r.KYC_REF_NO === kycRefNo);
    const max = Math.max(...mine.map((r) => r.SEQ_NO));
    return mine.find((r) => r.SEQ_NO === max)?.REIS_FINAL_STATUS;
  }

  async execute(sql: string, b: SqlBinds): Promise<{ rowsAffected: number }> {
    if (this.down) throw new Error('ORA-12541: TNS:no listener');
    if (!sql.includes('SET REIS_FINAL_STATUS')) throw new Error(`unexpected SQL: ${sql}`);
    const mine = this.rows.filter((r) => r.KYC_REF_NO === b.kycRefNo);
    const max = Math.max(...mine.map((r) => r.SEQ_NO));
    let rowsAffected = 0;
    for (const r of mine) {
      if (r.SEQ_NO === max && (r.REIS_FINAL_STATUS === null || r.REIS_FINAL_STATUS === b.status)) {
        r.REIS_FINAL_STATUS = String(b.status);
        rowsAffected++;
      }
    }
    this.finalStatusWrites += rowsAffected;
    return { rowsAffected };
  }

  async query(): Promise<SqlRow[]> {
    return [];
  }
}
