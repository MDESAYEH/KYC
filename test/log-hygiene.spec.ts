import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Operational data protection: runtime logs and error messages must never carry a KYC reference,
 * a REIS systemId, a FLEXCUBE customer number or any customer data. Correlation uses the internal
 * case id, a run id or counts. This scans the production sources (not the tests, not the CLI tools
 * an operator runs on purpose for one KYC).
 */
const SRC = join(__dirname, '..', 'src');
const FORBIDDEN =
  /\b(kycRefNo|systemId|customerNo|reisCustomerId|first_name|last_name|FIRST_NAME|LAST_NAME|nid|passport)\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'tools' ? [] : files(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** The text of every `logger.x(...)` call and every `super(...)` of an Error subclass. */
function calls(source: string, start: RegExp): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(start)) {
    let depth = 0;
    let i = (m.index ?? 0) + m[0].length - 1;
    const from = i;
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')' && --depth === 0) break;
    }
    out.push(source.slice(from, i + 1));
  }
  return out;
}

describe('log and error hygiene (no KYC identifiers or customer data)', () => {
  const sources = files(SRC).map((f) => ({ f, s: readFileSync(f, 'utf8') }));

  it('no logger call carries a KYC reference, a systemId, a customer number or customer data', () => {
    const offenders = sources.flatMap(({ f, s }) =>
      calls(s, /\blogger\.(log|warn|error|debug|verbose)\(/g)
        .filter((c) => FORBIDDEN.test(c))
        .map((c) => `${f}: ${c.slice(0, 120)}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no error message interpolates a KYC reference', () => {
    const offenders = sources.flatMap(({ f, s }) =>
      calls(s, /\bsuper\(/g)
        .filter((c) => /\$\{[^}]*(kycRefNo|systemId|customerNo)[^}]*\}/.test(c))
        .map((c) => `${f}: ${c.slice(0, 120)}`),
    );
    expect(offenders).toEqual([]);
  });
});
