import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Anything that disables or weakens TLS certificate validation. */
const FORBIDDEN = [/rejectUnauthorized/i, /strictSSL/i, /NODE_TLS_REJECT_UNAUTHORIZED/i];

export function findTlsDisableMechanisms(text: string): string[] {
  return FORBIDDEN.filter((re) => re.test(text)).map((re) => re.source);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

describe('TLS safety scan', () => {
  const root = join(__dirname, '..');

  it('detects the forbidden mechanisms (the scanner itself works)', () => {
    expect(findTlsDisableMechanisms('new Agent({ rejectUnauthorized: false })')).toHaveLength(1);
    expect(findTlsDisableMechanisms('request({ strictSSL: false })')).toHaveLength(1);
    expect(findTlsDisableMechanisms('process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"')).toHaveLength(
      1,
    );
    expect(findTlsDisableMechanisms('const x = 1;')).toEqual([]);
  });

  it('finds production source files to scan', () => {
    expect(sourceFiles(join(root, 'src')).length).toBeGreaterThan(20);
  });

  it('production source contains no TLS-disable mechanism', () => {
    const offenders = sourceFiles(join(root, 'src'))
      .map((f) => ({
        file: relative(root, f),
        hits: findTlsDisableMechanisms(readFileSync(f, 'utf8')),
      }))
      .filter((r) => r.hits.length > 0);
    expect(offenders).toEqual([]);
  });

  it('package scripts and the env example do not disable TLS validation', () => {
    for (const file of ['package.json', '.env.example']) {
      expect({
        file,
        hits: findTlsDisableMechanisms(readFileSync(join(root, file), 'utf8')),
      }).toEqual({
        file,
        hits: [],
      });
    }
  });

  it('the HTTP transport installs no custom TLS agent', () => {
    const transport = readFileSync(join(root, 'src/reis/transport/reis-http.transport.ts'), 'utf8');
    expect(transport).not.toMatch(/httpsAgent|https\.Agent|new Agent\(/);
  });
});
