import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static guard: no logger call in the application code may mention a KYC reference, a REIS system id
 * or a customer field. Runtime tests (sync, workflow) check the actual output too; this catches a new
 * log line before it runs. Logs carry technical ids (runId, internalId, correlationId, eventId) only.
 */
const FORBIDDEN =
  /\b(kycRefNo|KYC_REF_NO|systemId|reisSystemId|customerNo|CUSTOMER_NO|FIRST_NAME|LAST_NAME|firstName|lastName|accountManagerEmail|ACCOUNT_MANAGER_EMAIL)\b/;
const LOG_CALL = /\blogger\.(log|warn|error|debug|verbose|fatal)\(/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

/** The text of the call starting at `open` (index of the opening parenthesis), by paren depth. */
function callText(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

describe('no customer identifiers in log calls', () => {
  const files = sources(join(__dirname, '..'));

  it('the guard really detects an identifier inside a (multi-line) logger call', () => {
    const bad = "x(); this.logger.warn({\n  event: 'e',\n  kycRefNo: c.kycRefNo,\n}); y();";
    const open = bad.indexOf('logger.warn(') + 'logger.warn('.length - 1;
    expect(callText(bad, open)).toMatch(FORBIDDEN);
    const good = "this.logger.warn({ event: 'e', runId }); const kycRefNo = 1;";
    expect(callText(good, good.indexOf('(', 12))).not.toMatch(FORBIDDEN);
  });

  it('finds the application sources and some logger calls', () => {
    expect(files.length).toBeGreaterThan(20);
    const calls = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(LOG_CALL)]);
    expect(calls.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [f.slice(f.indexOf('src')).replace(/\\/g, '/'), f]))(
    '%s',
    (_name, file) => {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(LOG_CALL)) {
        const text = callText(src, (m.index ?? 0) + m[0].length - 1);
        expect(text).not.toMatch(FORBIDDEN);
      }
    },
  );
});
