/**
 * Command-line tools (migrations, mappings seed, UAT check) load `.env` from the current folder
 * like the application does. Variables already set in the environment win; a missing file is fine.
 */
export function loadEnvFile(path = '.env'): void {
  try {
    (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(path);
  } catch {
    // no .env file: rely on the real environment
  }
}
