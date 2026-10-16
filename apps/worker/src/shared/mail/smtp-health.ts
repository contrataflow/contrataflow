import type { HealthCheck } from '@contrataflow/observability';
import { createTransport } from 'nodemailer';

import { smtpPoolOptions } from './smtp-mail-provider.js';

/** Validade do último resultado da verificação SMTP (observability.md §6.2: cache de 60 s). */
export const SMTP_HEALTH_CACHE_MS = 60_000;

/**
 * SMTP/SES no `/health/ready` do worker (US-085 · observability.md §6.2): DEGRADÁVEL — com o
 * provedor fora os e-mails ficam `PENDING` e a fila os reenvia. Conexão + `EHLO`/autenticação
 * (`verify`), com o resultado guardado por 60 s para não abrir sessão SMTP a cada *probe*.
 */
export function smtpHealthCheck(
  url: string,
  timeoutMs: number,
  now: () => number = Date.now,
  verify: () => Promise<unknown> = () =>
    createTransport({
      ...smtpPoolOptions({ url, connectionTimeoutMs: timeoutMs, socketTimeoutMs: timeoutMs }),
      pool: false,
    }).verify(),
): HealthCheck {
  let last: { readonly ok: boolean; readonly at: number } | null = null;
  return {
    name: 'smtp',
    measurement: 'connection',
    criticality: 'degradable',
    timeoutMs,
    probe: async () => {
      if (!last || now() - last.at >= SMTP_HEALTH_CACHE_MS) {
        const ok = await verify().then(
          () => true,
          () => false,
        );
        last = { ok, at: now() };
      }
      return last.ok ? undefined : { status: 'fail', output: 'unavailable' };
    },
  };
}
