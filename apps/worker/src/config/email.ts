import { z } from 'zod';

/*
 * E-mail transacional do worker (US-112 · DEC-050 · queues.md §4.3): `EMAIL_TRANSPORT` (`smtp` —
 * Mailpit em dev; a interface SMTP do Amazon SES em produção), `SMTP_URL` (`smtp://` ou `smtps://`,
 * credenciais na própria URL — segredo), `EMAIL_FROM` (remetente autenticado no domínio do produto,
 * SPF/DKIM/DMARC), `APP_BASE_URL` (base dos links dos e-mails) e `EMAIL_RATE_PER_SECOND` (cota do
 * provedor, padrão 10/s — RN-NTF-21, de plataforma, não por tenant).
 */

const OPTIONAL_ENVS: ReadonlySet<string> = new Set(['local', 'dev', 'test']);

const present = (value: string | undefined) =>
  value === undefined || value.trim() === '' ? undefined : value;

const schema = z.object({
  EMAIL_TRANSPORT: z.enum(['smtp']).default('smtp'),
  SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
  EMAIL_FROM: z.string().regex(/@/).optional(),
  APP_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  EMAIL_RATE_PER_SECOND: z.coerce.number().int().min(1).max(1_000).default(10),
});

export interface EmailRuntimeConfig {
  readonly transport: 'smtp';
  readonly smtpUrl: string;
  readonly from: string;
  readonly appBaseUrl: string;
  readonly ratePerSecond: number;
}

export class EmailConfigError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`Configuração de e-mail inválida: ${keys.join(', ')}`);
    this.name = 'EmailConfigError';
  }
}

/** Base local dos links quando `APP_BASE_URL` não está definida (só em `local`/`dev`/`test`). */
const LOCAL_BASE_URL = 'http://localhost:3000';

/**
 * `null` = envio de e-mail desligado (permitido só quando `optional` — `local`/`dev`/`test` sem
 * `SMTP_URL`); os jobs ficam na fila até o worker com e-mail subir.
 */
export function loadEmailConfig(
  env: Readonly<Record<string, string | undefined>>,
  optional: boolean,
): EmailRuntimeConfig | null {
  const parsed = schema.safeParse({
    EMAIL_TRANSPORT: present(env.EMAIL_TRANSPORT),
    SMTP_URL: present(env.SMTP_URL),
    EMAIL_FROM: present(env.EMAIL_FROM),
    APP_BASE_URL: present(env.APP_BASE_URL),
    EMAIL_RATE_PER_SECOND: present(env.EMAIL_RATE_PER_SECOND),
  });
  if (!parsed.success) {
    throw new EmailConfigError([...new Set(parsed.error.issues.map((i) => String(i.path[0])))]);
  }
  const data = parsed.data;
  if (!data.SMTP_URL) {
    if (optional) return null;
    throw new EmailConfigError(['SMTP_URL']);
  }
  const missing = [
    ...(data.EMAIL_FROM ? [] : ['EMAIL_FROM']),
    ...(data.APP_BASE_URL || optional ? [] : ['APP_BASE_URL']),
  ];
  if (missing.length > 0 || !data.EMAIL_FROM) throw new EmailConfigError(missing);
  return {
    transport: data.EMAIL_TRANSPORT,
    smtpUrl: data.SMTP_URL,
    from: data.EMAIL_FROM,
    appBaseUrl: data.APP_BASE_URL ?? LOCAL_BASE_URL,
    ratePerSecond: data.EMAIL_RATE_PER_SECOND,
  };
}

/** Pelo `APP_ENV` do processo: fora de `local`/`dev`/`test`, o e-mail é obrigatório. */
export function loadEmailConfigFromProcess(appEnv: string): EmailRuntimeConfig | null {
  return loadEmailConfig(process.env, OPTIONAL_ENVS.has(appEnv));
}
