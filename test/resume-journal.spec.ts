import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ResumeJournal, RESUME_SCHEMA } from '../src/resume/resume-journal';
import { trialHash } from '../src/tools/single-kyc-trial.contract';

describe('durable append-only resume journal (real file-backed SQLite)', () => {
  let dir: string, path: string, db: Database.Database, journal: ResumeJournal;
  const history = [1, 2].map((n) => ({
    id: `attempt-${n}`,
    evidence: { original: n },
    evidenceSha256: trialHash({ original: n }),
  }));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kyc-resume-'));
    path = join(dir, 'journal.sqlite');
    db = new Database(path);
    db.exec(RESUME_SCHEMA);
    db.exec('CREATE TABLE webhook_event (event_id TEXT PRIMARY KEY, system_id TEXT)');
    journal = new ResumeJournal(db);
  });
  afterEach(() => {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('imports both attempts byte for byte, reserves once and survives reopen', () => {
    journal.reserve('new-attempt', 'plan-hash', history, { protected: 'before' }, () => undefined);
    const original = db.prepare('SELECT * FROM kyc_resume_attempt ORDER BY attempt_id').all();
    db.close();
    db = new Database(path);
    journal = new ResumeJournal(db);
    expect(() =>
      journal.reserve('second-resume', 'another-plan', history, {}, () => undefined),
    ).toThrow();
    expect(db.prepare('SELECT * FROM kyc_resume_attempt ORDER BY attempt_id').all()).toEqual(
      original,
    );
    expect(journal.hasReservation()).toBe(true);
  });
  it('cannot UPDATE/DELETE attempts, events or permanent reservation with SQL', () => {
    journal.reserve('new-attempt', 'plan-hash', history, {}, () => undefined);
    for (const table of ['kyc_resume_attempt', 'kyc_resume_event', 'kyc_resume_reservation']) {
      expect(() => db.exec(`DELETE FROM ${table}`)).toThrow('append-only');
      expect(() => db.exec(`UPDATE ${table} SET rowid = rowid`)).toThrow('append-only');
    }
  });
  it('atomically rolls back history and reservation when evidence validation fails', () => {
    expect(() =>
      journal.reserve('new-attempt', 'plan-hash', history, {}, () => {
        throw Error('evidence failed');
      }),
    ).toThrow('evidence failed');
    expect(journal.hasReservation()).toBe(false);
    expect(db.prepare('SELECT * FROM kyc_resume_attempt').all()).toHaveLength(0);
  });
  it('a second real connection cannot reserve concurrently', () => {
    const second = new Database(path, { timeout: 0 });
    try {
      db.exec('BEGIN IMMEDIATE');
      expect(() =>
        new ResumeJournal(second).reserve('other', 'hash', history, {}, () => undefined),
      ).toThrow();
      db.exec('ROLLBACK');
      journal.reserve('winner', 'hash', history, {}, () => undefined);
      expect(() =>
        new ResumeJournal(second).reserve('loser', 'hash', history, {}, () => undefined),
      ).toThrow();
    } finally {
      second.close();
    }
  });
  it('callback audit before reservation or dispatch is a durable fence', () => {
    journal.reserve('new-attempt', 'plan-hash', history, {}, () => undefined);
    db.prepare('INSERT INTO webhook_event VALUES (?, ?)').run('callback-one', '00005804');
    expect(() => journal.dispatchIntent('new-attempt')).toThrow('CALLBACK');
    expect(journal.event('new-attempt', 'DISPATCH_INTENT')).toBeNull();
  });
  it('a dispatch intent cannot be consumed twice, including after restart', () => {
    journal.reserve('new-attempt', 'plan-hash', history, {}, () => undefined);
    journal.dispatchIntent('new-attempt');
    db.close();
    db = new Database(path);
    journal = new ResumeJournal(db);
    expect(() => journal.dispatchIntent('new-attempt')).toThrow();
  });
  it('two actual workers racing the same permanent key have exactly one winner', async () => {
    const code = `
      const {parentPort,workerData}=require('node:worker_threads');
      const Database=require(workerData.modulePath);
      const db=new Database(workerData.path,{timeout:5000});
      parentPort.once('message',()=>{
        try {
          db.transaction(()=>{
            db.prepare('INSERT INTO kyc_resume_attempt VALUES (?,?,?,?,?,?)').run(workerData.id,workerData.scope,'RESUME','{}','synthetic','synthetic');
            db.prepare('INSERT INTO kyc_resume_reservation VALUES (?,?,?,?)').run(workerData.scope,workerData.id,'synthetic','synthetic');
          }).immediate();
          parentPort.postMessage('WON');
        } catch(e) {parentPort.postMessage(e.code);}
        finally {db.close();parentPort.close();}
      });
      parentPort.postMessage('READY');
    `;
    const workers = ['worker-one', 'worker-two'].map(
      (id) =>
        new Worker(code, {
          eval: true,
          workerData: {
            id,
            path,
            modulePath: require.resolve('better-sqlite3'),
            scope: '00005804:001ZKYC26151003Y:1',
          },
        }),
    );
    try {
      await Promise.all(
        workers.map(
          (w) =>
            new Promise<void>((resolve, reject) => {
              w.once('message', () => resolve());
              w.once('error', reject);
            }),
        ),
      );
      const results = workers.map(
        (w) =>
          new Promise<string>((resolve, reject) => {
            w.once('message', resolve);
            w.once('error', reject);
          }),
      );
      workers.forEach((w) => w.postMessage('GO'));
      expect((await Promise.all(results)).sort()).toEqual(
        ['SQLITE_CONSTRAINT_PRIMARYKEY', 'WON'].sort(),
      );
      expect(journal.hasReservation()).toBe(true);
    } finally {
      await Promise.all(workers.map((w) => w.terminate()));
    }
  });
  it('detects corrupted evidence even if a privileged actor bypassed an SQL guard', () => {
    journal.reserve('new-attempt', 'hash', history, {}, () => undefined);
    db.exec('DROP TRIGGER kyc_resume_event_update');
    db.prepare("UPDATE kyc_resume_event SET body_json='{}'").run();
    expect(() => journal.dispatchIntent('new-attempt')).toThrow('INTEGRITY');
  });
});
