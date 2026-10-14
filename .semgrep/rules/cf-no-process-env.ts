// Casos de teste da regra (semgrep --test .semgrep/rules).
declare const config: { databaseUrl: string };

export function connect() {
  // ruleid: cf-no-process-env
  const url = process.env.DATABASE_URL;
  // ok: cf-no-process-env
  const fromConfig = config.databaseUrl;
  return [url, fromConfig];
}
