// psql dentro do contêiner `postgres` (sem cliente local nem dependência nova): o SQL vai pela
// entrada padrão, nunca pela linha de comando.
import type { Compose } from './compose.js';

export interface PsqlOptions {
  readonly database?: 'contrataflow' | 'authentik';
}

export interface PsqlResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export type Psql = (sql: string, options?: PsqlOptions) => Promise<PsqlResult>;

export function createPsql(compose: Compose): Psql {
  return async (sql, options = {}) => {
    const result = await compose.run(
      [
        'exec',
        '-T',
        'postgres',
        'psql',
        '-X',
        '-q',
        '-A',
        '-t',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
        '-d',
        options.database ?? 'contrataflow',
        '-f',
        '-',
      ],
      { input: sql },
    );
    return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };
}

/** Executa e exige sucesso; devolve a saída (formato `-A -t`: sem cabeçalho nem alinhamento). */
export async function query(psql: Psql, sql: string, options?: PsqlOptions): Promise<string> {
  const result = await psql(sql, options);
  if (!result.ok) throw new Error(`psql falhou: ${result.stderr || result.stdout}`);
  return result.stdout;
}
