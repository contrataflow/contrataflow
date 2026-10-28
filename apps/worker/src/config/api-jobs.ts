import { ConfigValidationError, loadJobsConfig } from '@contrataflow/api/jobs';
import type { AppConfig } from '@contrataflow/api/jobs';

/*
 * Jobs dos módulos da API consumidos pelo worker (DEC-052 · `@contrataflow/api/jobs`): o mesmo
 * `.env` da API, validado pelo schema dela no modo "jobs" (sem as variáveis só de HTTP). Liga com
 * `DATABASE_URL` (papel `cf_app`, a `TenantTransaction` da API); fora de `local`/`dev`/`test` é
 * obrigatória. Gotenberg, S3 e ClamAV ausentes pausam só as filas que dependem deles.
 */

const OPTIONAL_ENVS: ReadonlySet<string> = new Set(['local', 'dev', 'test']);

export class ApiJobsConfigError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`Configuração dos jobs da API inválida: ${keys.join(', ')}`);
    this.name = 'ApiJobsConfigError';
  }
}

const present = (value: string | undefined) =>
  value === undefined || value.trim() === '' ? undefined : value;

/** `null` = jobs da API desligados (só em `local`/`dev`/`test`, sem `DATABASE_URL`). */
export function loadApiJobsConfig(
  env: Readonly<Record<string, string | undefined>>,
): AppConfig | null {
  if (!present(env.DATABASE_URL)) {
    if (OPTIONAL_ENVS.has(present(env.APP_ENV) ?? 'local')) return null;
    throw new ApiJobsConfigError(['DATABASE_URL']);
  }
  try {
    return loadJobsConfig(env);
  } catch (error) {
    if (error instanceof ConfigValidationError) throw new ApiJobsConfigError(error.keys);
    throw error;
  }
}

export function loadApiJobsConfigFromProcess(): AppConfig | null {
  return loadApiJobsConfig(process.env);
}
